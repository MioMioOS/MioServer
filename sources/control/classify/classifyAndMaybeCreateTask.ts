/**
 * classifyAndMaybeCreateTask — post-message hook.
 *
 * Called AFTER a top-level message commits (parent_message_id IS NULL only — thread
 * replies are explicitly skipped per spec). Builds the classifier context from the
 * channel name, channel members, the last 5 messages, and the sender's handle, then
 * asks Doubao if this message should become a task. If yes (and an assignee handle
 * resolves to an in-channel ControlAgent), creates the task transactionally and
 * writes a 📋 system message as the FIRST thread reply under the new message.
 *
 * Best-effort by design:
 *   - All branches that can fail (resolve, classify, transaction, broadcast) are
 *     wrapped in a top-level try/catch so a classifier failure NEVER fails the
 *     underlying message POST. The route already returned 201 with the message
 *     before this is awaited; the worst case is "no auto-task" + a logged warning.
 *   - The bridge runs SYNCHRONOUSLY relative to the HTTP response (spec: 300-500ms
 *     overhead is acceptable) so iOS clients receive task.created + the thread
 *     system message in time for an immediate UI update.
 */

import { db } from '@/storage/db';
import { classifyMessageForTask } from './messageClassifier';
import { nextChannelTaskNumber } from '@/control/tasks/nextChannelTaskNumber';
import { writeTaskEventAndBroadcast } from '@/control/tasks/writeTaskEventAndBroadcast';
import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';
import { serverToSlockStatus } from '@/control/tasks/slockTaskStatus';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Public input ─────────────────────────────────────────────────────────────

