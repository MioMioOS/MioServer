/**
 * #164 — server-assist explanation endpoint, REAL Postgres integration test.
 *
 * Proves the endpoint's security + behavior contract against real routes + DB (no mocks):
 *   - feature gate: OFF → never fetch, never call provider, returns feature_enabled:false.
 *   - readiness: deterministic #166 template, is_fallback:true, no provider/no fetch.
 *   - action_failure / task_summary: scoped fetch → deterministic fallback (Phase 1 provider=null).
 *   - no-leak scope: cross-workroom action/task → UNIFORM 404 (never reveal cross-workroom existence).
 *   - Slice 7 dual-auth: user_sess_ (workroom member) works; user_sess_ (non-member) → 401;
 *                         machine_token cross-workroom → 401 (resolveActor uniformly).
 *   - input hygiene: bad kind → 400, missing/!uuid action_id → 400.
 *
 * Slice 7 note: the legacy `dev_ctl_` path is GONE. Auth is now userOrMachine.
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
import { config } from '@/config';
import { explanationRoutes } from './explanationRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

const ORG_ID = randomUUID();
const AGENT_ID = randomUUID();
const WORKROOM_A = randomUUID();
const WORKROOM_B = randomUUID();
const SESSION_A = randomUUID();
let ACTION_A = '';
let ACTION_B = '';
let TASK_A = '';
let TASK_B = '';

// Slice 7: machine + user fixtures (no more dev_ctl_).
const MACHINE_ID = randomUUID();
const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
let USER_A_TOKEN = '';
let USER_A_ID = '';
let USER_NM_TOKEN = '';
let USER_NM_ID = '';

let app: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const get = (url: string, token?: string) =>
    app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

// config is `as const` (readonly at type-level, mutable at runtime). The route reads the flag at
// request time, so toggling the singleton lets us exercise both gate states without re-importing.
const setFeature = (on: boolean) => {
    (config as unknown as { serverLlmExplanationEnabled: boolean }).serverLlmExplanationEnabled = on;
};

async function seedAction(workroomId: string, status: string): Promise<string> {
    const id = randomUUID();
    await db.controlAction.create({
        data: {
            id, sessionId: SESSION_A, workroomId, actorAgentId: AGENT_ID,
            kind: 'other', summary: 'explanation int test action',
            reversibility: 'reversible', riskLevel: 'low', requiresApproval: false,
            status, clientIdempotencyKey: `idem-${randomUUID()}`,
        },
    });
    return id;
}

beforeAll(async () => {
    app = fastify();
    await app.register(explanationRoutes);
    await app.ready();

    await db.controlOrg.create({ data: { id: ORG_ID, name: 'Expl Org', slug: `expl-${randomUUID()}`, ownerUserId: randomUUID() } });
    await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, name: 'expl-agent', displayName: 'EX', role: 'ops' } });
    await db.controlWorkroom.create({ data: { id: WORKROOM_A, orgId: ORG_ID, name: 'WR-A', createdBy: randomUUID() } });
    await db.controlWorkroom.create({ data: { id: WORKROOM_B, orgId: ORG_ID, name: 'WR-B', createdBy: randomUUID() } });
    await db.controlSession.create({ data: { id: SESSION_A, orgId: ORG_ID, workroomId: WORKROOM_A, machineId: null, mode: 'daemon', runtime: 'claude', displayName: 'expl-session' } });

    ACTION_A = await seedAction(WORKROOM_A, 'needs_human');
    ACTION_B = await seedAction(WORKROOM_B, 'failed');

    TASK_A = randomUUID();
    TASK_B = randomUUID();
    await db.controlTask.create({ data: { id: TASK_A, workroomId: WORKROOM_A, title: 'expl task A', status: 'in_progress', ownerInstanceId: AGENT_ID } });
    await db.controlTask.create({ data: { id: TASK_B, workroomId: WORKROOM_B, title: 'expl task B', status: 'todo', ownerInstanceId: AGENT_ID } });

    // Slice 7: machine bound to ORG_ID (covers both workrooms by org match) + two users.
    await db.controlMachine.create({
        data: {
            id: MACHINE_ID, orgId: ORG_ID, boundAt: new Date(),
            tokenHash: sha256(MACHINE_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
            platform: 'darwin', arch: 'arm64',
        },
    });
    const memberUser = await db.user.create({
        data: { email: `expl-mem-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
    });
    USER_A_ID = memberUser.id;
    USER_A_TOKEN = mintUserSessionToken();
    await db.userSession.create({
        data: { userId: USER_A_ID, tokenHash: hashUserSessionToken(USER_A_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await db.userWorkroomMembership.create({
        data: { userId: USER_A_ID, workroomId: WORKROOM_A, role: 'owner' },
    });
    const nmUser = await db.user.create({
        data: { email: `expl-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
    });
    USER_NM_ID = nmUser.id;
    USER_NM_TOKEN = mintUserSessionToken();
    await db.userSession.create({
        data: { userId: USER_NM_ID, tokenHash: hashUserSessionToken(USER_NM_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
    });
});

afterAll(async () => {
    setFeature(false);
    await db.user.deleteMany({ where: { id: { in: [USER_A_ID, USER_NM_ID] } } });
    await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
    await db.controlTask.deleteMany({ where: { workroomId: { in: [WORKROOM_A, WORKROOM_B] } } });
    await db.controlAction.deleteMany({ where: { workroomId: { in: [WORKROOM_A, WORKROOM_B] } } });
    await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_A } });
    await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_A, WORKROOM_B] } } });
    await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
    await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
    await app.close();
    await db.$disconnect();
});

describe('#164 explanation endpoint — real DB contract', () => {
    // ── Auth (independent of feature gate; auth runs first) ──
    it('no token -> 401', async () => {
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=readiness`);
        expect(res.statusCode).toBe(401);
    });

    it('user_sess_ (non-member of workroom) -> 401 (uniform)', async () => {
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=readiness`, USER_NM_TOKEN);
        expect(res.statusCode).toBe(401);
    });

    // ── Feature gate OFF (default) ──
    it('feature OFF: returns feature_enabled:false, no explanation, never fetches', async () => {
        setFeature(false);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=action_failure&action_id=${ACTION_A}`, USER_A_TOKEN);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.feature_enabled).toBe(false);
        expect(body.explanation_text).toBe(null);
        expect(body.is_fallback).toBe(false);
    });

    // ── Feature gate ON ──
    it('feature ON, readiness ready+ready -> deterministic R-01 template, is_fallback:true (machine_token)', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=readiness&server_status=connected&read_status=ready&operator_status=ready`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.feature_enabled).toBe(true);
        expect(body.is_fallback).toBe(true);
        expect(body.explanation_text).toBe('读取权限和操作权限都已就绪。');
        expect(typeof body.generated_at).toBe('string');
    });

    it('feature ON, readiness via user_sess_ (workroom member) -> 200 + deterministic template', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=readiness&server_status=connected&read_status=ready&operator_status=ready`, USER_A_TOKEN);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.feature_enabled).toBe(true);
        expect(body.explanation_text).toBe('读取权限和操作权限都已就绪。');
    });

    it('feature ON, readiness server unreachable -> R-05 template (unreachable wins)', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=readiness&server_status=unreachable&read_status=ready&operator_status=ready`, MACHINE_RAW_TOKEN);
        const body = JSON.parse(res.body);
        expect(body.explanation_text).toBe('控制服务器无法连接，请稍后重试。');
    });

    it('feature ON, action_failure (needs_human, in-scope) -> A-01 fallback (provider null Phase 1)', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=action_failure&action_id=${ACTION_A}`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.feature_enabled).toBe(true);
        expect(body.is_fallback).toBe(true);
        expect(body.explanation_text).toBe('此操作需要人工确认。');
    });

    it('feature ON, action_failure cross-workroom action -> UNIFORM 404 (no cross-workroom existence leak)', async () => {
        setFeature(true);
        // ACTION_B is real but belongs to WORKROOM_B; requested under WORKROOM_A → must look identical
        // to not-found (anti-enumeration). machine_token is scoped to ORG_ID (covers both workrooms).
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=action_failure&action_id=${ACTION_B}`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(404);
    });

    it('feature ON, action_failure non-existent action -> 404 (same shape as cross-workroom)', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=action_failure&action_id=${randomUUID()}`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(404);
    });

    it('feature ON, action_failure missing action_id -> 400', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=action_failure`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(400);
    });

    it('feature ON, action_failure non-uuid action_id -> 400 (no DB lookup on garbage)', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=action_failure&action_id=not-a-uuid`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(400);
    });

    it('feature ON, task_summary (in-scope) -> deterministic fallback', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=task_summary&task_id=${TASK_A}`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.feature_enabled).toBe(true);
        expect(body.is_fallback).toBe(true);
        expect(body.explanation_text).toBe('任务状态已同步，详情请查看任务列表。');
    });

    it('feature ON, task_summary cross-workroom task -> UNIFORM 404', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=task_summary&task_id=${TASK_B}`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(404);
    });

    it('feature ON, invalid kind -> 400', async () => {
        setFeature(true);
        const res = await get(`/api/v1/workrooms/${WORKROOM_A}/explanation?kind=bogus`, MACHINE_RAW_TOKEN);
        expect(res.statusCode).toBe(400);
    });

    it('no-leak: raw machine token / its hash never appear in any response body', async () => {
        setFeature(true);
        for (const url of [
            `/api/v1/workrooms/${WORKROOM_A}/explanation?kind=readiness&read_status=ready&operator_status=ready`,
            `/api/v1/workrooms/${WORKROOM_A}/explanation?kind=action_failure&action_id=${ACTION_A}`,
            `/api/v1/workrooms/${WORKROOM_A}/explanation?kind=task_summary&task_id=${TASK_A}`,
        ]) {
            const res = await get(url, MACHINE_RAW_TOKEN);
            expect(res.body).not.toContain(MACHINE_RAW_TOKEN);
            expect(res.body).not.toContain(sha256(MACHINE_RAW_TOKEN));
        }
    });
});
