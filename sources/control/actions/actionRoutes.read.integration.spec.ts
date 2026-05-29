/**
 * GET /api/v1/actions/:id  and  GET /api/v1/workrooms/:workroomId/actions
 * Slice 7 B2-e — user_sess_ / machine_token unified auth integration tests.
 *
 * Surfaces tested:
 *   GET /api/v1/actions/:id                      — derived-workroom, 404-on-non-member
 *   GET /api/v1/workrooms/:workroomId/actions    — param-workroom (404 missing / 403 non-member)
 *
 * Matrix:
 *   - user-member  → 200 (member.role=owner or guest both succeed on reads)
 *   - user non-member on /actions/:id → 404 (derived-workroom anti-enum)
 *   - user non-member on /workrooms/:wid/actions → 403 (param-workroom)
 *   - machine in-org → 200
 *   - machine cross-org on /actions/:id → 404 (derived anti-enum)
 *   - machine cross-org on /workrooms/:wid/actions → 403 FORBIDDEN (machineAccess error)
 *   - missing workroom on param route → 404 WORKROOM_NOT_FOUND
 *   - no token / invalid token → 401
 *   - malformed action uuid → 404 (uniform with not-found)
 *   - user_sess_ response carries `capabilities` block; machine_token response omits it
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { actionRoutes } from './actionRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();           // belongs to OTHER_ORG_ID
const AGENT_ID = randomUUID();
const SESSION_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let MEMBER_USER_ID = '';
let MEMBER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let app: FastifyInstance;
let ACTION_ID = '';
let OTHER_ACTION_ID = '';

async function seedAction(workroomId: string): Promise<string> {
  const id = randomUUID();
  await db.controlAction.create({
    data: {
      id,
      sessionId: SESSION_ID,
      workroomId,
      actorAgentId: AGENT_ID,
      kind: 'other',
      summary: 'read test action',
      reversibility: 'reversible',
      riskLevel: 'low',
      requiresApproval: false,
      status: 'needs_human',
      clientIdempotencyKey: `idem-${randomUUID()}`,
    },
  });
  return id;
}

function get(url: string, token?: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

beforeAll(async () => {
  app = fastify();
  await app.register(actionRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'ARead Org', slug: `aread-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlOrg.create({ data: { id: OTHER_ORG_ID, name: 'ARead Other', slug: `aread-other-${randomUUID()}`, ownerUserId: randomUUID() } });

  await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, name: 'aread-agent', displayName: 'ARead Agent', role: 'ops' } });

  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'WR primary', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM_ID, orgId: OTHER_ORG_ID, name: 'WR other', createdBy: randomUUID() } });

  await db.controlSession.create({
    data: {
      id: SESSION_ID, orgId: ORG_ID, workroomId: WORKROOM_ID, machineId: null,
      mode: 'daemon', runtime: 'claude', displayName: 'aread-session',
    },
  });

  await db.controlMachine.create({
    data: {
      id: MACHINE_ID, orgId: ORG_ID, tokenHash: sha256(MACHINE_RAW_TOKEN),
      tokenExpiresAt: new Date(Date.now() + 86_400_000), platform: 'darwin', arch: 'arm64',
    },
  });
  await db.controlMachine.create({
    data: {
      id: OTHER_MACHINE_ID, orgId: OTHER_ORG_ID, tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN),
      tokenExpiresAt: new Date(Date.now() + 86_400_000), platform: 'darwin', arch: 'arm64',
    },
  });

  const member = await db.user.create({
    data: { email: `aread-member-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  MEMBER_USER_ID = member.id;
  MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: MEMBER_USER_ID, tokenHash: hashUserSessionToken(MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.userWorkroomMembership.create({ data: { userId: MEMBER_USER_ID, workroomId: WORKROOM_ID, role: 'owner' } });

  const nm = await db.user.create({
    data: { email: `aread-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });

  ACTION_ID = await seedAction(WORKROOM_ID);
  OTHER_ACTION_ID = await seedAction(OTHER_WORKROOM_ID);
});

afterAll(async () => {
  await db.controlAction.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlSession.deleteMany({ where: { id: SESSION_ID } });
  await db.userWorkroomMembership.deleteMany({ where: { userId: { in: [MEMBER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.userSession.deleteMany({ where: { userId: { in: [MEMBER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.user.deleteMany({ where: { id: { in: [MEMBER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await app.close();
  await db.$disconnect();
});

describe('GET /api/v1/actions/:id — Slice 7 B2-e', () => {
  it('user-member → 200 + capabilities block emitted', async () => {
    const res = await get(`/api/v1/actions/${ACTION_ID}`, MEMBER_USER_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action_id).toBe(ACTION_ID);
    expect(body.workroom_id).toBe(WORKROOM_ID);
    // capabilities is emitted on the user path (replaces old dev_ctl_ branch).
    expect(body.capabilities).toBeDefined();
  });

  it('machine in-org → 200 + capabilities OMITTED (machine path)', async () => {
    const res = await get(`/api/v1/actions/${ACTION_ID}`, MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action_id).toBe(ACTION_ID);
    expect(body.capabilities).toBeUndefined();
  });

  it('user non-member → 404 ACTION_NOT_FOUND (derived-workroom anti-enum)', async () => {
    const res = await get(`/api/v1/actions/${ACTION_ID}`, NON_MEMBER_USER_TOKEN);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('ACTION_NOT_FOUND');
  });

  it('machine cross-org → 404 ACTION_NOT_FOUND (uniform with user non-member)', async () => {
    const res = await get(`/api/v1/actions/${ACTION_ID}`, OTHER_MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('ACTION_NOT_FOUND');
  });

  it('no token → 401', async () => {
    const res = await get(`/api/v1/actions/${ACTION_ID}`, undefined);
    expect(res.statusCode).toBe(401);
  });

  it('invalid token → 401 (uniform across token classes)', async () => {
    const res = await get(`/api/v1/actions/${ACTION_ID}`, 'totally-invalid-token');
    expect(res.statusCode).toBe(401);
  });

  it('non-existent action id → 404 ACTION_NOT_FOUND (uniform with non-member)', async () => {
    const res = await get(`/api/v1/actions/${randomUUID()}`, MEMBER_USER_TOKEN);
    expect(res.statusCode).toBe(404);
  });

  it('malformed action uuid → 404 (no leak via Prisma error)', async () => {
    const res = await get('/api/v1/actions/not-a-uuid', MEMBER_USER_TOKEN);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/v1/workrooms/:workroomId/actions — Slice 7 B2-e', () => {
  it('user-member → 200 + items contain seeded action', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/actions`, MEMBER_USER_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.some((it: { action_id: string }) => it.action_id === ACTION_ID)).toBe(true);
  });

  it('machine in-org → 200', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/actions`, MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(200);
  });

  it('user non-member → 403 FORBIDDEN (param-workroom shape, mirrors messages list)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/actions`, NON_MEMBER_USER_TOKEN);
    expect(res.statusCode).toBe(403);
  });

  it('user-member but missing workroom id → 404 WORKROOM_NOT_FOUND', async () => {
    const res = await get(`/api/v1/workrooms/${randomUUID()}/actions`, MEMBER_USER_TOKEN);
    expect(res.statusCode).toBe(404);
  });

  it('machine cross-org → 403 FORBIDDEN (machineAccess returns 403, not 404)', async () => {
    // requireMachineAccessToWorkroom returns 403 for org-mismatch on a known workroom.
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/actions`, OTHER_MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(403);
  });

  it('no token → 401', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/actions`);
    expect(res.statusCode).toBe(401);
  });
});
