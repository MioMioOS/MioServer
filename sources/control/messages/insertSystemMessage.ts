/**
 * insertSystemMessage — write a server-originated 'system' message directly.
 *
 * Bypasses the member gate in sendMessageTransaction (a 'system' sentinel is not a
 * channel member → would 403 on private channels). Writes the row directly inside
 * a $transaction with nextChannelSeq so write-before-broadcast ordering is
 * maintained by the caller (bridge calls writeEventAndBroadcast AFTER this returns).
 *
 * senderKind: 'system'
 * senderId:   'system'  (fixed sentinel — agents treat this per the "don't reply to
 *             system messages unless they request action" rule in the system prompt)
 *
 * Returns the EXACT shape expected by writeEventAndBroadcast so the bridge can
 * pass it straight through without a re-fetch.
 */

import { db } from '@/storage/db';
import { randomUUID } from 'crypto';
import { nextChannelSeq } from './channelSeq';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InsertSystemMessageInput {
  workroomId: string;
  channelId: string;
  content: string;
  /**
   * Bug-2 Thread feature: when set, this system message is posted INSIDE the
   * thread under that parent message (parent_message_id = this id). The
   * parent's threadReplyCount + lastThreadReplyAt are bumped, and ControlThread
   * (replyCount/lastReplyAt) is upserted — same bookkeeping as a normal thread
   * reply. null/undefined → top-level system message (existing behavior).
   */
  parentMessageId?: string | null;
}

/** Matches the writeEventAndBroadcast parameter shape exactly. */
export interface SystemMessageRow {
  id: string;
  seq: bigint;
  created_at: Date;
  workroomId: string;
  channelId: string;
  senderKind: string;
  senderId: string;
  content: string;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Insert a system message row and return the writeEventAndBroadcast-compatible shape.
 *
 * DOES NOT call writeEventAndBroadcast — the caller (taskMessageBridge) does that
 * AFTER this returns, preserving write-before-broadcast ordering.
 *
 * DOES NOT perform any membership check — the 'system' sentinel is never a channel
 * member, so the gate in sendMessageTransaction would always reject it. This is
 * intentional; system messages are server-originated and bypass the member gate.
 */
export async function insertSystemMessage(
  input: InsertSystemMessageInput,
): Promise<SystemMessageRow> {
  const { workroomId, channelId, content, parentMessageId = null } = input;

  const row = await db.$transaction(async (tx) => {
    // Allocate per-channel seq (FOR UPDATE serializes concurrent callers).
    const seq = await nextChannelSeq(tx as Parameters<typeof nextChannelSeq>[0], channelId);

    const id = randomUUID();
    const created = await tx.controlMessage.create({
      data: {
        id,
        workroomId,
        channelId,
        seq,
        senderKind: 'system',
        senderId: 'system',
        content,
        mentions: [],
        parentMessageId: parentMessageId ?? null,
        // clientIdempotencyKey: null (system messages don't use idempotency keys)
      },
      select: {
        id: true,
        seq: true,
        createdAt: true,
        workroomId: true,
        channelId: true,
        senderKind: true,
        senderId: true,
        content: true,
      },
    });

    // Bump lastActivityAt on the channel (same tx — keeps channel list sorted).
    await tx.controlChannel.update({
      where: { id: channelId },
      data: { lastActivityAt: created.createdAt },
    });

    // Bug-2 Thread feature: if this system message is a thread reply, mirror
    // the bookkeeping sendMessageTransaction does for normal replies — upsert
    // ControlThread (replyCount, lastReplyAt) and bump the parent message's
    // threadReplyCount / lastThreadReplyAt. Same $transaction, same FOR-UPDATE
    // seq serialization so concurrent first-attaches can't double-create the
    // ControlThread row.
    if (parentMessageId) {
      await tx.controlThread.upsert({
        where: { parentMessageId },
        create: {
          parentMessageId,
          workroomId,
          replyCount: 1,
          lastReplyAt: created.createdAt,
        },
        update: {
          replyCount: { increment: 1 },
          lastReplyAt: created.createdAt,
        },
      });
      await tx.controlMessage.update({
        where: { id: parentMessageId },
        data: {
          threadReplyCount: { increment: 1 },
          lastThreadReplyAt: created.createdAt,
        },
      });
    }

    return created;
  });

  return {
    id: row.id,
    seq: row.seq,
    created_at: row.createdAt,
    workroomId: row.workroomId,
    channelId: row.channelId,
    senderKind: row.senderKind,
    senderId: row.senderId,
    content: row.content,
  };
}
