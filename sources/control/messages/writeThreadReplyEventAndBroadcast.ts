/**
 * Write-before-broadcast for thread.reply (S2 §4.4 / §5) — shared.
 *
 * Extracted from messageRoutes.ts so every thread-reply path (user-route
 * POST /api/v1/workrooms/:wid/threads/:parentId/reply,
 * agent-api  POST /internal/agent-api/threads/reply) can share the exact same
 * post-commit step (DRY).
 *
 * Mirrors writeEventAndBroadcast but emits topic 'thread.reply' with the parent_message_id.
 * Skipped entirely on idempotent replay (a duplicate reply key must not emit a 2nd event).
 * preview = redactControlText(content) truncated ≤120 chars (no secrets in the WS payload).
 */

import { randomUUID } from 'crypto';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { redactControlText } from '@/control/redaction/redactControlText';

export async function writeThreadReplyEventAndBroadcast(input: {
  workroomId: string;
  channelId: string;
  parentMessageId: string;
  messageId: string;
  seq: bigint;
  senderKind: string;
  senderId: string;
  content: string;
  idempotent: boolean;
  /** Thread-owner routing: agent ids that should wake for this reply. Stamped by
   *  the USER reply route (mentions win; else the parent task's owner). Absent →
   *  daemon falls back to its legacy context-policy behavior. */
  wakeAgentIds?: string[];
}): Promise<void> {
  if (input.idempotent) {
    console.info(
      `[writeThreadReply] skip idempotent workroom=${input.workroomId.slice(0, 8)} message_id=${input.messageId.slice(0, 8)} parent=${input.parentMessageId.slice(0, 8)}`,
    );
    return;
  }

  const preview = redactControlText(input.content).slice(0, 120);

  const event = await publishControlEvent({
    workroomId: input.workroomId,
    eventId: randomUUID(),
    topic: 'thread.reply',
    payload: {
      channel_id: input.channelId,
      parent_message_id: input.parentMessageId,
      message_id: input.messageId,
      seq: input.seq.toString(),
      sender_kind: input.senderKind,
      sender_id: input.senderId,
      preview,
      ...(input.wakeAgentIds !== undefined ? { wake_agent_ids: input.wakeAgentIds } : {}),
    },
  });

  if (!event.idempotent) {
    workroomBroadcaster.broadcast(input.workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
    console.info(
      `[writeThreadReply] thread.reply workroom=${input.workroomId.slice(0, 8)} channel=${input.channelId.slice(0, 8)} message_id=${input.messageId.slice(0, 8)} parent=${input.parentMessageId.slice(0, 8)} seq=${input.seq.toString()} sender_kind=${input.senderKind} sender_id=${input.senderId.slice(0, 8)}`,
    );
  }
}
