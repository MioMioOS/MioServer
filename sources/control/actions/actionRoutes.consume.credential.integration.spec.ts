/**
 * 5D credential resolution — REAL Postgres + real CredentialStore integration test.
 * (Task #20 / 5D-E — the 5D done gate:真 DB / no-leak / authz security 收口)
 *
 * Unlike actionRoutes.consume.credential.spec.ts (which MOCKS @/storage/db), this test
 * runs the full /token/consume credential-resolution path against a REAL Postgres DB
 * with a REAL (Fixture) CredentialStore injected, proving the 5D security invariants
 * end-to-end and against real rows:
 *
 *   Authorization (all server-authoritative, fail-closed, uniform 403 TOKEN_NOT_CONSUMABLE):
 *     - happy: required action kind + valid scoped credential → 200 + bundle item resolved
 *     - workroom not in scope            → 403 + action=failed     (policy denial)
 *     - action kind not allowed          → 403 + action=failed     (policy denial)
 *     - revoked credential               → 403 + action=failed     (policy denial)
 *     - expired credential               → 403 + action=failed     (policy denial)
 *     - requires credential + no alias   → 403 + action=failed     (policy denial)
 *     - alias not registered in org      → 403 + action=needs_human (config error, recoverable)
 *     - storage_ref missing in store     → 403 + action=needs_human (config error, recoverable)
 *     - non-credential action kind       → 200 + empty bundle
 *
 *   No-leak (against real DB rows):
 *     - secret value appears ONLY in the HTTP response body
 *     - secret value is NEVER in any ControlEventLog payload
 *     - secret value is NEVER in any ControlCredentialAccessLog row
 *     - access log records success/false + controlled reason_code (no secret)
 *     - lastUsedAt updated only on success
 *
 *   inject kind mapping: asc_api_key → 'file'; bearer_token → 'env_var'
 *
 * ── Running ────────────────────────────────────────────────────────────────────
 *   npm run test:db:setup && npm run test:integration
 * Excluded from the default `npm test` (no DB required there).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { actionRoutes } from './actionRoutes';
import { FixtureCredentialStore, CredentialStoreError } from '@/control/credentials/credentialStore';

const ORG_ID = randomUUID();
const AGENT_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();
const SESSION_ID = randomUUID();
const MACHINE_ID = randomUUID();

let app: FastifyInstance;
let store: FixtureCredentialStore;

function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/** Seed a credential metadata row + put its secret value in the FixtureCredentialStore. */
async function seedCredential(opts: {
    alias: string;
    kind?: string;
    storageRef?: string;
    secretValue?: string | null; // null = do NOT put in store (simulate store miss)
    scopeMode?: string;
    scopeWorkroomIds?: string[];
    allowedActionKinds?: string[];
    revoked?: boolean;
    expiresAt?: Date | null;
}): Promise<void> {
    const storageRef = opts.storageRef ?? `ref-${randomUUID()}`;
    await db.controlCredential.create({
        data: {
            id: randomUUID(),
            orgId: ORG_ID,
            alias: opts.alias,
            kind: opts.kind ?? 'bearer_token',
            storageRef,
            scopeMode: opts.scopeMode ?? 'workroom',
            scopeWorkroomIds: opts.scopeWorkroomIds ?? [WORKROOM_ID],
            allowedActionKinds: opts.allowedActionKinds ?? [],
            revoked: opts.revoked ?? false,
            expiresAt: opts.expiresAt ?? null,
            createdBy: randomUUID(),
        },
    });
    if (opts.secretValue !== null) {
        store.seed(storageRef, opts.secretValue ?? `secret-${randomUUID()}`);
    }
}

