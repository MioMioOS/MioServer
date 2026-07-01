/**
 * Human members API + member-role messaging (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/members/humanMemberRoutes.integration.spec.ts
 *
 * Covers the multi-user fix (2026-06-12):
 *   - POST   /workrooms/:wid/human-members — owner invites a registered user by email
 *   - GET    /workrooms/:wid/human-members — any member lists humans (owner + member rows)
 *   - DELETE /workrooms/:wid/human-members/:userId — owner removes a member; owners protected
 *   - relaxed write gate: an invited role='member' user can POST a message (was owner-only 403)
 *   - read access: an invited member can GET channel messages; a removed member loses access
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { humanMemberRoutes } from './humanMemberRoutes.js';
import { messageRoutes } from '@/control/messages/messageRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const CHANNEL_ID = randomUUID();

let app: FastifyInstance;

let OWNER_ID = '';
let OWNER_TOKEN = '';
let INVITEE_ID = '';
let INVITEE_EMAIL = '';
let INVITEE_TOKEN = '';
let STRANGER_ID = '';
let STRANGER_TOKEN = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const HM_URL = `/api/v1/workrooms/${WORKROOM_ID}/human-members`;
const MSG_URL = `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/messages`;

async function seedUser(prefix: string): Promise<{ id: string; email: string; token: string }> {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const user = await db.user.create({ data: { email, passwordHash: await hashPassword('p') } });
  const token = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: user.id, tokenHash: hashUserSessionToken(token), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { id: user.id, email, token };
}

beforeAll(async () => {
  app = fastify();
  await app.register(humanMemberRoutes);
  await app.register(messageRoutes);
  await app.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'HM Spec Org', slug: `hm-spec-${randomUUID()}`, ownerUserId: randomUUID(), billingPlan: 'free' },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'HM Spec WR', visibility: 'private', createdBy: randomUUID() },
  });
  await db.controlChannel.create({
    data: { id: CHANNEL_ID, workroomId: WORKROOM_ID, name: 'general', type: 'standard', visibility: 'public', createdBy: 'system' },
  });

  const owner = await seedUser('hm-owner');
  OWNER_ID = owner.id;
  OWNER_TOKEN = owner.token;
  await db.userWorkroomMembership.create({ data: { userId: OWNER_ID, workroomId: WORKROOM_ID, role: 'owner' } });

  const invitee = await seedUser('hm-invitee');
  INVITEE_ID = invitee.id;
  INVITEE_EMAIL = invitee.email;
  INVITEE_TOKEN = invitee.token;

  const stranger = await seedUser('hm-stranger');
  STRANGER_ID = stranger.id;
  STRANGER_TOKEN = stranger.token;
});

afterAll(async () => {
  await db.controlThread.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.userWorkroomMembership.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.userSession.deleteMany({ where: { userId: { in: [OWNER_ID, INVITEE_ID, STRANGER_ID] } } });
  await db.user.deleteMany({ where: { id: { in: [OWNER_ID, INVITEE_ID, STRANGER_ID] } } });
  await app.close();
  await db.$disconnect();
});

describe('POST /workrooms/:wid/human-members (invite)', () => {
  it('non-member cannot invite → 403', async () => {
    const res = await app.inject({ method: 'POST', url: HM_URL, headers: auth(STRANGER_TOKEN), payload: { email: INVITEE_EMAIL } });
    expect(res.statusCode).toBe(403);
  });

  it('unknown email → 404 USER_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'POST', url: HM_URL, headers: auth(OWNER_TOKEN), payload: { email: `nobody-${randomUUID()}@example.test` } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('USER_NOT_FOUND');
  });

  it('missing email → 400', async () => {
    const res = await app.inject({ method: 'POST', url: HM_URL, headers: auth(OWNER_TOKEN), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('owner invites registered user (case-insensitive email) → 201 role=member + membership row', async () => {
    const res = await app.inject({
      method: 'POST', url: HM_URL, headers: auth(OWNER_TOKEN),
      payload: { email: INVITEE_EMAIL.toUpperCase() },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.human_member.user_id).toBe(INVITEE_ID);
    expect(body.human_member.role).toBe('member');
    expect(typeof body.human_member.avatar).toBe('string');
    const row = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: INVITEE_ID, workroomId: WORKROOM_ID } },
    });
    expect(row?.role).toBe('member');
  });

  it('duplicate invite → 409 ALREADY_MEMBER', async () => {
    const res = await app.inject({ method: 'POST', url: HM_URL, headers: auth(OWNER_TOKEN), payload: { email: INVITEE_EMAIL } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_MEMBER');
  });

  it("invited member (role=member) cannot invite others → 403 owner gate", async () => {
    const res = await app.inject({ method: 'POST', url: HM_URL, headers: auth(INVITEE_TOKEN), payload: { email: `x-${randomUUID()}@example.test` } });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /workrooms/:wid/human-members (list)', () => {
  it('member lists humans → owner + invited member with roles', async () => {
    const res = await app.inject({ method: 'GET', url: HM_URL, headers: auth(INVITEE_TOKEN) });
    expect(res.statusCode).toBe(200);
    const members = res.json().human_members as Array<{ user_id: string; role: string }>;
    const byId = new Map(members.map((m) => [m.user_id, m.role]));
    expect(byId.get(OWNER_ID)).toBe('owner');
    expect(byId.get(INVITEE_ID)).toBe('member');
  });

  it('non-member → 403', async () => {
    const res = await app.inject({ method: 'GET', url: HM_URL, headers: auth(STRANGER_TOKEN) });
    expect(res.statusCode).toBe(403);
  });
});

describe('relaxed write gate — invited member can use the messaging plane', () => {
  it('member POST message to public channel → 201 (was owner-only 403)', async () => {
    const res = await app.inject({
      method: 'POST', url: MSG_URL, headers: auth(INVITEE_TOKEN),
      payload: { content: 'hello from invited member', client_idempotency_key: randomUUID() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sender_id).toBe(INVITEE_ID);
  });

  it('member GET messages → 200 and sees own message', async () => {
    const res = await app.inject({ method: 'GET', url: MSG_URL, headers: auth(INVITEE_TOKEN) });
    expect(res.statusCode).toBe(200);
    const contents = (res.json().messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toContain('hello from invited member');
  });

  it('non-member still 403 on both read and write', async () => {
    const r1 = await app.inject({ method: 'GET', url: MSG_URL, headers: auth(STRANGER_TOKEN) });
    expect(r1.statusCode).toBe(403);
    const r2 = await app.inject({
      method: 'POST', url: MSG_URL, headers: auth(STRANGER_TOKEN),
      payload: { content: 'nope', client_idempotency_key: randomUUID() },
    });
    expect(r2.statusCode).toBe(403);
  });
});

describe('DELETE /workrooms/:wid/human-members/:userId (remove)', () => {
  it('member cannot remove → 403 owner gate', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${HM_URL}/${OWNER_ID}`, headers: auth(INVITEE_TOKEN) });
    expect(res.statusCode).toBe(403);
  });

  it('owner cannot be removed → 403 CANNOT_REMOVE_OWNER', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${HM_URL}/${OWNER_ID}`, headers: auth(OWNER_TOKEN) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CANNOT_REMOVE_OWNER');
  });

  it('owner removes member → ok; removed member loses read; re-remove → 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${HM_URL}/${INVITEE_ID}`, headers: auth(OWNER_TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const read = await app.inject({ method: 'GET', url: MSG_URL, headers: auth(INVITEE_TOKEN) });
    expect(read.statusCode).toBe(403);

    const again = await app.inject({ method: 'DELETE', url: `${HM_URL}/${INVITEE_ID}`, headers: auth(OWNER_TOKEN) });
    expect(again.statusCode).toBe(404);
  });
});