export interface ClassifyAndMaybeCreateTaskInput {
  workroomId: string;
  channelId: string;
  messageId: string;
  parentMessageId: string | null; // if non-null this hook becomes a no-op (thread reply)
  senderKind: string; // 'user' | 'agent' | 'system'
  senderId: string;
  content: string;
  // Fix 5: forwarded to the classifier. When true (explicit cross-agent
  // handoff kept on main), a passing heuristic gate is enough to create a task
  // even if the probabilistic LLM gate declines. See messageClassifier.ts.
  forceTaskOnHandoff?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build "@name" handle for a ControlAgent (mirrors memberRoutes line 101).
 */
function agentHandle(name: string): string {
  return name.startsWith('@') ? name : '@' + name;
}

/**
 * Resolve the sender's handle for the prompt context and for the self-loop guard.
 * - agent sender → ControlAgent.name → @name (if not resolvable, "@unknown-agent")
 * - user sender  → "@user-<short>" (no canonical user handle in this slice;
 *   the classifier just needs SOMETHING stable to compare against)
 * - system       → "@system"
 */
async function resolveSenderHandle(senderKind: string, senderId: string): Promise<string> {
  if (senderKind === 'agent') {
    if (!UUID_RE.test(senderId)) return '@' + senderId;
    try {
      const a = await db.controlAgent.findUnique({
        where: { id: senderId },
        select: { name: true },
      });
      if (a?.name) return agentHandle(a.name);
      // senderId may be machineId (daemon send) — try matching that field too.
      const byMachine = await db.controlAgent.findFirst({
        where: { machineId: senderId },
        orderBy: { createdAt: 'asc' },
        select: { name: true },
      });
      if (byMachine?.name) return agentHandle(byMachine.name);
    } catch {
      // Fall through to opaque fallback.
    }
    return '@agent-' + senderId.slice(0, 8);
  }
  if (senderKind === 'system') return '@system';
  // user
  return '@user-' + senderId.slice(0, 8);
}

interface ChannelMemberInfo {
  agentId: string | null; // null for non-agent members (humans)
  handle: string;
  role: string;
  kind: 'user' | 'agent';
}

/**
 * Resolve channel members → handle table for the prompt + a handle→agentId map
 * for the assignee lookup. Only ControlChannelMember rows that resolve to a
 * ControlAgent become "agent" kind members; rows that do not resolve are treated
 * as humans (no agentId; classifier may still emit them as assignee but the task
 * will be created with owner_instance_id = null).
 */
async function loadChannelMembers(channelId: string): Promise<ChannelMemberInfo[]> {
  const rows = await db.controlChannelMember.findMany({
    where: { channelId },
    select: { memberId: true },
  });
  if (rows.length === 0) return [];

  const uuidIds = rows.map((r) => r.memberId).filter((id) => UUID_RE.test(id));

  const agentsById = new Map<string, { id: string; name: string; role: string }>();
  if (uuidIds.length > 0) {
    const agents = await db.controlAgent.findMany({
      where: { id: { in: uuidIds } },
      select: { id: true, name: true, role: true },
    });
    for (const a of agents) agentsById.set(a.id, a);
  }

  const out: ChannelMemberInfo[] = [];
  for (const row of rows) {
    const agent = agentsById.get(row.memberId);
    if (agent) {
      out.push({
        agentId: agent.id,
        handle: agentHandle(agent.name),
        role: agent.role,
        kind: 'agent',
      });
    } else {
      // Non-agent member (human or opaque actor). Surface as user-kind so the
      // classifier may consider them but no agentId is bound.
      out.push({
        agentId: null,
        handle: '@user-' + row.memberId.slice(0, 8),
        role: 'user',
        kind: 'user',
      });
    }
  }
  return out;
}

/** Last 5 top-level messages BEFORE the new message, oldest→newest for prompt context. */
async function loadRecentMessages(
  channelId: string,
  excludingMessageId: string,
): Promise<Array<{ sender_handle: string; preview: string }>> {
  const rows = await db.controlMessage.findMany({
    where: { channelId, parentMessageId: null, NOT: { id: excludingMessageId } },
    orderBy: { seq: 'desc' },
    take: 5,
    select: { senderKind: true, senderId: true, content: true },
  });
  rows.reverse();
  const out: Array<{ sender_handle: string; preview: string }> = [];
  for (const r of rows) {
    const handle = await resolveSenderHandle(r.senderKind, r.senderId);
    out.push({ sender_handle: handle, preview: r.content.slice(0, 200) });
  }
  return out;
}

// ── Main bridge ──────────────────────────────────────────────────────────────

export async function classifyAndMaybeCreateTask(
  input: ClassifyAndMaybeCreateTaskInput,
): Promise<void> {
  // Thread replies → no-op (spec: classifier only runs on top-level messages).
  if (input.parentMessageId !== null) {
    console.info(
      `[classifyAndMaybeCreateTask] skip reason=thread_reply message_id=${input.messageId.slice(0, 8)}`,
    );
    return;
  }

  console.info(
    `[classifyAndMaybeCreateTask] enter channel_id=${input.channelId.slice(0, 8)} message_id=${input.messageId.slice(0, 8)} sender_kind=${input.senderKind} sender_id=${input.senderId.slice(0, 8)}`,
  );

  try {
    const channel = await db.controlChannel.findUnique({
      where: { id: input.channelId },
      select: { id: true, name: true, workroomId: true },
    });
    if (!channel) {
      console.info(
        `[classifyAndMaybeCreateTask] skip reason=channel_missing channel_id=${input.channelId.slice(0, 8)}`,
      );
      return;
    }

    const [members, recent, senderHandle] = await Promise.all([
      loadChannelMembers(input.channelId),
      loadRecentMessages(input.channelId, input.messageId),
      resolveSenderHandle(input.senderKind, input.senderId),
    ]);

    const result = await classifyMessageForTask({
      content: input.content,
      channelName: channel.name,
      channelMembers: members.map((m) => ({ handle: m.handle, role: m.role, kind: m.kind })),
      recentMessages: recent,
      senderHandle,
      forceTaskOnHandoff: input.forceTaskOnHandoff,
    });

    if (!result.is_task || !result.task_title) {
      console.info(
        `[classifyAndMaybeCreateTask] no_task message_id=${input.messageId.slice(0, 8)} is_task=${result.is_task} title=${result.task_title ? 'present' : 'null'}`,
      );
      return;
    }

    // Resolve the assignee handle → agentId, if present.
    // Prefer an agent member; fall back to null owner if not resolvable.
    let ownerAgentId: string | null = null;
    if (result.assignee_handle) {
      const wanted = result.assignee_handle.trim();
      const wantedLc = wanted.toLowerCase();
      // Try exact match first (cheap), then case-insensitive (Doubao normalizes
      // handles inconsistently — sometimes returns "@Tester" verbatim, sometimes
      // "@tester" lowercase, even for the same channel-member). Bare-name
      // fallback handles models that drop the leading "@".
      let match = members.find((m) => m.handle === wanted && m.kind === 'agent');
      if (!match) {
        match = members.find(
          (m) => m.handle.toLowerCase() === wantedLc && m.kind === 'agent',
        );
      }
      if (!match) {
        const withAt = wanted.startsWith('@') ? wanted : '@' + wanted;
        const withAtLc = withAt.toLowerCase();
        match = members.find(
          (m) => m.handle.toLowerCase() === withAtLc && m.kind === 'agent',
        );
      }
      ownerAgentId = match?.agentId ?? null;
      if (!match) {
        console.info(
          `[classifyAndMaybeCreateTask] assignee_unresolved handle=${result.assignee_handle} message_id=${input.messageId.slice(0, 8)}`,
        );
      }
    }

    const creatorAgentId =
      input.senderKind === 'agent' && UUID_RE.test(input.senderId) ? input.senderId : null;

    // Allocate task number + insert ControlTask in one transaction.
    let task!: {
      id: string;
      channelId: string | null;
      workroomId: string;
      title: string;
      status: string;
      ownerInstanceId: string | null;
      number: number | null;
      createdAt: Date;
    };
    await db.$transaction(async (tx) => {
      const num = await nextChannelTaskNumber(tx, input.channelId);
      task = await tx.controlTask.create({
        data: {
          workroomId: input.workroomId,
          channelId: input.channelId,
          title: result.task_title!,
          // P1 latency: when the classifier already resolved an assignee, the
          // task is born OWNED — there is no claim step for the agent to do, so
          // skip todo and start in_progress. This removes the per-agent
          // list→claim→update_status round-trips (~20s each over cross-ocean
          // RTT + model thinking). An unresolved-assignee task stays `todo`
          // (no owner) so a human/PM can still pick it up.
          status: ownerAgentId ? 'in_progress' : 'todo',
          number: num,
          ownerInstanceId: ownerAgentId,
          creatorInstanceId: creatorAgentId,
          parentMessageId: input.messageId,
          // Note in description when the classifier picked a non-resolvable handle.
          description:
            result.assignee_handle && !ownerAgentId
              ? `Auto-classified from message. Requested assignee "${result.assignee_handle}" did not resolve to an agent member of this channel.`
              : '',
        },
        select: {
          id: true,
          channelId: true,
          workroomId: true,
          title: true,
          status: true,
          ownerInstanceId: true,
          number: true,
          createdAt: true,
        },
      });
    });

    console.info(
      `[classifyAndMaybeCreateTask] task_created task_id=${task.id.slice(0, 8)} number=${task.number ?? 'null'} owner=${task.ownerInstanceId ? task.ownerInstanceId.slice(0, 8) : 'null'} title=${JSON.stringify(task.title)}`,
    );

    // Emit task.created event (mirrors slockTaskRoutes shape so iOS handles it identically).
    await writeTaskEventAndBroadcast({
      workroomId: input.workroomId,
      topic: 'task.created',
      payload: {
        task_id: task.id,
        channel_id: task.channelId,
        workroom_id: input.workroomId,
        title: task.title,
        status: serverToSlockStatus(task.status),
        assignee_id: task.ownerInstanceId,
        owner_id: task.ownerInstanceId,
        created_by: input.senderId,
        source: 'classifier',
      },
    });

    // If we landed on a real owner, ALSO emit task.assigned so the daemon wakes them.
    if (task.ownerInstanceId) {
      await writeTaskEventAndBroadcast({
        workroomId: input.workroomId,
        topic: 'task.assigned',
        payload: {
          task_id: task.id,
          channel_id: task.channelId,
          workroom_id: input.workroomId,
          assignee_id: task.ownerInstanceId,
          assigner_id: input.senderId,
          parent_message_id: input.messageId,
        },
      });
    }

    // Write the 📋 system message AS A THREAD REPLY under the new message
    // (parent_message_id = new message id) so iOS sees the task chip on the
    // originating message. Same shape as slockTaskRoutes attach_to_message_id path.
    if (task.number !== null) {
      try {
        const sysRow = await insertSystemMessage({
          workroomId: input.workroomId,
          channelId: input.channelId,
          content: `📋 1 new task created: #${task.number} "${task.title}"`,
          parentMessageId: input.messageId,
        });
        await writeEventAndBroadcast(sysRow);
      } catch (err) {
        console.error('[classifyAndMaybeCreateTask] failed to emit thread system message:', err);
      }
    }
  } catch (err) {
    // Top-level swallow: a classifier failure must never fail the underlying message POST.
    console.error('[classifyAndMaybeCreateTask] error:', err);
  }
}
