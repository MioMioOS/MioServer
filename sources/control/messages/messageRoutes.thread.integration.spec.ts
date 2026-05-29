/**
 * S2 Task 2.4 — Thread routes — Slice 7 B2-d conversion.
 *
 * Covers S2 §4.2/§4.3/§4.4 with user_sess_ / machine unification:
 *   GET  /api/v1/workrooms/:wid/threads/:parentId
 *     - thread meta { id, parent_message_id, reply_count, last_reply_at, task_id:null }
 *     - no ControlThread row → reply_count 0, last_reply_at null
 *     - parent not found → 404
 *     - parent in an invisible (private non-member) channel → 404
 *   GET  /api/v1/workrooms/:wid/threads/:parentId/replies?after_seq=&limit=
 *     - { parent_message_id, messages:[…], has_more } ordered by seq
 *     - after_seq pagination + has_more
 *   POST /api/v1/workrooms/:wid/threads/:parentId/reply
 *     - user-owner (idempotency key required) → 201 full message with parent_message_id
 *     - machine_token → 201 (kind agent)
 *     - user non-member → 403
 *     - parent not found → 404
 *     - publishes a thread.reply event (write-before-broadcast)
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { messageRoutes } from './messageRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let PUBLIC_CHANNEL_ID = '';
let PRIVATE_CHANNEL_ID = '';
let PARENT_MSG_ID = '';
let PRIVATE_PARENT_MSG_ID = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });

function get(url: string, headers: Record<string, string> = machineHeader()) {
  return APP.inject({ method: 'GET', url, headers });
}

function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = ownerUserHeader()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

async function seedTopLevel(channelId: string, seq: number, content = `msg ${seq}`): Promise<string> {
  const id = randomUUID();
  await db.controlMessage.create({
    data: { id, workroomId: WORKROOM_ID, channelId, seq: BigInt(seq), senderKind: 'system', senderId: randomUUID(), content },
  });
  return id;
}

async function seedReply(channelId: string, parentMessageId: string, seq: number, content = `reply ${seq}`): Promise<string> {
  const id = randomUUID();
  await db.controlMessage.create({
    data: { id, workroomId: WORKROOM_ID, channelId, seq: BigInt(seq), senderKind: 'system', senderId: randomUUID(), content, parentMessageId },
  });
  return id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'ThreadSpec Org', slug: `thread-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlMachine.create({
    data: {
      id: MACHINE_ID, orgId: ORG_ID, boundAt: new Date(),
      tokenHash: sha256(MACHINE_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin', arch: 'arm64',
    },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'ThreadSpec WR', createdBy: randomUUID() },
  });

  const pubCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  PUBLIC_CHANNEL_ID = pubCh.id;

  const privCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'secret', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  PRIVATE_CHANNEL_ID = privCh.id;

  PARENT_MSG_ID = await seedTopLevel(PUBLIC_CHANNEL_ID, 1, 'public parent');
  PRIVATE_PARENT_MSG_ID = await seedTopLevel(PRIVATE_CHANNEL_ID, 1, 'private parent');

  // user_sess_ fixtures.
  const owner = await db.user.create({
    data: { email: `thread-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  OWNER_USER_ID = owner.id;
  OWNER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: OWNER_USER_ID, tokenHash: hashUserSessionToken(OWNER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.userWorkroomMembership.create({
    data: { userId: OWNER_USER_ID, workroomId: WORKROOM_ID, role: 'owner' },
  });

  const nm = await db.user.create({
    data: { email: `thread-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlThread.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.userWorkroomMembership.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.userSession.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.user.deleteMany({ where: { id: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── GET /workrooms/:wid/threads/:parentId ──────────────────────────────────────

describe('GET /api/v1/workrooms/:wid/threads/:parentId', () => {
  it('no ControlThread row → reply_count 0, last_reply_at null, task_id null', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${PARENT_MSG_ID}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(PARENT_MSG_ID);
    expect(body.parent_message_id).toBe(PARENT_MSG_ID);
    expect(body.reply_count).toBe(0);
    expect(body.last_reply_at).toBeNull();
    expect(body.task_id).toBeNull();
  });

  it('with a ControlThread row → reply_count + last_reply_at reflect it', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 100, 'parent with thread');
    const now = new Date();
    await db.controlThread.create({
      data: { parentMessageId: parentId, workroomId: WORKROOM_ID, replyCount: 3, lastReplyAt: now },
    });

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.reply_count).toBe(3);
    expect(body.last_reply_at).toBe(now.toISOString());

    await db.controlThread.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('parent not found → 404', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${randomUUID()}`);
    expect(res.statusCode).toBe(404);
  });

  it('parent in an invisible (private non-member) channel → 404', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${PRIVATE_PARENT_MSG_ID}`);
    expect(res.statusCode).toBe(404);
  });

  it('user-owner in scope → 200', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${PARENT_MSG_ID}`, ownerUserHeader());
    expect(res.statusCode).toBe(200);
  });

  it('user non-member → 403', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${PARENT_MSG_ID}`, nonMemberUserHeader());
    expect(res.statusCode).toBe(403);
  });

  it('no token → 401', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${PARENT_MSG_ID}`, {});
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /workrooms/:wid/threads/:parentId/replies ──────────────────────────────

describe('GET /api/v1/workrooms/:wid/threads/:parentId/replies', () => {
  it('returns replies ordered by seq with parent_message_id on each', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 200, 'parent for replies');
    const r1 = await seedReply(PUBLIC_CHANNEL_ID, parentId, 201, 'r1');
    const r2 = await seedReply(PUBLIC_CHANNEL_ID, parentId, 202, 'r2');
    const r3 = await seedReply(PUBLIC_CHANNEL_ID, parentId, 203, 'r3');

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/replies?after_seq=0&limit=100`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.parent_message_id).toBe(parentId);
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([r1, r2, r3]);
    for (const m of body.messages) expect(m.parent_message_id).toBe(parentId);
    expect(body.has_more).toBe(false);

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('after_seq pagination + has_more', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 300, 'parent paginate');
    await seedReply(PUBLIC_CHANNEL_ID, parentId, 301, 'p1');
    await seedReply(PUBLIC_CHANNEL_ID, parentId, 302, 'p2');
    await seedReply(PUBLIC_CHANNEL_ID, parentId, 303, 'p3');

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/replies?after_seq=301&limit=1`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(1);
    expect(Number(body.messages[0].seq)).toBe(302);
    expect(body.has_more).toBe(true);

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('parent not found → 404', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${randomUUID()}/replies`);
    expect(res.statusCode).toBe(404);
  });

  it('parent in invisible channel → 404', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${PRIVATE_PARENT_MSG_ID}/replies`);
    expect(res.statusCode).toBe(404);
  });

  it('user-owner in scope → 200', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${PARENT_MSG_ID}/replies`, ownerUserHeader());
    expect(res.statusCode).toBe(200);
  });
});

// ── POST /workrooms/:wid/threads/:parentId/reply ───────────────────────────────

describe('POST /api/v1/workrooms/:wid/threads/:parentId/reply', () => {
  it('user-owner → 201 full message with parent_message_id; replies excluded from main timeline', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 400, 'parent user reply');

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`,
      { content: 'a user reply', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.parent_message_id).toBe(parentId);
    expect(body.sender_kind).toBe('user');
    expect(body.sender_id).toBe(OWNER_USER_ID);
    expect(body.content).toBe('a user reply');
    expect(body.idempotent).toBe(false);

    // The reply must NOT appear in the main channel timeline.
    const list = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?after_seq=0&limit=100`);
    const listBody = JSON.parse(list.body);
    expect(listBody.messages.map((m: { id: string }) => m.id)).not.toContain(body.id);

    const thread = await db.controlThread.findUnique({ where: { parentMessageId: parentId } });
    expect(thread!.replyCount).toBe(1);

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlThread.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('user-owner missing client_idempotency_key → 400', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 410, 'parent user noidem');
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`,
      { content: 'no key' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(400);
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('machine_token → 201 with sender_kind agent', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 420, 'parent machine reply');
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`,
      { content: 'a machine reply' },
      machineHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.sender_kind).toBe('agent');
    expect(body.sender_id).toBe(MACHINE_ID);
    expect(body.parent_message_id).toBe(parentId);

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlThread.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('user non-member → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${PARENT_MSG_ID}/reply`,
      { content: 'should be denied', client_idempotency_key: randomUUID() },
      nonMemberUserHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('parent not found → 404', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${randomUUID()}/reply`,
      { content: 'orphan', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('publishes a thread.reply event (write-before-broadcast)', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 430, 'parent event reply');
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`,
      { content: 'event reply', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'thread.reply' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.parent_message_id).toBe(parentId);
    expect(payload.message_id).toBe(body.id);
    expect(payload.channel_id).toBe(PUBLIC_CHANNEL_ID);
    expect(payload.sender_kind).toBe('user');
    expect(typeof payload.preview).toBe('string');
    expect((payload.preview as string).length).toBeLessThanOrEqual(120);

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlThread.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('idempotent replay does not double-bump (returns idempotent:true, no new event)', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 440, 'parent idem reply');
    const key = randomUUID();
    const url = `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`;

    const first = await post(url, { content: 'idem reply', client_idempotency_key: key }, ownerUserHeader());
    expect(first.statusCode).toBe(201);
    const b1 = JSON.parse(first.body);
    expect(b1.idempotent).toBe(false);

    const second = await post(url, { content: 'idem reply', client_idempotency_key: key }, ownerUserHeader());
    expect(second.statusCode).toBe(201);
    const b2 = JSON.parse(second.body);
    expect(b2.idempotent).toBe(true);
    expect(b2.id).toBe(b1.id);

    const thread = await db.controlThread.findUnique({ where: { parentMessageId: parentId } });
    expect(thread!.replyCount).toBe(1);

    const events = await db.controlEventLog.count({
      where: { workroomId: WORKROOM_ID, topic: 'thread.reply', payloadJson: { path: ['message_id'], equals: b1.id } },
    });
    expect(events).toBe(1);

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlThread.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });
});
