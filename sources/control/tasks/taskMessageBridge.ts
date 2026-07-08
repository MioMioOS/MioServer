/**
 * taskMessageBridge — bridge between task lifecycle events and channel messages.
 *
 * When a task is created or its status changes, this bridge posts a system message
 * into the channel so agents perceive task events via the slice-1 inbound message
 * path. Agents treat 'system'-sender messages per the "don't reply to system
 * messages unless they request action" rule.
 *
 * The bridge:
 *   - Fires ONLY when channelId is present (null-channel tasks → skip silently).
 *   - Is best-effort: errors are logged but do NOT propagate (callers A5/A6 wrap
 *     so a bridge failure never fails the task write).
 *   - Emits EXACTLY ONE message per call (no double-emit).
 *   - Maintains write-before-broadcast ordering: insertSystemMessage persists the
 *     row before writeEventAndBroadcast publishes the event.
 */

import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';
import { db } from '@/storage/db';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskLifecycleInput =
  | {
      kind: 'created';
      workroomId: string;
      channelId: string | null;
      tasks: Array<{ number: number; title: string }>;
    }
  | {
      kind: 'status';
      workroomId: string;
      channelId: string | null;
      task: { number: number; status: string };
    };

// ── Text composition ──────────────────────────────────────────────────────────

/** Compose the canonical Slock task lifecycle message text. */
function composeText(input: TaskLifecycleInput): string {
  if (input.kind === 'created') {
    const { tasks } = input;
    if (tasks.length === 1) {
      const t = tasks[0];
      return `📋 1 new task created: #${t.number} "${t.title}"`;
    }
    const refs = tasks.map((t) => `#${t.number}`).join(', ');
    return `📋 ${tasks.length} new tasks created: ${refs}`;
  }
  // kind === 'status'
  const { task } = input;
  return `task #${task.number} → ${task.status}`;
}

/** 状态变化行升级为全景摘要:✅ 刚完成 · ⏳ 进行中 · 👀 待审 —— 用户不点
 *  thread 也能看到整个频道的任务面貌(07-08 反馈:主频道全是裸状态行,
 *  且僵尸任务不可见)。查询失败时回落到单任务行,永不阻塞。 */
async function composeStatusDigest(channelId: string, task: { number: number; status: string }): Promise<string> {
  try {
    const open = await db.controlTask.findMany({
      where: { channelId, status: { in: ['in_progress', 'in_review', 'todo'] } },
      select: { number: true, status: true },
      orderBy: { number: 'asc' },
    });
    const others = open.filter((t) => t.number !== task.number);
    const inProg = others.filter((t) => t.status === 'in_progress').map((t) => `#${t.number}`);
    const inRev = others.filter((t) => t.status === 'in_review').map((t) => `#${t.number}`);
    const todo = others.filter((t) => t.status === 'todo').map((t) => `#${t.number}`);
    const ICON: Record<string, string> = { done: '✅', in_review: '👀', in_progress: '⏳', todo: '📥', canceled: '🚫', closed: '🚫' };
    const parts = [`${ICON[task.status] ?? ''} #${task.number} → ${task.status}`];
    if (inProg.length) parts.push(`⏳ 进行中 ${inProg.join(' ')}`);
    if (inRev.length) parts.push(`👀 待审 ${inRev.join(' ')}`);
    if (todo.length) parts.push(`📥 排队 ${todo.join(' ')}`);
    return parts.join(' · ');
  } catch {
    return `task #${task.number} → ${task.status}`;
  }
}

// ── Bridge ────────────────────────────────────────────────────────────────────

/**
 * Emit a system message for a task lifecycle event.
 *
 * Returns immediately (no return value) — fire-and-forget semantics from the
 * caller's perspective. If channelId is null, returns without emitting.
 * Errors are caught, logged, and swallowed (best-effort).
 */
export async function emitTaskLifecycleMessage(input: TaskLifecycleInput): Promise<void> {
  // Null-channel tasks → skip (no channel to post into).
  if (input.channelId === null) {
    return;
  }

  // Empty created-batch → clean no-op (no insert, no broadcast). Guards against the
  // malformed "📋 0 new tasks created: " text. Same shape as the null-channel skip.
  if (input.kind === 'created' && input.tasks.length === 0) {
    return;
  }

  const { workroomId, channelId } = input;
  const content = input.kind === 'status'
    ? await composeStatusDigest(channelId, input.task)
    : composeText(input);

  try {
    // Step 1: persist the row (row exists before broadcast — write-before-broadcast).
    const row = await insertSystemMessage({ workroomId, channelId, content });

    // Step 2: publish message.created event + WS broadcast.
    await writeEventAndBroadcast(row);
  } catch (err) {
    // Best-effort: log but do not propagate — bridge failure must not fail the task write.
    console.error('[taskMessageBridge] failed to emit task lifecycle message:', err);
  }
}
