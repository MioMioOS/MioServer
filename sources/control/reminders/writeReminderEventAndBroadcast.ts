/**
 * Write-before-broadcast for reminder lifecycle events (reminder.upserted / reminder.canceled).
 *
 * Mirrors sources/control/messages/writeEventAndBroadcast.ts EXACTLY, with the topic
 * parameterized so reminder routes can emit their two control-plane topics through the
 * SAME write-before-broadcast contract:
 *
 * Step 1 (awaited by route): publishControlEvent persists the event row to DB —
 *   guarantees the event exists BEFORE the HTTP response, same as message.created.
 * Step 2 (fire-and-forget): WS broadcast to subscribers. Non-fatal; clients catch up via GET.
 *
 * NOTE: The reminder's OBSERVABLE "⏰ fired" channel message reuses the EXISTING
 * message.created chain (insertSystemMessage → writeEventAndBroadcast), NOT this helper.
 * This helper is for reminder.upserted / reminder.canceled only.
 */

import { randomUUID } from 'crypto';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

export async function writeReminderEventAndBroadcast(input: {
  workroomId: string;
  topic: 'reminder.upserted' | 'reminder.canceled';
  payload: Record<string, unknown>;
}): Promise<void> {
  // Step 1: write event to DB (awaited — guarantees persistence before route returns).
  const event = await publishControlEvent({
    workroomId: input.workroomId,
    eventId: randomUUID(),
    topic: input.topic,
    payload: input.payload,
  });

  // Step 2: WS broadcast (fire-and-forget; non-fatal).
  if (!event.idempotent) {
    workroomBroadcaster.broadcast(input.workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
  }
}