/** Seed a fired action (credential-requiring kind by default) + its action_token. */
async function seedAction(opts: {
    kind?: string;
    credentialAliasRef?: string | null;
    workroomId?: string;
}): Promise<{ actionId: string; rawToken: string }> {
    const actionId = randomUUID();
    const rawToken = `act_tok_${randomUUID().replace(/-/g, '')}`;
    const workroomId = opts.workroomId ?? WORKROOM_ID;
    await db.controlAction.create({
        data: {
            id: actionId,
            sessionId: SESSION_ID,
            workroomId,
            actorAgentId: AGENT_ID,
            kind: opts.kind ?? 'deploy_web',
            summary: '5D credential integration test action',
            reversibility: 'irreversible_no_abort',
            riskLevel: 'high',
            requiresApproval: true,
            status: 'fired',
            credentialAliasRef: opts.credentialAliasRef ?? null,
            clientIdempotencyKey: `idem-${randomUUID()}`,
        },
    });
    await db.controlActionToken.create({
        data: {
            id: randomUUID(),
            actionId,
            tokenHash: hashToken(rawToken),
            sessionId: SESSION_ID,
            workroomId,
            machineId: MACHINE_ID,
            expiresAt: new Date(Date.now() + 5 * 60_000),
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

async function actionStatus(actionId: string): Promise<string | undefined> {
    const a = await db.controlAction.findUnique({ where: { id: actionId }, select: { status: true } });
    return a?.status;
}

beforeAll(async () => {
    store = new FixtureCredentialStore();
    app = fastify();
    await app.register(actionRoutes, { credentialStore: store });
    await app.ready();

    await db.controlOrg.create({
        data: { id: ORG_ID, name: '5D Cred Org', slug: `cred-${randomUUID()}`, ownerUserId: randomUUID() },
    });
    await db.controlAgent.create({
        data: { id: AGENT_ID, orgId: ORG_ID, name: 'cred-agent', displayName: 'Cred Agent', role: 'ops' },
    });
    for (const wid of [WORKROOM_ID, OTHER_WORKROOM_ID]) {
        await db.controlWorkroom.create({
            data: { id: wid, orgId: ORG_ID, name: `Cred Workroom ${wid.slice(0, 8)}`, createdBy: randomUUID() },
        });
    }
    // session.machine_id FKs to control_machines; leave null. The access_log machineId
    // comes from the action_token row (token.machineId = MACHINE_ID, no FK), not the session.
    await db.controlSession.create({
        data: {
            id: SESSION_ID, orgId: ORG_ID, workroomId: WORKROOM_ID, machineId: null,
            mode: 'daemon', runtime: 'claude', displayName: 'cred-session',
        },
    });
});

afterAll(async () => {
    await db.controlCredentialAccessLog.deleteMany({ where: { action: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } } });
    await db.controlEventLog.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
    await db.controlActionToken.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
    await db.controlAction.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
    await db.controlCredential.deleteMany({ where: { orgId: ORG_ID } });
    await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
    await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
    await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
    await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
    await app.close();
    await db.$disconnect();
});

describe('5D credential resolution — real DB authorization (integration)', () => {
    it('happy path: deploy_web + valid scoped bearer_token → 200, bundle item resolved, access_log success, lastUsedAt set', async () => {
        const alias = `vercel-${randomUUID()}`;
        const secret = `tok_${randomUUID()}`;
        const storageRef = `ref-${randomUUID()}`;
        await seedCredential({
            alias, kind: 'bearer_token', storageRef, secretValue: secret,
            scopeWorkroomIds: [WORKROOM_ID], allowedActionKinds: ['deploy_web'],
        });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.secret_bundle.version).toBe(1);
        expect(body.secret_bundle.items).toHaveLength(1);
        expect(body.secret_bundle.items[0]).toEqual({ key: alias, value: secret, kind: 'env_var' });

        // access_log: success row, no secret.
        const logs = await db.controlCredentialAccessLog.findMany({ where: { actionId } });
        expect(logs).toHaveLength(1);
        expect(logs[0].success).toBe(true);
        expect(JSON.stringify(logs[0])).not.toContain(secret);

        // lastUsedAt set on the credential.
        const cred = await db.controlCredential.findFirst({ where: { orgId: ORG_ID, alias }, select: { lastUsedAt: true } });
        expect(cred?.lastUsedAt).toBeInstanceOf(Date);

        // Action not transitioned to a failure state by a successful consume.
        expect(await actionStatus(actionId)).toBe('fired');
    });

    it('asc_api_key → inject kind "file"', async () => {
        const alias = `asc-${randomUUID()}`;
        await seedCredential({
            alias, kind: 'asc_api_key', secretValue: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
            allowedActionKinds: ['publish_ios'],
        });
        const { actionId, rawToken } = await seedAction({ kind: 'publish_ios', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).secret_bundle.items[0].kind).toBe('file');
    });

    it('workroom not in scope → 403 TOKEN_NOT_CONSUMABLE + action=failed', async () => {
        const alias = `scope-${randomUUID()}`;
        await seedCredential({ alias, secretValue: 's', scopeWorkroomIds: [OTHER_WORKROOM_ID], allowedActionKinds: ['deploy_web'] });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');
        expect(await actionStatus(actionId)).toBe('failed');
        const logs = await db.controlCredentialAccessLog.findMany({ where: { actionId } });
        expect(logs[0].success).toBe(false);
        expect(logs[0].reasonCode).toBe('credential_denied');
    });

    it('action kind not in allowedActionKinds → 403 + action=failed', async () => {
        const alias = `kind-${randomUUID()}`;
        await seedCredential({ alias, secretValue: 's', allowedActionKinds: ['publish_ios'] }); // not deploy_web
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(await actionStatus(actionId)).toBe('failed');
    });

    it('revoked credential → 403 + action=failed', async () => {
        const alias = `rev-${randomUUID()}`;
        await seedCredential({ alias, secretValue: 's', revoked: true, allowedActionKinds: ['deploy_web'] });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(await actionStatus(actionId)).toBe('failed');
    });

    it('expired credential → 403 + action=failed', async () => {
        const alias = `exp-${randomUUID()}`;
        await seedCredential({ alias, secretValue: 's', expiresAt: new Date(Date.now() - 60_000), allowedActionKinds: ['deploy_web'] });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(await actionStatus(actionId)).toBe('failed');
    });

    it('requires credential (deploy_web) but no alias set → 403 + action=failed (policy)', async () => {
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: null });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');
        expect(await actionStatus(actionId)).toBe('failed');
    });

    it('alias not registered in org → 403 + action=needs_human (config error, recoverable)', async () => {
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: `ghost-${randomUUID()}` });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');
        expect(await actionStatus(actionId)).toBe('needs_human');
    });

    it('storage_ref missing in store → 403 + action=needs_human (config error)', async () => {
        const alias = `nostore-${randomUUID()}`;
        // Credential row exists + passes scope, but its storageRef is NOT seeded into the store.
        await seedCredential({ alias, secretValue: null, allowedActionKinds: ['deploy_web'] });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');
        expect(await actionStatus(actionId)).toBe('needs_human');
        const logs = await db.controlCredentialAccessLog.findMany({ where: { actionId } });
        expect(logs[0].success).toBe(false);
        expect(logs[0].reasonCode).toBe('credential_configuration_invalid');
    });

    it('adapter resolve denied (credential_denied) → 403 + action=failed (terminal authz, NOT needs_human)', async () => {
        // #72: an adapter-level authorization denial (IAM/policy refused the resolve, e.g. SSM
        // AccessDenied) is a TERMINAL authz failure → failed + credential_denied. The credential row
        // + secret are valid and scope passes; only the resolve itself is denied. It must NOT be
        // misclassified as the recoverable needs_human path.
        const alias = `denied-${randomUUID()}`;
        await seedCredential({ alias, secretValue: `s-${randomUUID()}`, allowedActionKinds: ['deploy_web'] });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        // Force the next resolve() to be denied at the adapter layer. spyOn falls through to the
        // original for any later calls; restored in finally.
        const denySpy = vi.spyOn(store, 'resolve').mockRejectedValueOnce(
            new CredentialStoreError('credential_denied', 'integration: IAM/policy denied resolve'),
        );
        try {
            const res = await consume(actionId, rawToken);
            expect(res.statusCode).toBe(403);
            expect(JSON.parse(res.body).error.code).toBe('TOKEN_NOT_CONSUMABLE');
            // Terminal failure — action=failed, NOT needs_human.
            expect(await actionStatus(actionId)).toBe('failed');
            const logs = await db.controlCredentialAccessLog.findMany({ where: { actionId } });
            expect(logs[0].success).toBe(false);
            expect(logs[0].reasonCode).toBe('credential_denied');
            // The emitted event is action.failed, never action.needs_human.
            const events = await db.controlEventLog.findMany({ where: { workroomId: WORKROOM_ID } });
            const evt = events.find((e) => JSON.stringify(e.payloadJson).includes(actionId));
            expect(evt?.topic).toBe('action.failed');
        } finally {
            denySpy.mockRestore();
        }
    });

    it('non-credential action kind → 200 + empty bundle, no credential lookup', async () => {
        const { actionId, rawToken } = await seedAction({ kind: 'deploy', credentialAliasRef: null }); // 'deploy' not in required set

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).secret_bundle).toEqual({ version: 1, items: [] });
        // No access log written for a non-credential action.
        expect(await db.controlCredentialAccessLog.findMany({ where: { actionId } })).toHaveLength(0);
    });
});

