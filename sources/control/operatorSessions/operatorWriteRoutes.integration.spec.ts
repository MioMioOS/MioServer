/**
 * Operator write endpoints — REAL Postgres integration tests (Slice 7 B2-e).
 *
 * Replaces the legacy op_sess_-only matrix with the unified user_sess_ / machine_token
 * auth model. The route surface (URL + body + JSON shape) is unchanged from #97.
 *
 * Matrix covered:
 *   - user-owner acknowledge / mark-reviewed → 200 + mutation + audit row
 *   - machine_token acknowledge → 200 (machine path preserved)
 *   - user non-member action → 404 ACTION_NOT_FOUND (derived-workroom anti-enum)
 *   - user member but role !== 'owner' → 403 (role gate after membership check)
 *   - machine cross-org → 404 ACTION_NOT_FOUND (derived-workroom anti-enum)
 *   - no token / invalid token → 401 BEFORE any action lookup (anti-enum existence)
 *   - missing client_idempotency_key → 400
 *   - non-existent action with valid auth → 404 ACTION_NOT_FOUND
 *   - approve / retry (user-owner) → 422 COMMAND_NOT_IN_V1 (helper V1-gate intact)
 *   - acknowledge on non-needs_human action → 409 ACTION_WRONG_STATUS
 *   - duplicate idempotency key → 409 DUPLICATE_IDEMPOTENCY_KEY
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { operatorWriteRoutes } from './operatorWriteRoutes.js';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();         // belongs to OTHER_ORG_ID
const AGENT_ID = randomUUID();
const SESSION_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let MEMBER_USER_ID = '';
let MEMBER_USER_TOKEN = '';   // role: 'guest' — not 'owner'

let app: FastifyInstance;

async function seedAction(opts: { workroomId?: string; status?: string }): Promise<string> {
  const id = randomUUID();
  await db.controlAction.create({
    data: {
      id,
      sessionId: SESSION_ID,
      workroomId: opts.workroomId ?? WORKROOM_ID,
      actorAgentId: AGENT_ID,
      kind: 'other',
      summary: 'op-write test action',
      reversibility: 'reversible',
      riskLevel: 'low',
      requiresApproval: false,
      status: opts.status ?? 'needs_human',
      clientIdempotencyKey: `idem-${randomUUID()}`,
    },
  });
  return id;
}

function post(
  actionId: string,
  segment: string,
  token?: string,
  body: unknown = { client_idempotency_key: randomUUID() },
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/actions/${actionId}/${segment}`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    payload: body as object,
  });
}

beforeAll(async () => {
  app = fastify();
  await app.register(operatorWriteRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'OpW Org', slug: `opw-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlOrg.create({ data: { id: OTHER_ORG_ID, name: 'OpW Other', slug: `opw-other-${randomUUID()}`, ownerUserId: randomUUID() } });

  await db.controlAgent.create({
    data: { id: AGENT_ID, orgId: ORG_ID, name: 'opw-agent', displayName: 'OpW Agent', role: 'ops' },
  });

  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'WR primary', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM_ID, orgId: OTHER_ORG_ID, name: 'WR other', createdBy: randomUUID() } });

  await db.controlSession.create({
    data: {
      id: SESSION_ID, orgId: ORG_ID, workroomId: WORKROOM_ID, machineId: null,
      mode: 'daemon', runtime: 'claude', displayName: 'opw-session',
    },
  });

  // Machines: one bound to primary org, one bound to other org (for cross-org test).
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

  // Users: owner (writes pass), guest-member (writes 403), non-member (writes 404).
  const owner = await db.user.create({
    data: { email: `opw-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  OWNER_USER_ID = owner.id;
  OWNER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: OWNER_USER_ID, tokenHash: hashUserSessionToken(OWNER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.userWorkroomMembership.create({ data: { userId: OWNER_USER_ID, workroomId: WORKROOM_ID, role: 'owner' } });

  const member = await db.user.create({
    data: { email: `opw-member-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  MEMBER_USER_ID = member.id;
  MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: MEMBER_USER_ID, tokenHash: hashUserSessionToken(MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.userWorkroomMembership.create({ data: { userId: MEMBER_USER_ID, workroomId: WORKROOM_ID, role: 'guest' } });

  const nm = await db.user.create({
    data: { email: `opw-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
});

afterAll(async () => {
  await db.controlOperatorAuditLog.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlEventLog.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlAction.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlSession.deleteMany({ where: { id: SESSION_ID } });
  await db.userWorkroomMembership.deleteMany({
    where: { userId: { in: [OWNER_USER_ID, MEMBER_USER_ID, NON_MEMBER_USER_ID] } },
  });
  await db.userSession.deleteMany({
    where: { userId: { in: [OWNER_USER_ID, MEMBER_USER_ID, NON_MEMBER_USER_ID] } },
  });
  await db.user.deleteMany({ where: { id: { in: [OWNER_USER_ID, MEMBER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await app.close();
  await db.$disconnect();
});

describe('operatorWriteRoutes Slice 7 B2-e — success path', () => {
  it('user-owner acknowledge: needs_human → 200 + operatorAcknowledgedAt set + audit row', async () => {
    const id = await seedAction({ status: 'needs_human' });
    const res = await post(id, 'acknowledge', OWNER_USER_TOKEN);
    expect(res.statusCode).toBe(200);

    const action = await db.controlAction.findUnique({ where: { id } });
    expect(action!.operatorAcknowledgedAt).not.toBeNull();

    const audit = await db.controlOperatorAuditLog.findMany({ where: { actionId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].commandKey).toBe('acknowledge_needs_human');
    expect(audit[0].operatorSubjectId).toBe(OWNER_USER_ID);  // subjectId = user.id on user path
  });

  it('user-owner mark-reviewed: succeeded → 200', async () => {
    const id = await seedAction({ status: 'succeeded' });
    const res = await post(id, 'mark-reviewed', OWNER_USER_TOKEN);
    expect(res.statusCode).toBe(200);
    expect((await db.controlAction.findUnique({ where: { id } }))!.operatorReviewedAt).not.toBeNull();
  });

  it('machine_token acknowledge: needs_human → 200 (machine fallback preserved)', async () => {
    const id = await seedAction({ status: 'needs_human' });
    const res = await post(id, 'acknowledge', MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(200);

    const audit = await db.controlOperatorAuditLog.findMany({ where: { actionId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].operatorSubjectId).toBe(MACHINE_ID);  // subjectId = machine.id on machine path
  });
});

describe('operatorWriteRoutes Slice 7 B2-e — auth / anti-enumeration (401/400)', () => {
  it('no token on existent action → 401 (auth BEFORE action lookup)', async () => {
    const id = await seedAction({});
    expect((await post(id, 'acknowledge', undefined)).statusCode).toBe(401);
  });

  it('no token on non-existent action id → 401 (uniform with existent — no leak)', async () => {
    expect((await post(randomUUID(), 'acknowledge', undefined)).statusCode).toBe(401);
  });

  it('garbage non-prefix token → 401', async () => {
    const id = await seedAction({});
    expect((await post(id, 'acknowledge', 'totally-invalid-token')).statusCode).toBe(401);
  });

  it('expired user_sess_ token → 401', async () => {
    const expiredUser = await db.user.create({
      data: { email: `opw-exp-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
    });
    const expiredTok = mintUserSessionToken();
    await db.userSession.create({
      data: {
        userId: expiredUser.id,
        tokenHash: hashUserSessionToken(expiredTok),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const id = await seedAction({});
    expect((await post(id, 'acknowledge', expiredTok)).statusCode).toBe(401);

    await db.userSession.deleteMany({ where: { userId: expiredUser.id } });
    await db.user.delete({ where: { id: expiredUser.id } });
  });

  it('missing client_idempotency_key → 400', async () => {
    const id = await seedAction({});
    expect((await post(id, 'acknowledge', OWNER_USER_TOKEN, {})).statusCode).toBe(400);
  });
});

describe('operatorWriteRoutes Slice 7 B2-e — scope / role (404 / 403)', () => {
  it('user non-member action workroom → 404 ACTION_NOT_FOUND (derived-workroom anti-enum)', async () => {
    const id = await seedAction({ status: 'needs_human' });
    expect((await post(id, 'acknowledge', NON_MEMBER_USER_TOKEN)).statusCode).toBe(404);
  });

  it('user is workroom member but role !== owner → 403 (role gate after membership)', async () => {
    const id = await seedAction({ status: 'needs_human' });
    expect((await post(id, 'acknowledge', MEMBER_USER_TOKEN)).statusCode).toBe(403);
  });

  it('machine cross-org action → 404 ACTION_NOT_FOUND (uniform with user non-member)', async () => {
    // Seed an action in the OTHER workroom (other org). MACHINE_RAW_TOKEN is bound to primary org.
    const id = await seedAction({ workroomId: OTHER_WORKROOM_ID, status: 'needs_human' });
    expect((await post(id, 'acknowledge', MACHINE_RAW_TOKEN)).statusCode).toBe(404);
  });

  it('non-existent action with valid user-owner auth → 404 ACTION_NOT_FOUND', async () => {
    expect((await post(randomUUID(), 'acknowledge', OWNER_USER_TOKEN)).statusCode).toBe(404);
  });
});

describe('operatorWriteRoutes Slice 7 B2-e — command / status (422 / 409)', () => {
  it('approve as user-owner → 422 COMMAND_NOT_IN_V1 (helper V1-gate intact)', async () => {
    const id = await seedAction({ status: 'proposed' });
    expect((await post(id, 'approve', OWNER_USER_TOKEN)).statusCode).toBe(422);
  });

  it('retry as user-owner → 422 COMMAND_NOT_IN_V1', async () => {
    const id = await seedAction({ status: 'failed' });
    expect((await post(id, 'retry', OWNER_USER_TOKEN)).statusCode).toBe(422);
  });

  it('acknowledge on non-needs_human action → 409 wrong-status', async () => {
    const id = await seedAction({ status: 'succeeded' });
    expect((await post(id, 'acknowledge', OWNER_USER_TOKEN)).statusCode).toBe(409);
  });

  it('duplicate idempotency key → 409, exactly one audit row', async () => {
    const id = await seedAction({ status: 'needs_human' });
    const key = randomUUID();
    const r1 = await post(id, 'acknowledge', OWNER_USER_TOKEN, { client_idempotency_key: key });
    expect(r1.statusCode).toBe(200);
    const r2 = await post(id, 'acknowledge', OWNER_USER_TOKEN, { client_idempotency_key: key });
    expect(r2.statusCode).toBe(409);
    const audit = await db.controlOperatorAuditLog.findMany({ where: { actionId: id } });
    expect(audit).toHaveLength(1);
  });
});
