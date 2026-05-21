/**
 * action_token consume — REAL Postgres integration test.
 * (Phase 5C / 5D-prerequisite "A", task #12)
 *
 * Unlike actionRoutes.token.spec.ts (which MOCKS @/storage/db and can only simulate
 * the one-time CAS sequentially), this test runs the consume endpoint against a REAL
 * Postgres database to prove the atomic semantics the mock cannot faithfully cover:
 *
 *   1. consumed_at transitions null -> timestamp on first consume
 *      (the one-time CAS truly fires at the DB level).
 *   2. second consume with the same token -> 403 TOKEN_NOT_CONSUMABLE and
 *      consumed_at is UNCHANGED (DB-level atomic rejection; closes the 5B gap where
 *      the mock test could only fake the second-consume rejection).
 *   3. expired token -> 403, consumed_at stays null.
 *   4. wrong action id -> 403, the real token's consumed_at stays null (scope binding).
 *
 * ── Running ────────────────────────────────────────────────────────────────────
 * Requires a real Postgres test DB. NOT part of `npm test` (excluded in vitest.config.ts).
 *   1. npm run test:db:setup        # provision codelight_test + sync schema
 *   2. npm run test:integration     # run this file against it
 * The setup guard (vitest.integration.setup.ts) refuses to run unless DATABASE_URL's
 * database name contains "test".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { actionRoutes } from './actionRoutes';

// ── Shared seed graph (one org/agent/workroom/session for all tests) ────────────

const ORG_ID = `org-int-${randomUUID()}`;
const AGENT_ID = `agent-int-${randomUUID()}`;
const WORKROOM_ID = `wroom-int-${randomUUID()}`;
const SESSION_ID = `sess-int-${randomUUID()}`;
const MACHINE_ID = `machine-int-${randomUUID()}`;

let app: FastifyInstance;

/** Hash a raw action_token the same way the consume endpoint does. */
function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * Seed a fired action + its action_token row in the real DB.
 * Returns the action id and the RAW token (only place the raw token exists).
 */
async function seedActionWithToken(opts: {
    expiresAt: Date;
    consumedAt?: Date | null;
}): Promise<{ actionId: string; rawToken: string }> {
    const actionId = `act-int-${randomUUID()}`;
    const rawToken = `act_tok_${randomUUID().replace(/-/g, '')}`;

    await db.controlAction.create({
        data: {
            id: actionId,
            sessionId: SESSION_ID,
            workroomId: WORKROOM_ID,
            actorAgentId: AGENT_ID,
            kind: 'deploy',
            summary: 'integration consume test action',
            reversibility: 'irreversible_no_abort',
            riskLevel: 'high',
            status: 'fired',
            clientIdempotencyKey: `idem-${randomUUID()}`,
        },
    });

    await db.controlActionToken.create({
        data: {
            id: `tok-int-${randomUUID()}`,
            actionId,
            tokenHash: hashToken(rawToken),
            sessionId: SESSION_ID,
            workroomId: WORKROOM_ID,
            machineId: MACHINE_ID,
            expiresAt: opts.expiresAt,
            consumedAt: opts.consumedAt ?? null,
        },
    });

    return { actionId, rawToken };
}

async function consume(actionId: string, rawToken: string) {
    return app.inject({
        method: 'POST',
        url: `/api/v1/actions/${actionId}/token/consume`,
        headers: { authorization: `Bearer ${rawToken}`, 'content-type': 'application/json' },
        payload: {},
    });
}

beforeAll(async () => {
    // Build a real Fastify app with the real route + real db (no mocks).
    app = fastify();
    await app.register(actionRoutes);
    await app.ready();

    // Seed the shared FK graph: org -> agent / workroom -> session.
    await db.controlOrg.create({
        data: { id: ORG_ID, name: 'Integration Org', slug: `int-${randomUUID()}`, ownerUserId: 'owner-int' },
    });
    await db.controlAgent.create({
        data: { id: AGENT_ID, orgId: ORG_ID, name: 'int-agent', displayName: 'Int Agent', role: 'ops' },
    });
    await db.controlWorkroom.create({
        data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Integration Workroom', createdBy: 'owner-int' },
    });
    await db.controlSession.create({
        data: {
            id: SESSION_ID,
            orgId: ORG_ID,
            workroomId: WORKROOM_ID,
            machineId: null,
            mode: 'daemon',
            runtime: 'claude',
            displayName: 'int-session',
        },
    });
});