describe('5D credential resolution — no-leak against real DB rows', () => {
    it('secret value appears ONLY in HTTP response — never in EventLog or access_log', async () => {
        const alias = `leak-${randomUUID()}`;
        const secret = `SUPER_SECRET_${randomUUID()}`;
        await seedCredential({ alias, secretValue: secret, allowedActionKinds: ['deploy_web'] });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        const res = await consume(actionId, rawToken);
        expect(res.statusCode).toBe(200);
        // Secret IS delivered in the HTTP body (positive control).
        expect(res.body).toContain(secret);

        // Secret is NOT in any EventLog payload for this workroom.
        const events = await db.controlEventLog.findMany({ where: { workroomId: WORKROOM_ID } });
        for (const e of events) {
            expect(JSON.stringify(e.payloadJson)).not.toContain(secret);
        }
        // Secret is NOT in any access log row.
        const logs = await db.controlCredentialAccessLog.findMany({ where: { actionId } });
        for (const l of logs) {
            expect(JSON.stringify(l)).not.toContain(secret);
        }
        // Secret is NOT persisted on the credential row (DB stores only storage_ref pointer).
        const cred = await db.controlCredential.findFirst({ where: { orgId: ORG_ID, alias } });
        expect(JSON.stringify(cred)).not.toContain(secret);
    });

    it('failure path emits action.failed event with reason_code only — no secret', async () => {
        const alias = `leakfail-${randomUUID()}`;
        const secret = `FAIL_SECRET_${randomUUID()}`;
        // Seed the secret in store but make scope fail → policy denial → action.failed event.
        await seedCredential({ alias, secretValue: secret, scopeWorkroomIds: [OTHER_WORKROOM_ID], allowedActionKinds: ['deploy_web'] });
        const { actionId, rawToken } = await seedAction({ kind: 'deploy_web', credentialAliasRef: alias });

        await consume(actionId, rawToken);

        const events = await db.controlEventLog.findMany({ where: { workroomId: WORKROOM_ID } });
        const failEvent = events.find((e) => e.topic === 'action.failed' && JSON.stringify(e.payloadJson).includes(actionId));
        expect(failEvent, 'action.failed event should be emitted').toBeDefined();
        // The event carries reason_code but never the secret.
        expect(JSON.stringify(failEvent!.payloadJson)).toContain('credential_denied');
        expect(JSON.stringify(failEvent!.payloadJson)).not.toContain(secret);
    });
});
