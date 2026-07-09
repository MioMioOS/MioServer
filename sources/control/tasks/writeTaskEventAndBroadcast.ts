/**
 * Write-before-broadcast for task lifecycle events (task.created / task.updated).
 *
 * Mirrors sources/control/reminders/writeReminderEventAndBroadcast.ts EXACTLY, with the
 * task topics parameterized. The CALLER builds the Slock-vocab payload
 * ({ task_id, channel_id, status, assignee_id }) — this module does NOT translate status.
 *
 * Step 1 (awaited): publishControlEvent persists the event row before this returns.
 * Step 2 (fire-and-forget): WS broadcast to subscribers; non-fatal (catch-up via GET).
 */

import { randomUUID } from 'crypto';
import { syncMirrorSource } from './mirrorTaskBridge';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

export async function writeTaskEventAndBroadcast(input: {
  workroomId: string;
  topic: 'task.created' | 'task.updated' | 'task.status_changed' | 'task.assigned' | 'task.review_requested';
  payload: Record<string, unknown>;
}): Promise<void> {
  // 客户频道任务桥:内部镜像任务的状态变化回流到源需求单。所有状态转换
  // 都经此函数广播,故在此单点挂桥。fire-and-forget(桥内部自兜错)。
  if (input.topic === 'task.status_changed') {
    const tid = input.payload['task_id'];
    const st = input.payload['status'] ?? input.payload['to'];
    if (typeof tid === 'string' && typeof st === 'string' && input.payload['source'] !== 'mirror-bridge') {
      void syncMirrorSource(tid, String(st).toLowerCase());
    }
  }
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
