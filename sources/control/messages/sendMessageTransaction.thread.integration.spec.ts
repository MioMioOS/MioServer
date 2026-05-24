/**
 * S2 Task 2.2 — sendMessageTransaction thread bookkeeping (REAL Postgres integration).
 *
 * Covers the extension of sendMessageTransaction to support replies (parentMessageId):
 *   (a) a reply (parentMessageId set) inserts a message carrying that parent.
 *   (b) first reply → creates ControlThread { replyCount: 1 } and sets parent
 *       threadReplyCount: 1 + lastThreadReplyAt.
 *   (c) second reply → ControlThread.replyCount: 2, parent threadReplyCount: 2.
 *   (d) idempotent replay of a reply (same client_idempotency_key) returns the
 *       existing row WITHOUT double-bumping (replyCount/threadReplyCount unchanged).
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { sendMessageTransaction } from './sendMessageTransaction';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();

let CHANNEL_ID = '';
let PARENT_MSG_ID = '';

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'SendMsgThread Org', slug: `send-thread-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'SendMsgThread WR', createdBy: randomUUID() },
  });
  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;

  // A top-level parent message to reply to.
  const parent = await sendMessageTransaction({
    channelId: CHANNEL_ID,
    workroomId: WORKROOM_ID,
    senderKind: 'user',
    senderId: 'pairing:' + randomUUID(),
    content: 'parent message',
    clientIdempotencyKey: randomUUID(),
  });
  if (!parent.ok) throw new Error('failed to seed parent message');
  PARENT_MSG_ID = parent.id;
});

afterAll(async () => {
  await db.controlThread.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendMessageTransaction — thread bookkeeping (S2 §4.4)', () => {
  it('(a) a reply inserts a message carrying parentMessageId', async () => {
    const res = await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'reply A',
      clientIdempotencyKey: randomUUID(),
      parentMessageId: PARENT_MSG_ID,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const row = await db.controlMessage.findUnique({
      where: { id: res.id },
      select: { parentMessageId: true },
    });
    expect(row?.parentMessageId).toBe(PARENT_MSG_ID);
  });

  it('(b) first reply creates ControlThread replyCount:1 and bumps parent threadReplyCount:1', async () => {
    // Use a fresh parent so the counts are deterministic regardless of test order.
    const parent = await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'fresh parent b',
      clientIdempotencyKey: randomUUID(),
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    // No thread row yet, parent threadReplyCount starts at 0.
    const before = await db.controlMessage.findUnique({
      where: { id: parent.id },
      select: { threadReplyCount: true, lastThreadReplyAt: true },
    });
    expect(before?.threadReplyCount).toBe(0);
    expect(before?.lastThreadReplyAt).toBeNull();
    const threadBefore = await db.controlThread.findUnique({ where: { parentMessageId: parent.id } });
    expect(threadBefore).toBeNull();

    const reply = await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'first reply',
      clientIdempotencyKey: randomUUID(),
      parentMessageId: parent.id,
    });
    expect(reply.ok).toBe(true);

    const thread = await db.controlThread.findUnique({ where: { parentMessageId: parent.id } });
    expect(thread).not.toBeNull();
    expect(thread!.replyCount).toBe(1);
    expect(thread!.workroomId).toBe(WORKROOM_ID);
    expect(thread!.lastReplyAt).not.toBeNull();

    const after = await db.controlMessage.findUnique({
      where: { id: parent.id },
      select: { threadReplyCount: true, lastThreadReplyAt: true },
    });
    expect(after?.threadReplyCount).toBe(1);
    expect(after?.lastThreadReplyAt).not.toBeNull();
  });

  it('(c) second reply increments ControlThread.replyCount:2 and parent threadReplyCount:2', async () => {
    const parent = await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'fresh parent c',
      clientIdempotencyKey: randomUUID(),
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'reply 1',
      clientIdempotencyKey: randomUUID(),
      parentMessageId: parent.id,
    });
    await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'reply 2',
      clientIdempotencyKey: randomUUID(),
      parentMessageId: parent.id,
    });

    const thread = await db.controlThread.findUnique({ where: { parentMessageId: parent.id } });
    expect(thread!.replyCount).toBe(2);

    const after = await db.controlMessage.findUnique({
      where: { id: parent.id },
      select: { threadReplyCount: true },
    });
    expect(after?.threadReplyCount).toBe(2);
  });

  it('(d) idempotent replay of a reply does NOT double-bump counts', async () => {
    const parent = await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'fresh parent d',
      clientIdempotencyKey: randomUUID(),
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const replyKey = randomUUID();
    const first = await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'idempotent reply',
      clientIdempotencyKey: replyKey,
      parentMessageId: parent.id,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.idempotent).toBe(false);

    // Replay with the same key — must return the existing row, idempotent:true.
    const replay = await sendMessageTransaction({
      channelId: CHANNEL_ID,
      workroomId: WORKROOM_ID,
      senderKind: 'user',
      senderId: 'pairing:' + randomUUID(),
      content: 'idempotent reply',
      clientIdempotencyKey: replyKey,
      parentMessageId: parent.id,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.idempotent).toBe(true);
    expect(replay.id).toBe(first.id);

    // Counts must reflect exactly ONE reply, not two.
    const thread = await db.controlThread.findUnique({ where: { parentMessageId: parent.id } });
    expect(thread!.replyCount).toBe(1);

    const after = await db.controlMessage.findUnique({
      where: { id: parent.id },
      select: { threadReplyCount: true },
    });
    expect(after?.threadReplyCount).toBe(1);
  });
});
