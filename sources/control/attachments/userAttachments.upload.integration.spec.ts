/**
 * S8 — Human attachment upload + send-with-attachments integration tests.
 *
 * Endpoints under test:
 *   POST /api/v1/workrooms/:wid/channels/:cid/attachments   (user_sess_ upload)
 *   POST /api/v1/workrooms/:wid/channels/:cid/messages      (attachment_ids pass-through)
 *
 * Run: npm run test:integration -- sources/control/attachments
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';
import { userAttachments } from './userAttachments';
import { messageRoutes } from '@/control/messages/messageRoutes';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const CHANNEL_ID = randomUUID();
const PRIVATE_CHANNEL_ID = randomUUID();

let app: FastifyInstance;
let MEMBER_ID = '';
let MEMBER_TOKEN = '';
let OTHER_MEMBER_ID = '';
let OTHER_MEMBER_TOKEN = '';
let STRANGER_TOKEN = '';
let STRANGER_ID = '';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';

const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const UP_URL = `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/attachments`;
const MSG_URL = `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/messages`;

async function seedUser(prefix: string): Promise<{ id: string; token: string }> {
  const user = await db.user.create({
    data: { email: `${prefix}-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  const token = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: user.id, tokenHash: hashUserSessionToken(token), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { id: user.id, token };
}

beforeAll(async () => {
  app = fastify();
  await app.register(userAttachments);
  await app.register(messageRoutes);
  await app.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'UpSpec Org', slug: `up-spec-${randomUUID()}`, ownerUserId: randomUUID(), billingPlan: 'free' },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'UpSpec WR', visibility: 'private', createdBy: randomUUID() },
  });
  await db.controlChannel.create({
    data: { id: CHANNEL_ID, workroomId: WORKROOM_ID, name: 'general', type: 'standard', visibility: 'public', createdBy: 'system' },
  });
  await db.controlChannel.create({
    data: { id: PRIVATE_CHANNEL_ID, workroomId: WORKROOM_ID, name: 'secret', type: 'standard', visibility: 'private', createdBy: 'system' },
  });

  const member = await seedUser('up-member');
  MEMBER_ID = member.id; MEMBER_TOKEN = member.token;
  await db.userWorkroomMembership.create({ data: { userId: MEMBER_ID, workroomId: WORKROOM_ID, role: 'owner' } });

  const other = await seedUser('up-other');
  OTHER_MEMBER_ID = other.id; OTHER_MEMBER_TOKEN = other.token;
  await db.userWorkroomMembership.create({ data: { userId: OTHER_MEMBER_ID, workroomId: WORKROOM_ID, role: 'member' } });

  const stranger = await seedUser('up-stranger');
  STRANGER_ID = stranger.id; STRANGER_TOKEN = stranger.token;
});

afterAll(async () => {
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAttachment.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.userWorkroomMembership.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.userSession.deleteMany({ where: { userId: { in: [MEMBER_ID, OTHER_MEMBER_ID, STRANGER_ID] } } });
  await db.user.deleteMany({ where: { id: { in: [MEMBER_ID, OTHER_MEMBER_ID, STRANGER_ID] } } });
  await app.close();
});

function upload(body: Record<string, unknown>, token = MEMBER_TOKEN, url = UP_URL) {
  return app.inject({ method: 'POST', url, headers: auth(token), payload: JSON.stringify(body) });
}
const validBody = { filename: 'pixel.png', mime_type: 'image/png', data_base64: TINY_PNG_BASE64 };

describe('POST /api/v1/workrooms/:wid/channels/:cid/attachments', () => {
  it('uploads for a member and persists uploaderKind=user', async () => {
    const res = await upload(validBody);
    expect(res.statusCode).toBe(201);
    const json = res.json() as { attachment_id: string; size_bytes: number };
    expect(json.attachment_id).toBeTruthy();
    expect(json.size_bytes).toBeGreaterThan(0);
    const row = await db.controlAttachment.findUnique({ where: { id: json.attachment_id } });
    expect(row?.uploaderKind).toBe('user');
    expect(row?.uploaderId).toBe(MEMBER_ID);
    expect(row?.workroomId).toBe(WORKROOM_ID);
    expect(row?.channelId).toBe(CHANNEL_ID);
  });

  it('403 for a non-member', async () => {
    const res = await upload(validBody, STRANGER_TOKEN);
    expect(res.statusCode).toBe(403);
  });

  it('415 for non-image mime', async () => {
    const res = await upload({ ...validBody, mime_type: 'application/pdf' });
    expect(res.statusCode).toBe(415);
  });

  it('400 for missing data', async () => {
    const res = await upload({ filename: 'x.png', mime_type: 'image/png' });
    expect(res.statusCode).toBe(400);
  });

  it('404 for a channel outside the workroom', async () => {
    const res = await upload(validBody, MEMBER_TOKEN,
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${randomUUID()}/attachments`);
    expect(res.statusCode).toBe(404);
  });
});

describe('POST messages with attachment_ids (user sender)', () => {
  async function uploadOne(token = MEMBER_TOKEN): Promise<string> {
    const res = await upload(validBody, token);
    expect(res.statusCode).toBe(201);
    return (res.json() as { attachment_id: string }).attachment_id;
  }
  function send(body: Record<string, unknown>, token = MEMBER_TOKEN) {
    return app.inject({
      method: 'POST', url: MSG_URL, headers: auth(token),
      payload: JSON.stringify({ client_idempotency_key: randomUUID(), ...body }),
    });
  }

  it('persists attachment_ids and returns inline attachment metadata', async () => {
    const aid = await uploadOne();
    const res = await send({ content: 'with picture', attachment_ids: [aid] });
    expect(res.statusCode).toBe(201);
    const json = res.json() as { attachment_ids: string[]; attachments: Array<{ id: string }> };
    expect(json.attachment_ids).toEqual([aid]);
    expect(json.attachments.map((a) => a.id)).toEqual([aid]);
  });

  it("403 when attaching someone else's upload", async () => {
    const aid = await uploadOne(OTHER_MEMBER_TOKEN);
    const res = await send({ content: 'stealing', attachment_ids: [aid] });
    expect(res.statusCode).toBe(403);
  });

  it('404 for unknown attachment id', async () => {
    const res = await send({ content: 'ghost', attachment_ids: [randomUUID()] });
    expect(res.statusCode).toBe(404);
  });

  it('400 for non-array attachment_ids', async () => {
    const res = await send({ content: 'bad', attachment_ids: 'nope' });
    expect(res.statusCode).toBe(400);
  });
});
