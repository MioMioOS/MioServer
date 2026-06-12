/**
 * Per-channel monotonic seq allocator for ControlMessage.
 *
 * GUARANTEES:
 * 1. Allocation is `UPDATE control_channels SET message_seq = message_seq + 1` —
 *    a single-row indexed update. The channel row lock is taken by the UPDATE and
 *    held until the caller's transaction commits, which serializes concurrent
 *    allocations AND orders seq with commit visibility (a catch-up reader's
 *    `seq > cursor` can never skip a late-committing message).
 * 2. The previous design ran SELECT … FOR UPDATE + COALESCE(MAX(seq),0)+1 over
 *    control_messages INSIDE the lock — the critical section grew with message
 *    volume and convoyed every sender in the channel, each waiter pinning a pool
 *    connection (2026-06-12 pool-stability work).
 * 3. UNIQUE(channelId, seq) on ControlMessage is the DB-level backstop; any
 *    collision throws P2002, which the caller should handle by retrying.
 *
 * This is intentionally a PER-CHANNEL counter, NOT the workroom-level event-log
 * seq. See spec §3.3: "per-channel seq 是净新基建".
 *
 * Usage:
 *   const seq = await nextChannelSeq(tx, channelId);
 *
 * The caller MUST already be inside a Prisma $transaction so the allocation and
 * the message INSERT are atomic (and so the lock-until-commit ordering holds).
 */

import type { PrismaClient } from '@prisma/client';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

/**
 * Allocate and return the next monotonic seq for the given channel.
 * MUST be called inside a Prisma $transaction.
 *
 * Self-healing: the counter is clamped to MAX(seq) of existing rows on every
 * allocation (index-only O(log n) lookup), so out-of-band inserts that bypassed
 * the counter (test fixtures, backfill scripts) can never make the allocator
 * hand out a colliding seq.
 */
export async function nextChannelSeq(tx: TxClient, channelId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<[{ message_seq: bigint }] | []>`
    UPDATE control_channels c
    SET message_seq = GREATEST(
          c.message_seq,
          COALESCE((SELECT MAX(m.seq) FROM control_messages m WHERE m.channel_id = c.id), 0)
        ) + 1
    WHERE c.id = ${channelId}::uuid
    RETURNING message_seq
  `;
  if (!rows.length) {
    // Phantom channel — caller should have verified existence; fail loud rather
    // than silently minting seq for a row that doesn't exist.
    throw new Error(`nextChannelSeq: channel ${channelId} not found`);
  }
  return rows[0].message_seq;
}
