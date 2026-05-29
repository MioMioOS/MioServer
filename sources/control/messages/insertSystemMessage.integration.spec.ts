/**
 * insertSystemMessage — REAL Postgres integration.
 *
 * Verifies:
 *   - inserts a row with senderKind:'system', senderId:'system', a valid seq.
 *   - works on a PRIVATE channel where 'system' is NOT a member (member-gated send
 *     would 403; insertSystemMessage bypasses that gate).
 *   - returns the exact shape writeEventAndBroadcast expects.
 *   - works on a PUBLIC channel too (sanity check).
 *   - seq is monotonically increasing across successive calls.
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { insertSystemMessage } from './insertSystemMessage';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
let PUBLIC_CHANNEL_ID = '';
let PRIVATE_CHANNEL_ID = '';

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'InsertSysMsg Org', slug: `insert-sys-msg-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'InsertSysMsg WR', createdBy: randomUUID() },
  });

  const pubCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'sys-pub', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  PUBLIC_CHANNEL_ID = pubCh.id;

  const privCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'sys-priv', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  PRIVATE_CHANNEL_ID = privCh.id;
  // Intentionally: NO ControlChannelMember row for 'system' in this channel.
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('insertSystemMessage — public channel', () => {
  it('inserts a message row with senderKind:system, senderId:system', async () => {
    const result = await insertSystemMessage({
      workroomId: WORKROOM_ID,
      channelId: PUBLIC_CHANNEL_ID,
      content: 'test system msg in public channel',
    });

    // Return shape
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(typeof result.seq).toBe('bigint');
    expect(result.seq).toBeGreaterThan(0n);
    expect(result.created_at).toBeInstanceOf(Date);
    expect(result.workroomId).toBe(WORKROOM_ID);
    expect(result.channelId).toBe(PUBLIC_CHANNEL_ID);
    expect(result.senderKind).toBe('system');
    expect(result.senderId).toBe('system');
    expect(result.content).toBe('test system msg in public channel');

    // DB row exists
    const row = await db.controlMessage.findUnique({ where: { id: result.id } });
    expect(row).not.toBeNull();
    expect(row!.senderKind).toBe('system');
    expect(row!.senderId).toBe('system');
  });
});

describe('insertSystemMessage — private channel (member-gate bypass)', () => {
  it('succeeds on a PRIVATE channel where "system" is not a member', async () => {
    // Confirm there is no member row for 'system' (pre-condition for this test).
    const member = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId: PRIVATE_CHANNEL_ID, memberId: 'system' } },
    });
    expect(member).toBeNull(); // 'system' is NOT a member

    // This call must succeed (not throw), proving the gate is bypassed.
    const result = await insertSystemMessage({
      workroomId: WORKROOM_ID,
      channelId: PRIVATE_CHANNEL_ID,
      content: '📋 1 new task created: #1 "fix bug"',
    });

    expect(result.senderKind).toBe('system');
    expect(result.senderId).toBe('system');
    expect(result.channelId).toBe(PRIVATE_CHANNEL_ID);

    // Row persisted in DB
    const row = await db.controlMessage.findUnique({ where: { id: result.id } });
    expect(row).not.toBeNull();
    expect(row!.senderKind).toBe('system');
  });

  it('returns the exact shape writeEventAndBroadcast expects', async () => {
    const result = await insertSystemMessage({
      workroomId: WORKROOM_ID,
      channelId: PRIVATE_CHANNEL_ID,
      content: 'shape-check message',
    });

    // writeEventAndBroadcast signature: { id, seq, created_at, workroomId, channelId, senderKind, senderId, content }
    expect(typeof result.id).toBe('string');
    expect(typeof result.seq).toBe('bigint');
    expect(result.created_at).toBeInstanceOf(Date);
    expect(typeof result.workroomId).toBe('string');
    expect(typeof result.channelId).toBe('string');
    expect(typeof result.senderKind).toBe('string');
    expect(typeof result.senderId).toBe('string');
    expect(typeof result.content).toBe('string');

    // No extra fields that would confuse writeEventAndBroadcast (it only reads those 8).
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['channelId', 'content', 'created_at', 'id', 'senderId', 'senderKind', 'seq', 'workroomId'].sort());
  });

  it('seq is monotonically increasing across successive calls', async () => {
    const r1 = await insertSystemMessage({
      workroomId: WORKROOM_ID,
      channelId: PRIVATE_CHANNEL_ID,
      content: 'seq check 1',
    });
    const r2 = await insertSystemMessage({
      workroomId: WORKROOM_ID,
      channelId: PRIVATE_CHANNEL_ID,
      content: 'seq check 2',
    });

    expect(r2.seq).toBeGreaterThan(r1.seq);
  });
});
