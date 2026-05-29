/**
 * Per-channel monotonic task-number allocator for ControlTask.
 *
 * GUARANTEES:
 * 1. SELECT … FOR UPDATE on the ControlChannel row serializes concurrent task-number
 *    allocations for the same channel, preventing races.
 * 2. COALESCE(MAX(number), 0) + 1 computed inside the same transaction as the lock.
 * 3. PARTIAL UNIQUE INDEX (channel_id, number) WHERE both non-null is the DB-level backstop;
 *    any collision (e.g. a resumed transaction that somehow races past the lock) will throw
 *    P2002, which the caller should handle by retrying with a new number.
 *
 * This is intentionally a PER-CHANNEL counter. Workroom-level tasks (channelId=null)
 * do NOT get a number — callers MUST NOT invoke this helper for those tasks.
 *
 * ⚠️ Raw queries MUST cast channel_id to ::uuid (Prisma @db.Uuid columns require explicit cast).
 *
 * Usage:
 *   const num = await nextChannelTaskNumber(tx, channelId);
 *
 * The caller MUST already be inside a Prisma $transaction so the lock + SELECT + INSERT
 * are atomic.
 */

import type { PrismaClient } from '@prisma/client';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

/**
 * Allocate and return the next monotonic task number for the given channel.
 *
 * Acquires a FOR UPDATE lock on the ControlChannel row (serializes concurrent callers),
 * then computes COALESCE(MAX(number), 0) + 1 from existing channel-scoped tasks.
 *
 * MUST be called inside a Prisma $transaction.
 */
export async function nextChannelTaskNumber(tx: TxClient, channelId: string): Promise<number> {
  // Lock the channel row to serialize concurrent task-number allocation.
  // ::uuid cast is required — Prisma @db.Uuid columns use uuid type in Postgres.
  //
  // GUARD: a non-existent channelId locks an EMPTY set (no error), leaving no lock
  // held. Two concurrent callers for a phantom channel would then both compute
  // COALESCE(NULL,0)+1 = 1 and collide on the partial unique index (P2002 crash).
  // Throw a clean error instead so callers fail fast on a bad channelId.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM control_channels
    WHERE id = ${channelId}::uuid
    FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new Error(`nextChannelTaskNumber: channel ${channelId} not found`);
  }

  // Compute next number from existing channel-scoped tasks.
  const [row] = await tx.$queryRaw<[{ next_number: number }]>`
    SELECT COALESCE(MAX(number), 0) + 1 AS next_number
    FROM control_tasks
    WHERE channel_id = ${channelId}::uuid
  `;

  return Number(row.next_number);
}
