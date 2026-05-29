/**
 * nextChannelTaskNumber — integration tests (REAL Postgres).
 *
 * Covers:
 *   - Returns 1 for a channel with no tasks
 *   - Increments monotonically (1, 2, 3 …) within a single channel
 *   - Isolated across channels (channel A's numbers don't affect channel B)
 *   - Concurrent creates in the same channel get DISTINCT numbers
 *     (Promise.all of two $transaction calls — FOR UPDATE serializes them)
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/tasks/nextChannelTaskNumber.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { nextChannelTaskNumber } from './nextChannelTaskNumber';

// ── Shared fixture IDs ────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'TaskNum Org', slug: `tasknum-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'TaskNum WR', createdBy: randomUUID() },
  });
});

afterAll(async () => {
  // FK-safe delete order: tasks → channels → workroom → org
  await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeChannel(name: string): Promise<string> {
  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name, type: 'standard', visibility: 'public', createdBy: 'system' },
  });
  return ch.id;
}

async function insertTask(channelId: string, number: number): Promise<string> {
  const task = await db.controlTask.create({
    data: {
      workroomId: WORKROOM_ID,
      channelId,
      number,
      title: `Task #${number}`,
    },
  });
  return task.id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('nextChannelTaskNumber', () => {
  it('returns 1 for a channel with no tasks', async () => {
    const chId = await makeChannel('tasknum-empty');

    const num = await db.$transaction((tx) => nextChannelTaskNumber(tx as never, chId));
    expect(num).toBe(1);

    // cleanup
    await db.controlChannel.deleteMany({ where: { id: chId } });
  });

  it('rejects for a non-existent channel (does not silently return 1)', async () => {
    const phantomChannelId = randomUUID();

    await expect(
      db.$transaction((tx) => nextChannelTaskNumber(tx as never, phantomChannelId)),
    ).rejects.toThrow(/not found/);
  });

  it('increments monotonically within a channel (1, 2, 3)', async () => {
    const chId = await makeChannel('tasknum-incr');

    const num1 = await db.$transaction((tx) => nextChannelTaskNumber(tx as never, chId));
    expect(num1).toBe(1);
    await insertTask(chId, num1);

    const num2 = await db.$transaction((tx) => nextChannelTaskNumber(tx as never, chId));
    expect(num2).toBe(2);
    await insertTask(chId, num2);

    const num3 = await db.$transaction((tx) => nextChannelTaskNumber(tx as never, chId));
    expect(num3).toBe(3);

    // cleanup
    await db.controlTask.deleteMany({ where: { channelId: chId } });
    await db.controlChannel.deleteMany({ where: { id: chId } });
  });

  it('numbers are isolated per channel (channel A does not affect channel B)', async () => {
    const chA = await makeChannel('tasknum-iso-a');
    const chB = await makeChannel('tasknum-iso-b');

    // Insert 3 tasks in channel A
    for (let i = 1; i <= 3; i++) {
      const n = await db.$transaction((tx) => nextChannelTaskNumber(tx as never, chA));
      await insertTask(chA, n);
    }

    // Channel B should still start at 1
    const numB = await db.$transaction((tx) => nextChannelTaskNumber(tx as never, chB));
    expect(numB).toBe(1);

    // cleanup
    await db.controlTask.deleteMany({ where: { channelId: { in: [chA, chB] } } });
    await db.controlChannel.deleteMany({ where: { id: { in: [chA, chB] } } });
  });

  it('concurrent creates in the same channel get DISTINCT numbers (FOR UPDATE serializes)', async () => {
    const chId = await makeChannel('tasknum-concurrent');

    // Two concurrent transactions each allocate a number and insert a task.
    // FOR UPDATE on the channel row ensures one runs after the other → distinct numbers.
    const [idA, idB] = await Promise.all([
      db.$transaction(async (tx) => {
        const num = await nextChannelTaskNumber(tx as never, chId);
        const task = await tx.controlTask.create({
          data: { workroomId: WORKROOM_ID, channelId: chId, number: num, title: `Concurrent #${num}` },
        });
        return task.id;
      }),
      db.$transaction(async (tx) => {
        const num = await nextChannelTaskNumber(tx as never, chId);
        const task = await tx.controlTask.create({
          data: { workroomId: WORKROOM_ID, channelId: chId, number: num, title: `Concurrent #${num}` },
        });
        return task.id;
      }),
    ]);

    // Both tasks must exist and have different (distinct) numbers
    const tasks = await db.controlTask.findMany({
      where: { id: { in: [idA, idB] } },
      select: { number: true },
      orderBy: { number: 'asc' },
    });

    expect(tasks).toHaveLength(2);
    const numbers = tasks.map((t) => t.number);
    expect(numbers[0]).not.toBeNull();
    expect(numbers[1]).not.toBeNull();
    expect(numbers[0]).not.toBe(numbers[1]);
    // Should be 1 and 2 in some order (both allocated from empty channel)
    expect(new Set(numbers)).toEqual(new Set([1, 2]));

    // cleanup
    await db.controlTask.deleteMany({ where: { channelId: chId } });
    await db.controlChannel.deleteMany({ where: { id: chId } });
  });
});
