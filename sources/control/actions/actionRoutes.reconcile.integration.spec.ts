/**
 * reconcile endpoint — REAL Postgres integration test.
 * (Phase 5C / 5D-prerequisite "C" #14 — route/DB-level lock for the CAS-first ordering fix)
 *
 * actionRoutes.reconcile.spec.ts is a SIMULATION (it re-implements the endpoint logic),
 * so it proves the simulator's ordering, not the production route's. This test runs the
 * REAL reconcile route against a REAL Postgres DB to pin the evidence-ordering invariant
 * that the orphan-row fix (#14, CAS before INSERT) depends on:
 *
 *   1. happy path: fired action -> 200 needs_human, exactly 1 ControlActionReconciliation row
 *   2. terminal action -> 409, ZERO ControlActionReconciliation rows (no orphan evidence)
 *   3. needs_human action -> different evidence_id appends an audit row (count grows)
 *   4. same (action_id, evidence_id) -> idempotent 200, no duplicate row
 *
 * ── Running ────────────────────────────────────────────────────────────────────
 * Requires a real Postgres test DB. NOT part of `npm test` (excluded in vitest.config.ts).
 *   1. npm run test:db:setup
 *   2. npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { actionRoutes } from './actionRoutes';

// All entity ids must be valid UUIDs: publishControlEvent casts workroom_id::uuid
// in raw SQL, so non-UUID ids would fail the cast.
const ORG_ID = randomUUID();
const AGENT_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const SESSION_ID = randomUUID();
const MACHINE_ID = randomUUID();
const MACHINE_RAW_TOKEN = `machine_raw_${randomUUID()}`;
const VALID_REASON = 'fire_response_lost_token_unrecoverable';

let app: FastifyInstance;

function sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

/**
 * Seed an action + its action_token (machineId = the firing machine, so the
 * firing-machine guard passes).
 */
async function seedActionWithToken(status: string): Promise<string> {
    const actionId = randomUUID();
    await db.controlAction.create({
        data: {
            id: actionId,
            sessionId: SESSION_ID,
            workroomId: WORKROOM_ID,
            actorAgentId: AGENT_ID,
            kind: 'deploy',
            summary: 'integration reconcile test action',
            reversibility: 'irreversible_no_abort',
            riskLevel: 'high',
            requiresApproval: true, // DB CHECK: irreversible_no_abort requires approval
            status,
            clientIdempotencyKey: `idem-${randomUUID()}`,
        },
    });
    await db.controlActionToken.create({
        data: {
            id: randomUUID(),
            actionId,
            tokenHash: sha256(`act_tok_${randomUUID()}`), // value irrelevant; reconcile only reads machineId
            sessionId: SESSION_ID,
            workroomId: WORKROOM_ID,
            machineId: MACHINE_ID, // firing machine == authenticated machine
            expiresAt: new Date(Date.now() + 5 * 60_000),
        },
    });
    return actionId;
}

async function reconcile(actionId: string, evidenceId: string) {
    return app.inject({
        method: 'POST',
        url: `/api/v1/actions/${actionId}/reconcile`,
        headers: { authorization: `Bearer ${MACHINE_RAW_TOKEN}`, 'content-type': 'application/json' },
        payload: { reason: VALID_REASON, evidence_id: evidenceId },
    });
}

async function evidenceCount(actionId: string): Promise<number> {
    return db.controlActionReconciliation.count({ where: { actionId } });
}

beforeAll(async () => {
    app = fastify();
    await app.register(actionRoutes);
    await app.ready();

    await db.controlOrg.create({
        data: { id: ORG_ID, name: 'Reconcile Org', slug: `rec-${randomUUID()}`, ownerUserId: randomUUID() },
    });
    // Machine bound to ORG, with a real token hash so verifyMachineToken resolves it.
    await db.controlMachine.create({
        data: {
            id: MACHINE_ID,
            orgId: ORG_ID,
            tokenHash: sha256(MACHINE_RAW_TOKEN),
            tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
            platform: 'darwin',
            arch: 'arm64',
        },
    });
    await db.controlAgent.create({
        data: { id: AGENT_ID, orgId: ORG_ID, name: 'rec-agent', displayName: 'Rec Agent', role: 'ops' },
    });
    await db.controlWorkroom.create({
        data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Reconcile Workroom', createdBy: randomUUID() },
    });
    await db.controlSession.create({
        data: {
            id: SESSION_ID,
            orgId: ORG_ID,
            workroomId: WORKROOM_ID,
            machineId: MACHINE_ID,
            mode: 'daemon',
            runtime: 'claude',
            displayName: 'rec-session',
        },
    });
});

afterAll(async () => {
    await db.controlActionReconciliation.deleteMany({ where: { action: { workroomId: WORKROOM_ID } } });
    await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlActionToken.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlAction.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
    await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
    await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
    await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
    await app.close();
    await db.$disconnect();
});

describe('reconcile endpoint — real DB evidence-ordering invariant (integration)', () => {
    it('happy path: fired -> 200 needs_human, exactly 1 evidence row', async () => {
        const actionId = await seedActionWithToken('fired');

        const res = await reconcile(actionId, `ev-${randomUUID()}`);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).status).toBe('needs_human');

        // Action transitioned in the real DB.
        const action = await db.controlAction.findUnique({ where: { id: actionId }, select: { status: true } });
        expect(action?.status).toBe('needs_human');

        // Exactly one evidence row.
        expect(await evidenceCount(actionId)).toBe(1);
    });

    it('terminal action -> 409 and ZERO evidence rows (no orphan; #14 invariant)', async () => {
        const actionId = await seedActionWithToken('succeeded'); // hard terminal

        const res = await reconcile(actionId, `ev-${randomUUID()}`);

        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body).error.code).toBe('RECONCILE_TERMINAL_CONFLICT');

        // The orphan-row bug: a terminal action must NEVER get an evidence row.
        expect(await evidenceCount(actionId)).toBe(0);

        // Terminal status untouched.
        const action = await db.controlAction.findUnique({ where: { id: actionId }, select: { status: true } });
        expect(action?.status).toBe('succeeded');
    });

    it('needs_human action -> different evidence_id appends an audit row', async () => {
        const actionId = await seedActionWithToken('needs_human');

        const r1 = await reconcile(actionId, `ev-A-${randomUUID()}`);
        expect(r1.statusCode).toBe(200);
        expect(await evidenceCount(actionId)).toBe(1);

        const r2 = await reconcile(actionId, `ev-B-${randomUUID()}`);
        expect(r2.statusCode).toBe(200);
        // Audit trail grows: a second distinct evidence row is appended.
        expect(await evidenceCount(actionId)).toBe(2);
    });

    it('same (action_id, evidence_id) -> idempotent 200, no duplicate row', async () => {
        const actionId = await seedActionWithToken('needs_human');
        const sharedEvidence = `ev-dup-${randomUUID()}`;

        const first = await reconcile(actionId, sharedEvidence);
        expect(first.statusCode).toBe(200);
        expect(await evidenceCount(actionId)).toBe(1);

        // Re-report the SAME evidence_id — must be idempotent, not a second row.
        const second = await reconcile(actionId, sharedEvidence);
        expect(second.statusCode).toBe(200);
        expect(JSON.parse(second.body).idempotent).toBe(true);
        expect(await evidenceCount(actionId)).toBe(1);
    });
});
