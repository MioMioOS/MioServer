/**
 * Write-before-broadcast for message.created (shared).
 *
 * Step 1 (awaited by route): publishControlEvent persists the event row to DB.
 *   This guarantees the event exists BEFORE the HTTP 201 response is returned,
 *   satisfying the write-before-broadcast contract (spec §5, same as actionRoutes.ts:74).
 * Step 2 (fire-and-forget): WS broadcast to subscribers. Non-fatal; clients catch up via GET.
 *
 * SECURITY: preview = redactControlText(content) truncated ≤120 chars (spec §5).
 * No tokens, paths, or credentials appear in the WS payload.
 *
 * Extracted from messageRoutes.ts so every message-create path (messageRoutes POST,
 * /internal/agent-api/send) can share the exact same post-commit step (DRY).
 */

import { randomUUID } from 'crypto';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { redactControlText } from '@/control/redaction/redactControlText';

export async function writeEventAndBroadcast(msg: {
  id: string;
  seq: bigint;
  created_at: Date;
  workroomId: string;
  channelId: string;
  senderKind: string;
  senderId: string;
  content: string;
}): Promise<void> {
  const preview = redactControlText(msg.content).slice(0, 120);

  // Step 1: write event to DB (awaited — guarantees persistence before route returns 201).
  const event = await publishControlEvent({
    workroomId: msg.workroomId,
    eventId: randomUUID(),
    topic: 'message.created',
    payload: {
      channel_id: msg.channelId,
      message_id: msg.id,
      seq: msg.seq.toString(),
      sender_kind: msg.senderKind,
      sender_id: msg.senderId,
      preview,
    },
  });

  // Step 2: WS broadcast (fire-and-forget; non-fatal).
  if (!event.idempotent) {
    workroomBroadcaster.broadcast(msg.workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
    console.info(
      `[writeEventAndBroadcast] message.created workroom=${msg.workroomId.slice(0, 8)} channel=${msg.channelId.slice(0, 8)} message_id=${msg.id.slice(0, 8)} seq=${msg.seq.toString()} sender_kind=${msg.senderKind} sender_id=${msg.senderId.slice(0, 8)}`,
    );
  } else {
    console.info(
      `[writeEventAndBroadcast] skip idempotent workroom=${msg.workroomId.slice(0, 8)} message_id=${msg.id.slice(0, 8)}`,
    );
  }
}
