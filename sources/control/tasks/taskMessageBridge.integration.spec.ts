/**
 * taskMessageBridge — REAL Postgres integration.
 *
 * Verifies:
 *   - created (1 task)  → exactly ONE message: `📋 1 new task created: #N "title"`
 *   - created (N tasks) → exactly ONE message: `📋 N new tasks created: #a, #b, …`
 *   - status change     → exactly ONE message: `task #N → <status>`
 *   - null channelId    → NO message emitted (count stays 0)
 *   - a message.created event row exists in controlEventLog (write-before-broadcast)
 *   - EXACTLY ONE message per call (no double-emit)
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { emitTaskLifecycleMessage } from './taskMessageBridge';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
let CHANNEL_ID = '';
let PRIVATE_CHANNEL_ID = '';

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'TaskBridge Org', slug: `task-bridge-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'TaskBridge WR', createdBy: randomUUID() },
  });

  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'bridge-pub', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;

  const privCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'bridge-priv', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  PRIVATE_CHANNEL_ID = privCh.id;
  // No member row for 'system' — tests the gate bypass.
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count system messages in channelId after a given timestamp. */
async function countSystemMessages(channelId: string, after: Date): Promise<number> {
  return db.controlMessage.count({
    where: {
      channelId,
      senderKind: 'system',
      senderId: 'system',
      createdAt: { gt: after },
    },
  });
}

/** Get the most-recent system message in channelId. */
async function latestSystemMessage(channelId: string) {
  return db.controlMessage.findFirst({
    where: { channelId, senderKind: 'system', senderId: 'system' },
    orderBy: { createdAt: 'desc' },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('emitTaskLifecycleMessage — created (1 task)', () => {
  it('emits exactly ONE message with the canonical single-task text', async () => {
    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'created',
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      tasks: [{ number: 42, title: 'Fix the thing' }],
    });

    const count = await countSystemMessages(CHANNEL_ID, before);
    expect(count).toBe(1); // EXACTLY ONE — no double-emit

    const msg = await latestSystemMessage(CHANNEL_ID);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('📋 1 new task created: #42 "Fix the thing"');
    expect(msg!.senderKind).toBe('system');
    expect(msg!.senderId).toBe('system');
  });
});

describe('emitTaskLifecycleMessage — created (N tasks)', () => {
  it('emits exactly ONE message with the multi-task summary text', async () => {
    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'created',
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      tasks: [
        { number: 7, title: 'task alpha' },
        { number: 8, title: 'task beta' },
        { number: 9, title: 'task gamma' },
      ],
    });

    const count = await countSystemMessages(CHANNEL_ID, before);
    expect(count).toBe(1); // EXACTLY ONE

    const msg = await latestSystemMessage(CHANNEL_ID);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('📋 3 new tasks created: #7, #8, #9');
  });
});

describe('emitTaskLifecycleMessage — status change', () => {
  it('emits exactly ONE message with the status-change line', async () => {
    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'status',
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      task: { number: 5, status: 'in_review' },
    });

    const count = await countSystemMessages(CHANNEL_ID, before);
    expect(count).toBe(1);

    const msg = await latestSystemMessage(CHANNEL_ID);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('task #5 → in_review');
  });
});

describe('emitTaskLifecycleMessage — null channelId', () => {
  it('emits NO message when channelId is null', async () => {
    // Use a timestamp before the call as a baseline for workroom-wide count.
    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'created',
      workroomId: WORKROOM_ID,
      channelId: null,
      tasks: [{ number: 99, title: 'null-channel task' }],
    });

    // No message should have been emitted anywhere in this workroom after 'before'.
    const total = await db.controlMessage.count({
      where: {
        workroomId: WORKROOM_ID,
        senderKind: 'system',
        createdAt: { gt: before },
      },
    });
    expect(total).toBe(0); // NO message emitted
  });
});

describe('emitTaskLifecycleMessage — empty created-batch', () => {
  it('emits NO message when kind:created with tasks: []', async () => {
    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'created',
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      tasks: [],
    });

    // No insert, no broadcast — clean no-op (same shape as the null-channel skip).
    const count = await countSystemMessages(CHANNEL_ID, before);
    expect(count).toBe(0); // NO message emitted
  });
});

describe('emitTaskLifecycleMessage — message.created event row (write-before-broadcast)', () => {
  it('event row exists in controlEventLog after emit', async () => {
    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'created',
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      tasks: [{ number: 11, title: 'event row test' }],
    });

    // The message.created event must be persisted in the event log.
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'message.created', createdAt: { gt: before } },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();

    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.channel_id).toBe(CHANNEL_ID);
    expect(typeof payload.message_id).toBe('string');
    expect(payload.sender_kind).toBe('system');
    expect(payload.sender_id).toBe('system');
  });
});

describe('emitTaskLifecycleMessage — EXACTLY ONE message per call (no double-emit)', () => {
  it('two separate calls → two messages, not four', async () => {
    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'created',
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      tasks: [{ number: 20, title: 'double-emit check A' }],
    });
    await emitTaskLifecycleMessage({
      kind: 'created',
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      tasks: [{ number: 21, title: 'double-emit check B' }],
    });

    const count = await countSystemMessages(CHANNEL_ID, before);
    expect(count).toBe(2); // exactly 2 calls → exactly 2 messages
  });
});

describe('emitTaskLifecycleMessage — private channel (member-gate bypass)', () => {
  it('emits successfully on a private channel where "system" is not a member', async () => {
    // Verify pre-condition: no member row for 'system'.
    const member = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId: PRIVATE_CHANNEL_ID, memberId: 'system' } },
    });
    expect(member).toBeNull();

    const before = new Date();

    await emitTaskLifecycleMessage({
      kind: 'status',
      workroomId: WORKROOM_ID,
      channelId: PRIVATE_CHANNEL_ID,
      task: { number: 3, status: 'done' },
    });

    const count = await countSystemMessages(PRIVATE_CHANNEL_ID, before);
    expect(count).toBe(1);

    const msg = await latestSystemMessage(PRIVATE_CHANNEL_ID);
    expect(msg!.content).toBe('task #3 → done');
  });
});
