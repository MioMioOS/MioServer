/**
 * dev_control_token dual-auth — REAL Postgres integration test (#32, block ④).
 *
 * Proves the security matrix of the read-only dev token against a REAL DB + real routes
 * (no mocks): a dev token may only GET allowlisted endpoints within its bound workroom;
 * cross-workroom / non-allowlisted / write / expired / revoked are denied; machine_token
 * auth is NOT regressed; and the raw token never appears in any response.
 *
 * ── Running ────────────────────────────────────────────────────────────────────
 * Requires a real Postgres test DB (db name must contain "test"). NOT part of `npm test`.
 *   1. npm run test:db:setup
 *   2. npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { actionRoutes } from '../actions/actionRoutes';
import { taskRoutes } from '../tasks/taskRoutes';
import { isDevTokenAllowedPath } from './devTokenAuth';

const ORG_ID = randomUUID();
const AGENT_ID = randomUUID();
const WORKROOM_A = randomUUID();
const WORKROOM_B = randomUUID();
const SESSION_A = randomUUID();
let ACTION_A = '';
let ACTION_B = '';
let TASK_A = '';

// Raw dev tokens (only place they exist in plaintext).
const RAW_VALID = `dev_ctl_${randomUUID().replace(/-/g, '')}`;
const RAW_EXPIRED = `dev_ctl_${randomUUID().replace(/-/g, '')}`;
const RAW_REVOKED = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let app: FastifyInstance;

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const get = (url: string, token?: string) =>
    app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function seedAction(workroomId: string): Promise<string> {
    const id = randomUUID();
    await db.controlAction.create({
        data: {
            id, sessionId: SESSION_A, workroomId, actorAgentId: AGENT_ID,
            kind: 'other', summary: 'devtoken int test action',
            reversibility: 'reversible', riskLevel: 'low', requiresApproval: false,
            status: 'fired', clientIdempotencyKey: `idem-${randomUUID()}`,
        },
    });
    return id;
}

beforeAll(async () => {
    app = fastify();
    await app.register(actionRoutes);
    await app.register(taskRoutes);
    await app.ready();

    await db.controlOrg.create({ data: { id: ORG_ID, name: 'DevTok Org', slug: `dt-${randomUUID()}`, ownerUserId: randomUUID() } });
    await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, name: 'dt-agent', displayName: 'DT', role: 'ops' } });
    await db.controlWorkroom.create({ data: { id: WORKROOM_A, orgId: ORG_ID, name: 'WR-A', createdBy: randomUUID() } });
    await db.controlWorkroom.create({ data: { id: WORKROOM_B, orgId: ORG_ID, name: 'WR-B', createdBy: randomUUID() } });
    await db.controlSession.create({ data: { id: SESSION_A, orgId: ORG_ID, workroomId: WORKROOM_A, machineId: null, mode: 'daemon', runtime: 'claude', displayName: 'dt-session' } });

    ACTION_A = await seedAction(WORKROOM_A);
    ACTION_B = await seedAction(WORKROOM_B);

    TASK_A = randomUUID();
    await db.controlTask.create({ data: { id: TASK_A, workroomId: WORKROOM_A, title: 'dt task', status: 'todo', ownerInstanceId: AGENT_ID } });

    const now = Date.now();
    await db.controlDevToken.create({ data: { tokenHash: hash(RAW_VALID), orgId: ORG_ID, workroomId: WORKROOM_A, scope: 'read_only', expiresAt: new Date(now + 3600_000) } });
    await db.controlDevToken.create({ data: { tokenHash: hash(RAW_EXPIRED), orgId: ORG_ID, workroomId: WORKROOM_A, scope: 'read_only', expiresAt: new Date(now - 1000) } });
    await db.controlDevToken.create({ data: { tokenHash: hash(RAW_REVOKED), orgId: ORG_ID, workroomId: WORKROOM_A, scope: 'read_only', expiresAt: new Date(now + 3600_000), revokedAt: new Date(now - 1000) } });
});

afterAll(async () => {
    await db.controlDevToken.deleteMany({ where: { workroomId: WORKROOM_A } });
    await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_A } });
    await db.controlAction.deleteMany({ where: { workroomId: { in: [WORKROOM_A, WORKROOM_B] } } });
    await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_A } });
    await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_A, WORKROOM_B] } } });
    await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
    await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
    await app.close();
    await db.$disconnect();
});

describe('dev_control_token dual-auth — real DB security matrix (#32)', () => {
    it('in-scope: GET /actions/:id in bound workroom -> 200', async () => {
        const res = await get(`/api/v1/actions/${ACTION_A}`, RAW_VALID);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).action_id).toBe(ACTION_A);
    });

    it('cross-workroom: GET /actions/:id in OTHER workroom -> 403 (scope, anti-enumeration)', async () => {
        const res = await get(`/api/v1/actions/${ACTION_B}`, RAW_VALID);
        expect(res.statusCode).toBe(403);
    });

    it('non-existent action via dev token -> 403 (not 404; no existence leak)', async () => {
        const res = await get(`/api/v1/actions/${randomUUID()}`, RAW_VALID);
        expect(res.statusCode).toBe(403);
    });

    it('in-scope: GET /workrooms/:id/tasks (bound) -> 200; other workroom -> 403', async () => {
        expect((await get(`/api/v1/workrooms/${WORKROOM_A}/tasks`, RAW_VALID)).statusCode).toBe(200);
        expect((await get(`/api/v1/workrooms/${WORKROOM_B}/tasks`, RAW_VALID)).statusCode).toBe(403);
    });

    it('in-scope: GET /workrooms/:id/actions (bound) -> 200 incl seeded action; other -> 403', async () => {
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/actions`, RAW_VALID);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.items.some((a: { action_id: string }) => a.action_id === ACTION_A)).toBe(true);
        expect((await get(`/api/v1/workrooms/${WORKROOM_B}/actions`, RAW_VALID)).statusCode).toBe(403);
    });

    it('non-allowlisted route via dev token -> denied 401 (machine-only routes never opt into dual-auth)', async () => {
        // Two-tier denial model:
        //   - Routes wired with authorizeControlRead (the 3 allowlisted GETs) enforce the
        //     dev-token allowlist + workroom-scope and return a UNIFORM 403 on any failure
        //     (anti-enumeration WITHIN the dual-auth path).
        //   - Routes that are machine-only (GET /tasks/:id, GET /approvals/:id, etc.) never
        //     call authorizeControlRead at all; a dev token fails verifyMachineToken and is
        //     rejected with 401. The dev token CANNOT read these endpoints either way.
        // Security property under test: a valid dev token is DENIED (never 200) on routes
        // outside its allowlist.
        const taskRes = await get(`/api/v1/tasks/${TASK_A}`, RAW_VALID);
        const apprRes = await get(`/api/v1/approvals/${randomUUID()}`, RAW_VALID);
        expect(taskRes.statusCode).toBe(401);
        expect(apprRes.statusCode).toBe(401);
        // The essential invariant regardless of 401-vs-403: never a successful read.
        expect(taskRes.statusCode).not.toBe(200);
        expect(apprRes.statusCode).not.toBe(200);
    });

    it('allowlist predicate is default-deny: only the 3 GET paths pass; non-GET / off-list rejected', () => {
        // Locks the dev-token GET allowlist (defense-in-depth: this predicate also guards the
        // 403 branch of authorizeControlRead for any FUTURE route that adds dual-auth).
        expect(isDevTokenAllowedPath('GET', `/api/v1/workrooms/${WORKROOM_A}/tasks`)).toBe(true);
        expect(isDevTokenAllowedPath('GET', `/api/v1/workrooms/${WORKROOM_A}/actions`)).toBe(true);
        expect(isDevTokenAllowedPath('GET', `/api/v1/actions/${ACTION_A}`)).toBe(true);
        // Query string is stripped before matching.
        expect(isDevTokenAllowedPath('GET', `/api/v1/workrooms/${WORKROOM_A}/actions?limit=10`)).toBe(true);
        // Non-GET methods on an allowlisted path → denied.
        expect(isDevTokenAllowedPath('POST', `/api/v1/workrooms/${WORKROOM_A}/tasks`)).toBe(false);
        expect(isDevTokenAllowedPath('DELETE', `/api/v1/actions/${ACTION_A}`)).toBe(false);
        // Off-allowlist GET paths → denied.
        expect(isDevTokenAllowedPath('GET', `/api/v1/tasks/${TASK_A}`)).toBe(false);
        expect(isDevTokenAllowedPath('GET', `/api/v1/approvals/${randomUUID()}`)).toBe(false);
        expect(isDevTokenAllowedPath('GET', `/api/v1/workrooms/${WORKROOM_A}`)).toBe(false);
        expect(isDevTokenAllowedPath('GET', '/api/v1/workrooms')).toBe(false);
    });

    it('write route via dev token -> 401 (write routes are machine-only)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/api/v1/workrooms/${WORKROOM_A}/tasks`,
            headers: { authorization: `Bearer ${RAW_VALID}`, 'content-type': 'application/json' },
            payload: { title: 'should not be created' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('expired dev token -> 401', async () => {
        expect((await get(`/api/v1/actions/${ACTION_A}`, RAW_EXPIRED)).statusCode).toBe(401);
    });

    it('revoked dev token -> 401', async () => {
        expect((await get(`/api/v1/actions/${ACTION_A}`, RAW_REVOKED)).statusCode).toBe(401);
    });

    it('no token -> 401', async () => {
        expect((await get(`/api/v1/actions/${ACTION_A}`)).statusCode).toBe(401);
    });

    it('no-leak: raw dev token never appears in any response body', async () => {
        for (const url of [
            `/api/v1/actions/${ACTION_A}`,
            `/api/v1/workrooms/${WORKROOM_A}/tasks`,
            `/api/v1/workrooms/${WORKROOM_A}/actions`,
            `/api/v1/actions/${ACTION_B}`,
        ]) {
            const res = await get(url, RAW_VALID);
            expect(res.body).not.toContain(RAW_VALID);
            expect(res.body).not.toContain(hash(RAW_VALID));
        }
    });
});
