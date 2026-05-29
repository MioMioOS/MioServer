/**
 * Message WRITE endpoint — Slice 7 B2-d (user_sess_ / machine unification).
 *
 * Covers POST /api/v1/workrooms/:wid/channels/:cid/messages:
 *   - user-owner send: OK (201)
 *   - machine send: OK (201)
 *   - user non-member → 403
 *   - private non-member → 403
 *   - idempotent replay (user) returns same message (idempotent:true)
 *   - user missing client_idempotency_key → 400
 *   - machine omit key: two sends → two distinct messages (no collision)
 *   - event message.created published write-before-broadcast (event row exists post-send)
 *   - preview is redacted + truncated to ≤120 chars
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
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });

function post(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = ownerUserHeader(),
) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'WriteMsgSpec Org', slug: `write-msg-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlMachine.create({
    data: {
      id: MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(MACHINE_RAW_TOKEN),
      tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin',
      arch: 'arm64',
    },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'WriteMsgSpec WR', createdBy: randomUUID() },
  });

  const pubCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  PUBLIC_CHANNEL_ID = pubCh.id;

  const privCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'secret', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  PRIVATE_CHANNEL_ID = privCh.id;

  // user_sess_ fixtures: an OWNER (writes pass) + a NON-MEMBER (writes 403).
  const owner = await db.user.create({
    data: { email: `write-msg-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
    data: { email: `write-msg-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
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

// ── POST /api/v1/workrooms/:wid/channels/:cid/messages ────────────────────────

describe('POST /api/v1/workrooms/:wid/channels/:cid/messages (Slice 7 B2-d)', () => {
  it('user-owner send: returns 201 with id, seq, created_at, idempotent:false', async () => {
    const key = randomUUID();
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Hello from user-owner', client_idempotency_key: key },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('seq');
    expect(body).toHaveProperty('created_at');
    expect(body.idempotent).toBe(false);
  });

  it('user-owner send: 201 returns the FULL message wire shape', async () => {
    const key = randomUUID();
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Full shape from user', client_idempotency_key: key },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('seq');
    expect(body).toHaveProperty('created_at');
    expect(body.idempotent).toBe(false);
    expect(body.sender_kind).toBe('user');
    expect(body.sender_id).toBe(OWNER_USER_ID);
    expect(body.content).toBe('Full shape from user');
    expect(body).toHaveProperty('sender_display_name');
    expect(body).toHaveProperty('mentions');
    expect(body).toHaveProperty('embedded_card_type');
    expect(body).toHaveProperty('embedded_card_id');
    expect(body).toHaveProperty('thread_reply_count');
    expect(body).toHaveProperty('parent_message_id');
    expect(body.parent_message_id).toBeNull();
  });

  it('machine send: returns 201 with id, seq, created_at, idempotent:false', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Hello from machine' },
      machineHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('seq');
    expect(body.idempotent).toBe(false);
  });

  it('machine send: 201 returns the FULL message wire shape', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Full shape from machine' },
      machineHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('seq');
    expect(body.idempotent).toBe(false);
    expect(body.sender_kind).toBe('agent');
    expect(body.sender_id).toBe(MACHINE_ID);
    expect(body.content).toBe('Full shape from machine');
    expect(body).toHaveProperty('sender_display_name');
    expect(body).toHaveProperty('mentions');
    expect(body).toHaveProperty('parent_message_id');
    expect(body.parent_message_id).toBeNull();
  });

  it('user non-member → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Should be denied', client_idempotency_key: randomUUID() },
      nonMemberUserHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('private channel non-member → 403', async () => {
    // The user IS a workroom owner but is not an explicit member of the private channel.
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PRIVATE_CHANNEL_ID}/messages`,
      { content: 'Should be denied', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
  });

  it('idempotent replay: same client_idempotency_key returns same message (idempotent:true)', async () => {
    const key = randomUUID();
    const body = { content: 'Idempotent message', client_idempotency_key: key };
    const url = `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`;

    const res1 = await post(url, body, ownerUserHeader());
    expect(res1.statusCode).toBe(201);
    const b1 = JSON.parse(res1.body);
    expect(b1.idempotent).toBe(false);

    const res2 = await post(url, body, ownerUserHeader());
    expect(res2.statusCode).toBe(201);
    const b2 = JSON.parse(res2.body);
    expect(b2.idempotent).toBe(true);

    expect(b2.id).toBe(b1.id);
    expect(b2.seq).toBe(b1.seq);
  });

  it('user missing client_idempotency_key → 400', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'No key provided' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('machine omit key: two sends → two distinct messages (no collision)', async () => {
    const url = `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`;
    const bodyTemplate = { content: 'Machine message no key' };

    const res1 = await post(url, bodyTemplate, machineHeader());
    const res2 = await post(url, bodyTemplate, machineHeader());

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    const b1 = JSON.parse(res1.body);
    const b2 = JSON.parse(res2.body);

    expect(b1.id).not.toBe(b2.id);
    expect(b1.seq).not.toBe(b2.seq);
  });

  it('event message.created is written to DB (write-before-broadcast) after send', async () => {
    const key = randomUUID();
    const content = 'Event write-before-broadcast test';

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content, client_idempotency_key: key },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const msgBody = JSON.parse(res.body);

    const event = await db.controlEventLog.findFirst({
      where: {
        workroomId: WORKROOM_ID,
        topic: 'message.created',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(msgBody.id);
    expect(payload.channel_id).toBe(PUBLIC_CHANNEL_ID);
    expect(payload.seq).toBe(msgBody.seq);
    expect(payload.sender_kind).toBe('user');
    expect(payload.sender_id).toBe(OWNER_USER_ID);
    expect(typeof payload.preview).toBe('string');
    expect((payload.preview as string).length).toBeLessThanOrEqual(120);
  });

  it('preview in event payload is redacted (token shapes replaced with [REDACTED])', async () => {
    // Use a token shape known to redactControlText. op_sess_ remains in the redactor's
    // pattern list (legacy shape — defense in depth even after Slice 7 dropped the token).
    const sensitiveToken = 'op_sess_SECRETTOKEN123';
    const content = `Message with secret: ${sensitiveToken}`;
    const key = randomUUID();

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content, client_idempotency_key: key },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const msgBody = JSON.parse(res.body);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'message.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(msgBody.id);
    expect(payload.preview as string).not.toContain(sensitiveToken);
    expect(payload.preview as string).toContain('[REDACTED]');
  });

  it('preview is truncated to ≤120 chars', async () => {
    const longContent = 'A'.repeat(300);
    const key = randomUUID();

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: longContent, client_idempotency_key: key },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const msgBody = JSON.parse(res.body);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'message.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(msgBody.id);
    expect((payload.preview as string).length).toBeLessThanOrEqual(120);
  });

  it('no auth → 401', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'No auth', client_idempotency_key: randomUUID() },
      {},
    );
    expect(res.statusCode).toBe(401);
  });

  it('channel not in workroom → 404', async () => {
    const otherWrId = randomUUID();
    await db.controlWorkroom.create({
      data: { id: otherWrId, orgId: ORG_ID, name: 'Other WR', createdBy: randomUUID() },
    });
    // The user must be an owner of the OTHER workroom for the write-auth to pass; otherwise
    // the route fails at auth (403) before reaching the channel-scope 404. Mirror this.
    await db.userWorkroomMembership.create({
      data: { userId: OWNER_USER_ID, workroomId: otherWrId, role: 'owner' },
    });
    const otherCh = await db.controlChannel.create({
      data: { workroomId: otherWrId, name: 'other-ch', type: 'main', visibility: 'public', createdBy: 'system' },
    });

    // cid belongs to otherWrId, posting to WORKROOM_ID/.../otherCh → channel not in workroom (404).
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${otherCh.id}/messages`,
      { content: 'Wrong workroom', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(404);

    // cleanup
    await db.controlChannel.deleteMany({ where: { id: otherCh.id } });
    await db.userWorkroomMembership.deleteMany({ where: { userId: OWNER_USER_ID, workroomId: otherWrId } });
    await db.controlWorkroom.deleteMany({ where: { id: otherWrId } });
  });

  it('seq increments monotonically across sends', async () => {
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'seq-mono-test', type: 'standard', visibility: 'public', createdBy: 'system' },
    });

    const res1 = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'seq1', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    const res2 = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'seq2', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    const res3 = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'seq3', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res3.statusCode).toBe(201);

    const s1 = Number(JSON.parse(res1.body).seq);
    const s2 = Number(JSON.parse(res2.body).seq);
    const s3 = Number(JSON.parse(res3.body).seq);

    expect(s1).toBeLessThan(s2);
    expect(s2).toBeLessThan(s3);

    await db.controlMessage.deleteMany({ where: { channelId: ch.id } });
    await db.controlChannel.deleteMany({ where: { id: ch.id } });
  });

  it('lastActivityAt on channel advances after a send (I2)', async () => {
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'last-activity-test', type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const before = await db.controlChannel.findUnique({ where: { id: ch.id }, select: { lastActivityAt: true } });
    expect(before!.lastActivityAt).toBeNull();

    const t0 = new Date();
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'bump last_activity_at', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);

    const after = await db.controlChannel.findUnique({ where: { id: ch.id }, select: { lastActivityAt: true } });
    expect(after!.lastActivityAt).not.toBeNull();
    expect(after!.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(t0.getTime());

    const lastBefore2nd = after!.lastActivityAt!;
    const res2 = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'bump again', client_idempotency_key: randomUUID() },
      ownerUserHeader(),
    );
    expect(res2.statusCode).toBe(201);

    const after2 = await db.controlChannel.findUnique({ where: { id: ch.id }, select: { lastActivityAt: true } });
    expect(after2!.lastActivityAt).not.toBeNull();
    expect(after2!.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(lastBefore2nd.getTime());

    await db.controlMessage.deleteMany({ where: { channelId: ch.id } });
    await db.controlChannel.deleteMany({ where: { id: ch.id } });
  });
});
