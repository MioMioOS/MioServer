/**
 * Integration (Task #121 S2 + mark-all-read): human (cuid) mention plumbing end-to-end.
 *
 * Exercises the NEW behavior this task adds:
 *   1. A user owner POSTs a message that @-mentions another HUMAN user (cuid id) →
 *      the cuid lands in control_messages.user_mentions (NOT mentions), and the
 *      mentioned user's GET /activity?filter=mentions surfaces it with the deep-link
 *      enrichment fields (type=mention_human, workroom_id, channel_id, thread_id, title, body).
 *   2. POST /activity/read-all marks all the viewer's matched items handled in one shot.
 *
 * DB-backed (real Prisma). Uses the same user_sess_ token shape as the rest of the suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { messageRoutes } from '@/control/messages/messageRoutes';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

let APP: FastifyInstance;

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const CHANNEL_ID = randomUUID();

// Two HUMAN users (cuid ids — created by Prisma default).
let senderUserId: string;
let mentionedUserId: string;
let SENDER_RAW = '';
let MENTIONED_RAW = '';

const hdr = (raw: string) => ({ authorization: `Bearer ${raw}`, 'content-type': 'application/json' });
const post = (url: string, body: Record<string, unknown>, raw: string) =>
  APP.inject({ method: 'POST', url, headers: hdr(raw), payload: JSON.stringify(body) });
const get = (url: string, raw: string) => APP.inject({ method: 'GET', url, headers: hdr(raw) });

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'HumanMention Org', slug: `hm-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'HM WR', createdBy: randomUUID() },
  });
  await db.controlChannel.create({
    data: { id: CHANNEL_ID, workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'op-test' },
  });

  const sender = await db.user.create({
    data: { email: `sender-${randomUUID()}@t.dev`, passwordHash: 'x', displayName: 'Sender' },
  });
  const mentioned = await db.user.create({
    data: { email: `mentioned-${randomUUID()}@t.dev`, passwordHash: 'x', displayName: 'Mentioned' },
  });
  senderUserId = sender.id;
  mentionedUserId = mentioned.id;

  // Both are workroom owners (write requires owner; read requires membership).
  await db.userWorkroomMembership.createMany({
    data: [
      { userId: senderUserId, workroomId: WORKROOM_ID, role: 'owner' },
      { userId: mentionedUserId, workroomId: WORKROOM_ID, role: 'owner' },
    ],
  });

  SENDER_RAW = mintUserSessionToken();
  MENTIONED_RAW = mintUserSessionToken();
  const exp = new Date(Date.now() + 24 * 3600_000);
  await db.userSession.createMany({
    data: [
      { userId: senderUserId, tokenHash: hashUserSessionToken(SENDER_RAW), expiresAt: exp },
      { userId: mentionedUserId, tokenHash: hashUserSessionToken(MENTIONED_RAW), expiresAt: exp },
    ],
  });
});

afterAll(async () => {
  await db.controlActivityState.deleteMany({ where: { subjectId: { in: [senderUserId, mentionedUserId] } } });
  // message-create writes a control_event_logs row (writeEventAndBroadcast) that FK-references
  // the workroom; delete it before the workroom so the teardown does not violate the FK.
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.userSession.deleteMany({ where: { userId: { in: [senderUserId, mentionedUserId] } } });
  await db.userWorkroomMembership.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.user.deleteMany({ where: { id: { in: [senderUserId, mentionedUserId] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
});

describe('Task #121 human mention plumbing', () => {
  let messageId: string;

  it('stores a human (cuid) mention in user_mentions, not mentions', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/messages`,
      { content: `hey @${mentionedUserId} take a look`, mentions: [mentionedUserId], client_idempotency_key: randomUUID() },
      SENDER_RAW,
    );
    expect(res.statusCode).toBe(201);
    messageId = res.json().id;

    const row = await db.controlMessage.findUnique({
      where: { id: messageId },
      select: { mentions: true, userMentions: true },
    });
    expect(row?.mentions).toEqual([]); // cuid did NOT go into the uuid[] column
    expect(row?.userMentions).toEqual([mentionedUserId]); // it went here
  });

  it('surfaces the human mention on the mentioned user\'s activity feed with deep-link fields', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=mentions`, MENTIONED_RAW);
    expect(res.statusCode).toBe(200);
    const items = res.json().activity as Array<Record<string, unknown>>;
    const item = items.find((a) => a.message_id === messageId);
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      id: `act_${messageId}`,
      message_id: messageId,
      handled: false,
      type: 'mention_human',
      workroom_id: WORKROOM_ID,
      channel_id: CHANNEL_ID,
      thread_id: null,
    });
    expect(typeof item!.title).toBe('string');
    expect(typeof item!.body).toBe('string');
  });

  it('does NOT surface the mention to the sender (sender was not mentioned)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=mentions`, SENDER_RAW);
    expect(res.statusCode).toBe(200);
    const ids = (res.json().activity as Array<{ message_id: string }>).map((a) => a.message_id);
    expect(ids).not.toContain(messageId);
  });

  it('read-all marks all the viewer\'s matched items handled', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/activity/read-all`, {}, MENTIONED_RAW);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().marked).toBeGreaterThanOrEqual(1);

    // Now the unread filter should no longer contain it.
    const unread = await get(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=unread`, MENTIONED_RAW);
    const unreadIds = (unread.json().activity as Array<{ message_id: string }>).map((a) => a.message_id);
    expect(unreadIds).not.toContain(messageId);

    // And the full feed marks it handled.
    const all = await get(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, MENTIONED_RAW);
    const item = (all.json().activity as Array<Record<string, unknown>>).find((a) => a.message_id === messageId);
    expect(item?.handled).toBe(true);
  });
});