afterAll(async () => {
    // Clean up in FK order, scoped to this test's workroom/org.
    await db.controlActionToken.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlAction.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
    await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
    await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
    await app.close();
    await db.$disconnect();
});

describe('consume endpoint — real DB consumed_at semantics (integration)', () => {
    it('first consume: 200 consumed=true and DB consumed_at goes null -> timestamp', async () => {
        const { actionId, rawToken } = await seedActionWithToken({
            expiresAt: new Date(Date.now() + 5 * 60_000),
        });

        // Precondition: consumed_at is null in the real DB.
        const before = await db.controlActionToken.findUnique({ where: { actionId }, select: { consumedAt: true } });
        expect(before?.consumedAt).toBeNull();

        const res = await consume(actionId, rawToken);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.consumed).toBe(true);
        expect(body.action_id).toBe(actionId);
        expect(body.session_id).toBe(SESSION_ID);
        expect(body.workroom_id).toBe(WORKROOM_ID);
        expect(body.secret_bundle).toEqual({ version: 1, items: [] });

        // Postcondition: consumed_at is now a real timestamp in the DB.
        const after = await db.controlActionToken.findUnique({ where: { actionId }, select: { consumedAt: true } });
        expect(after?.consumedAt).toBeInstanceOf(Date);
        expect(after?.consumedAt).not.toBeNull();
    });

    it('double consume: second call -> 403 TOKEN_NOT_CONSUMABLE, consumed_at UNCHANGED (atomic CAS)', async () => {
        const { actionId, rawToken } = await seedActionWithToken({
            expiresAt: new Date(Date.now() + 5 * 60_000),
        });

        const first = await consume(actionId, rawToken);
        expect(first.statusCode).toBe(200);
        const afterFirst = await db.controlActionToken.findUnique({ where: { actionId }, select: { consumedAt: true } });
        expect(afterFirst?.consumedAt).toBeInstanceOf(Date);
        const firstConsumedAt = afterFirst!.consumedAt!.getTime();

        // Second consume of the SAME token must be rejected by the DB-level CAS.
        const second = await consume(actionId, rawToken);
        expect(second.statusCode).toBe(403);
        expect(JSON.parse(second.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

        // consumed_at must NOT have moved (no overwrite of the original consumption).
        const afterSecond = await db.controlActionToken.findUnique({ where: { actionId }, select: { consumedAt: true } });
        expect(afterSecond?.consumedAt?.getTime()).toBe(firstConsumedAt);
    });

    it('expired token -> 403 TOKEN_NOT_CONSUMABLE, consumed_at stays null', async () => {
        const { actionId, rawToken } = await seedActionWithToken({
            expiresAt: new Date(Date.now() - 60_000), // already expired
        });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

        const after = await db.controlActionToken.findUnique({ where: { actionId }, select: { consumedAt: true } });
        expect(after?.consumedAt).toBeNull();
    });

    it('wrong action id (token belongs to another action) -> 403, real token consumed_at stays null', async () => {
        const valid = await seedActionWithToken({ expiresAt: new Date(Date.now() + 5 * 60_000) });
        const other = await seedActionWithToken({ expiresAt: new Date(Date.now() + 5 * 60_000) });

        // Present the valid raw token but against the OTHER action's id — scope mismatch.
        const res = await consume(other.actionId, valid.rawToken);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');

        // The valid token must remain unconsumed (CAS scope binding on action_id).
        const after = await db.controlActionToken.findUnique({
            where: { actionId: valid.actionId },
            select: { consumedAt: true },
        });
        expect(after?.consumedAt).toBeNull();
    });
});
