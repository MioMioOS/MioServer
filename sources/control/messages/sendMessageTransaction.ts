/**
 * sendMessageTransaction — atomic message write for POST /channels/:cid/messages (S1 Chunk 4).
 *
 * Responsibilities:
 *   1. Channel membership guard: private/dm non-member → rejects with CHANNEL_FORBIDDEN.
 *   2. Per-channel seq allocation via nextChannelSeq (FOR UPDATE + MAX(seq)+1).
 *   3. INSERT ControlMessage with all provided fields + seq + clientIdempotencyKey.
 *   4. Idempotency: on P2002 for (channelId, clientIdempotencyKey) unique violation, return the
 *      existing message with idempotent=true (op_sess_ duplicate replay → safe).
 *      NOTE: machine path may omit clientIdempotencyKey (NULL) — Postgres NULL ≠ NULL so the
 *      unique index never fires on multiple NULL-key machine messages (correct).
 *
 * Returns: { id, seq (bigint), created_at, idempotent, workroomId, channelId, senderKind, senderId, content }
 *
 * Security:
 *   - content is stored verbatim; callers are responsible for not storing secrets.
 *   - The route broadcasts only redacted+truncated preview (§5 spec).
 *   - dev_ctl_ tokens MUST NOT reach this helper — enforced by the calling route.
 */

import { db } from '@/storage/db';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { nextChannelSeq } from './channelSeq';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SendMessageInput {
  channelId: string;
  workroomId: string;
  senderKind: string;
  senderId: string;
  content: string;
  mentions?: string[];
  embeddedCardType?: string | null;
  embeddedCardId?: string | null;
  clientIdempotencyKey?: string | null;
  /**
   * S2 §4.4 — when set, this message is a thread reply to that parent message.
   * Inside the same $transaction we upsert ControlThread (replyCount) and bump the
   * parent's threadReplyCount/lastThreadReplyAt. null/undefined → top-level message
   * (no thread bookkeeping). The idempotent-replay (P2002) path does NOT re-run the
   * bookkeeping, so a duplicate reply key never double-bumps.
   */
  parentMessageId?: string | null;
}

export type SendMessageResult =
  | {
      ok: true;
      id: string;
      seq: bigint;
      created_at: Date;
      idempotent: boolean;
      workroomId: string;
      channelId: string;
      senderKind: string;
      senderId: string;
      content: string;
    }
  | { ok: false; code: 'CHANNEL_NOT_FOUND'; httpStatus: 404 }
  | { ok: false; code: 'CHANNEL_FORBIDDEN'; httpStatus: 403 };

// ── Internal error class for propagating guard failures out of $transaction ──

