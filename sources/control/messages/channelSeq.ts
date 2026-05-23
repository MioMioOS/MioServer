/**
 * Per-channel monotonic seq allocator for ControlMessage.
 *
 * GUARANTEES:
 * 1. SELECT … FOR UPDATE on the ControlChannel row serializes concurrent seq allocations
 *    for the same channel, preventing races.
 * 2. COALESCE(MAX(seq), 0) + 1 computed inside the same transaction as the lock.
 * 3. UNIQUE(channelId, seq) on ControlMessage is the DB-level backstop; any collision
 *    (e.g. a resumed transaction that somehow races past the lock) will throw P2002, which
 *    the caller should handle by retrying with a new seq.
 *
 * This is intentionally a PER-CHANNEL counter, NOT the workroom-level event-log seq.
 * See spec §3.3: "per-channel seq 是净新基建".
 *
 * ⚠️ Raw queries MUST cast channel_id to ::uuid (Prisma @db.Uuid columns require explicit cast).
 *
 * Usage:
 *   const seq = await nextChannelSeq(tx, channelId);
 *
 * The caller MUST already be inside a Prisma $transaction so the lock + SELECT + INSERT
 * are atomic.
 */

import type { PrismaClient } from '@prisma/client';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

/**
 * Allocate and return the next monotonic seq for the given channel.
 *
 * Acquires a FOR UPDATE lock on the ControlChannel row (serializes concurrent callers),
 * then computes COALESCE(MAX(seq), 0) + 1 from existing messages.
 *
 * MUST be called inside a Prisma $transaction.
 */
export async function nextChannelSeq(tx: TxClient, channelId: string): Promise<bigint> {
  // Lock the channel row to serialize concurrent seq allocation.
  // ::uuid cast is required — Prisma @db.Uuid columns use uuid type in Postgres.
  await tx.$queryRaw`
    SELECT id FROM control_channels
    WHERE id = ${channelId}::uuid
    FOR UPDATE
  `;

  // Compute next seq from existing messages in this channel.
  const [row] = await tx.$queryRaw<[{ next_seq: bigint }]>`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
    FROM control_messages
    WHERE channel_id = ${channelId}::uuid
  `;

  return row.next_seq;
}