class SendMsgError extends Error {
  constructor(public readonly result: Exclude<SendMessageResult, { ok: true }>) {
    super(result.code);
    this.name = 'SendMsgError';
  }
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Execute the message write inside a single Prisma $transaction.
 *
 * Channel visibility guard:
 *   - public channels: anyone authenticated for the workroom may post.
 *   - private / dm channels: sender must have an explicit ControlChannelMember row.
 *
 * Idempotency via UNIQUE(channelId, clientIdempotencyKey):
 *   - op_sess_ path: route requires clientIdempotencyKey (missing → 400 before this is called).
 *   - machine path: clientIdempotencyKey may be null → unique index never fires for null keys.
 */
export async function sendMessageTransaction(input: SendMessageInput): Promise<SendMessageResult> {
  const {
    channelId,
    workroomId,
    senderKind,
    senderId,
    content,
    mentions = [],
    embeddedCardType = null,
    embeddedCardId = null,
    clientIdempotencyKey = null,
    parentMessageId = null,
  } = input;

  try {
    const msg = await db.$transaction(async (tx) => {
      // Step 1: Load channel — verify it exists in the given workroom.
      const channel = await tx.controlChannel.findUnique({
        where: { id: channelId },
        select: { id: true, workroomId: true, visibility: true, archivedAt: true },
      });

      if (!channel || channel.workroomId !== workroomId) {
        throw new SendMsgError({ ok: false, code: 'CHANNEL_NOT_FOUND', httpStatus: 404 });
      }

      // Step 2: Membership guard for private / dm channels.
      // public channels are always accessible to any authenticated workroom actor.
      if (channel.visibility !== 'public') {
        const membership = await tx.controlChannelMember.findUnique({
          where: { channelId_memberId: { channelId, memberId: senderId } },
          select: { memberId: true },
        });
        if (!membership) {
          throw new SendMsgError({ ok: false, code: 'CHANNEL_FORBIDDEN', httpStatus: 403 });
        }
      }

      // Step 3: Allocate the next per-channel seq (FOR UPDATE serializes concurrent callers).
      const seq = await nextChannelSeq(tx as Parameters<typeof nextChannelSeq>[0], channelId);

      // Step 4: Insert the message.
      const id = randomUUID();
      const created = await tx.controlMessage.create({
        data: {
          id,
          workroomId,
          channelId,
          seq,
          senderKind,
          senderId,
          content,
          mentions,
          embeddedCardType,
          embeddedCardId,
          clientIdempotencyKey,
          parentMessageId: parentMessageId ?? null,
        },
        select: { id: true, seq: true, createdAt: true, workroomId: true, channelId: true, senderKind: true, senderId: true, content: true },
      });

      // Step 5: Bump lastActivityAt on the channel (same tx — keeps the channel list sorted).
      await tx.controlChannel.update({
        where: { id: channelId },
        data: { lastActivityAt: created.createdAt },
      });

      // Step 6 (S2 §4.4): thread bookkeeping for replies — only when this is a reply.
      // Same $transaction: upsert ControlThread + bump the parent's threadReplyCount.
      // The nextChannelSeq FOR UPDATE above serializes concurrent first-replies, so the
      // upsert create branch cannot double-fire. The idempotent-replay (P2002) path is in
      // the catch below and does NOT reach this block, so a duplicate reply key never
      // double-bumps (Task 2.2 (d)).
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

      return { ...created, idempotent: false };
    });

    return {
      ok: true,
      id: msg.id,
      seq: msg.seq,
      created_at: msg.createdAt,
      idempotent: msg.idempotent,
      workroomId: msg.workroomId,
      channelId: msg.channelId,
      senderKind: msg.senderKind,
      senderId: msg.senderId,
      content: msg.content,
    };
  } catch (err) {
    // Propagate guard errors thrown inside the transaction.
    if (err instanceof SendMsgError) {
      return err.result;
    }

    // P2002: only treat as idempotent replay when:
    //   1. clientIdempotencyKey is non-null (machine null-key sends should never land here)
    //   2. err.meta.target refers to the (channelId, clientIdempotencyKey) constraint
    //      — not a (channelId, seq) collision or some other unique index.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      clientIdempotencyKey != null
    ) {
      // Confirm the violated constraint is the idempotency one, not the seq one.
      const target = (err.meta?.target as string[] | string | undefined) ?? [];
      const targetFields = Array.isArray(target) ? target : [target];
      const isIdempotencyConstraint =
        targetFields.includes('client_idempotency_key') ||
        // Prisma may report the constraint name instead of field names on some versions.
        targetFields.some((t) => String(t).includes('idempotency'));

      if (!isIdempotencyConstraint) {
        // Unexpected unique violation (e.g. seq collision) — surface clearly rather than masking.
        throw new Error(
          `Unexpected P2002 unique violation on constraint: ${JSON.stringify(target)}. ` +
          `This is not the idempotency key constraint.`,
        );
      }

      const existing = await db.controlMessage.findFirst({
        where: { channelId, clientIdempotencyKey },
        select: { id: true, seq: true, createdAt: true, workroomId: true, channelId: true, senderKind: true, senderId: true, content: true },
      });

      if (!existing) {
        // The constraint fired but we cannot find the row — race or data anomaly.
        throw new Error(
          `P2002 idempotency constraint fired for key=${clientIdempotencyKey} but no existing row found.`,
        );
      }

      return {
        ok: true,
        id: existing.id,
        seq: existing.seq,
        created_at: existing.createdAt,
        idempotent: true,
        workroomId: existing.workroomId,
        channelId: existing.channelId,
        senderKind: existing.senderKind,
        senderId: existing.senderId,
        content: existing.content,
      };
    }

    throw err;
  }
}
