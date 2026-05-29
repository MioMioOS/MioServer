/**
 * agentApiTasks — Fastify route plugin for /internal/agent-api/tasks/* endpoints.
 *
 * All endpoints require:
 *   - authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id → real ControlAgent)
 *   - resolveAgentChannelTarget (#channel-name → channelId + workroomId, enforces membership)
 *
 * Endpoints:
 *   GET  /internal/agent-api/tasks/list?channel=#name
 *     → channel's tasks { tasks: [{ number, id, title, status, assignee_id, … }] }
 *
 *   POST /internal/agent-api/tasks/create  { channel, title | titles }
 *     → create ControlTask(s) status 'todo', number via nextChannelTaskNumber (FOR UPDATE)
 *     → NO auto-claim; emit 📋 created bridge message; returns { tasks: [{ number, id }] }
 *     → Accept either a single `title` (string) or an array `titles` (string[])
 *
 *   POST /internal/agent-api/tasks/claim   { channel, number }
 *     → resolve #number→task in that channel; claimControlTaskCas(task.id, agent.id)
 *     → conflict (owned by other) → 409 TASK_CLAIM_CONFLICT
 *     → self (already own) → 200 ok (idempotent)
 *     → emit status bridge message
 *
 *   POST /internal/agent-api/tasks/unclaim { channel, number }
 *     → release ownerInstanceId (only if owner === agent; else 403 UNCLAIM_FORBIDDEN)
 *
 *   POST /internal/agent-api/tasks/update-status { channel, number, status }
 *     → validateTaskTransition(current, status)
 *     → 400 INVALID_TASK_TRANSITION on illegal
 *     → apply; emit status bridge message
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { authorizeAgentApi } from './agentApiAuth';
import { resolveAgentChannelTarget } from './agentApiTargets';
import { nextChannelTaskNumber } from '@/control/tasks/nextChannelTaskNumber';
import { claimControlTaskCas, NON_CLAIMABLE_STATUSES } from '@/control/tasks/claimControlTaskCas';
import { validateTaskTransition } from '@/control/tasks/taskTransition';
import { decideReviewGate, resolveTaskReviewer } from '@/control/tasks/taskReview';
import { emitTaskLifecycleMessage } from '@/control/tasks/taskMessageBridge';
import { writeTaskEventAndBroadcast } from '@/control/tasks/writeTaskEventAndBroadcast';
import { serverToSlockStatus } from '@/control/tasks/slockTaskStatus';
import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Look up a channel-scoped task by #number; returns null if not found. */
async function findTaskByNumber(channelId: string, number: number) {
  return db.controlTask.findFirst({
    where: { channelId, number },
  });
}

async function resolveAgentDisplayNames(agentIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(agentIds.filter((x): x is string => Boolean(x)))];
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const agents = await db.controlAgent.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, name: true },
  });
  for (const a of agents) {
    const label = a.displayName?.trim() || a.name?.trim();
    if (label) result.set(a.id, label);
  }
  return result;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentApiTasks(app: FastifyInstance) {
  /**
   * GET /internal/agent-api/tasks/list?channel=#name
   *
   * Returns all tasks in the agent's channel.
   * Query params:
   *   channel — `#channel-name` (required)
   *
   * Responses:
   *   200 { tasks: [{ id, number, title, status, assignee_id }] }
   *   400 INVALID_QUERY      — missing channel param
   *   400 TARGET_UNSUPPORTED — non `#name` channel format
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER       — agent not a member of the channel
   *   409 AMBIGUOUS_CHANNEL
   */
  app.get('/internal/agent-api/tasks/list', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: parse query ───────────────────────────────────────────────────
    const query = request.query as { channel?: string };
    if (!query.channel || typeof query.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'channel is required' } });
    }

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(query.channel, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId } = resolved;

    // ── Step 4: fetch tasks ───────────────────────────────────────────────────
    const tasks = await db.controlTask.findMany({
      where: { channelId },
      orderBy: [{ number: 'asc' }, { createdAt: 'asc' }],
      take: 100,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        ownerInstanceId: true,
        creatorInstanceId: true,
        createdAt: true,
      },
    });
    const names = await resolveAgentDisplayNames([
      ...tasks.map((t) => t.ownerInstanceId),
      ...tasks.map((t) => t.creatorInstanceId),
    ]);

    return reply.code(200).send({
      tasks: tasks.map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        assignee_id: t.ownerInstanceId,
        assignee_display_name: t.ownerInstanceId ? (names.get(t.ownerInstanceId) ?? null) : null,
        owner_instance_id: t.ownerInstanceId,
        owner_display_name: t.ownerInstanceId ? (names.get(t.ownerInstanceId) ?? null) : null,
        creator_instance_id: t.creatorInstanceId,
        creator_display_name: t.creatorInstanceId ? (names.get(t.creatorInstanceId) ?? null) : null,
        created_at: t.createdAt.toISOString(),
      })),
    });
  });

  /**
   * POST /internal/agent-api/tasks/create
   *
   * Body (JSON):
   *   channel   — `#channel-name` (required)
   *   title     — single task title (string) — mutually exclusive with `titles`
   *   titles    — array of task titles (string[]) — mutually exclusive with `title`
   *
   * Exactly one of `title` or `titles` must be present.
   *
   * Responses:
   *   201 { tasks: [{ id, number }] }
   *   400 INVALID_BODY       — missing channel or title/titles
   *   400 TARGET_UNSUPPORTED
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER
   *   409 AMBIGUOUS_CHANNEL
   */
  app.post('/internal/agent-api/tasks/create', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as {
      channel?: unknown;
      title?: unknown;
      titles?: unknown;
      attach_to_message_id?: unknown;
    } | null;

    if (!body?.channel || typeof body.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel is required' } });
    }

    // Bug-2 Thread feature: optional attach_to_message_id. When the daemon
    // creates a single task in response to a user message it can pin it as a
    // thread under that message; iOS surfaces the chip + reply_count.
    // Only honored for SINGLE-task creates (title, not titles[]) — attaching
    // one parent message to many sibling tasks is ambiguous; first-wins would
    // hide the rest, so we reject the combination explicitly.
    const attachToMessageId: string | null =
      typeof body.attach_to_message_id === 'string' && body.attach_to_message_id.length > 0
        ? body.attach_to_message_id
        : null;
    if (attachToMessageId && body.titles !== undefined) {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: 'attach_to_message_id is only allowed with a single title' },
      });
    }

    // Resolve title(s) — accept either `title` (string) or `titles` (string[]), but not both.
    if (body.title !== undefined && body.titles !== undefined) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'provide title or titles, not both' } });
    }
    let titleList: string[];
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'title must be a non-empty string' } });
      }
      titleList = [body.title];
    } else if (body.titles !== undefined) {
      if (!Array.isArray(body.titles) || body.titles.length === 0) {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'titles must be a non-empty array' } });
      }
      for (const t of body.titles) {
        if (typeof t !== 'string' || t.trim() === '') {
          return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'each title must be a non-empty string' } });
        }
      }
      titleList = body.titles as string[];
    } else {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'title or titles is required' } });
    }

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(body.channel, auth.agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    // Validate the attach target message belongs to THIS channel.
    if (attachToMessageId) {
      const parentMsg = await db.controlMessage.findUnique({
        where: { id: attachToMessageId },
        select: { id: true, channelId: true, workroomId: true },
      });
      if (!parentMsg || parentMsg.channelId !== channelId || parentMsg.workroomId !== workroomId) {
        return reply.code(404).send({
          error: { code: 'ATTACH_MESSAGE_NOT_FOUND', message: 'attach_to_message_id not found in this channel' },
        });
      }
    }

    // ── Step 4: create tasks with per-channel numbers (transactional) ─────────
    // Each task gets a unique monotonic number via nextChannelTaskNumber (FOR UPDATE).
    // We serialize them in a single transaction so numbers are contiguous and ordered.
    const createdTasks: Array<{ id: string; number: number; title: string; createdAt: Date }> = [];

    await db.$transaction(async (tx) => {
      for (const title of titleList) {
        const num = await nextChannelTaskNumber(tx, channelId);
        const task = await tx.controlTask.create({
          data: {
            id: randomUUID(),
            workroomId,
            channelId,
            title,
            status: 'todo',
            number: num,
            creatorInstanceId: auth.agent.id,
            // attachToMessageId is gated to single-title creates above, so applying
            // it to every iteration is correct (loop runs exactly once).
            parentMessageId: attachToMessageId,
          },
          select: { id: true, number: true, title: true, createdAt: true },
        });
        createdTasks.push({ id: task.id, number: task.number!, title: task.title, createdAt: task.createdAt });
      }
    });

    // ── Step 5: emit 📋 task lifecycle bridge message (best-effort) ───────────
    // Only emit when ≥1 task created (guard is also inside emitTaskLifecycleMessage,
    // but we make the intent explicit here).
    if (createdTasks.length > 0) {
      await emitTaskLifecycleMessage({
        kind: 'created',
        workroomId,
        channelId,
        tasks: createdTasks.map((t) => ({ number: t.number, title: t.title })),
      });
    }

    // ── Step 5b (Bug-2 Thread): when attached, post a system_task_created
    // message INSIDE the thread of the parent so reply_count increments and
    // iOS surfaces the thread. Best-effort: failure must not roll back the task.
    if (attachToMessageId && createdTasks.length === 1) {
      const t = createdTasks[0];
      try {
        const sysRow = await insertSystemMessage({
          workroomId,
          channelId,
          content: `1 new task created: #${t.number} "${t.title}"`,
          parentMessageId: attachToMessageId,
        });
        await writeEventAndBroadcast(sysRow);
      } catch (err) {
        console.error('[agentApiTasks] failed to emit system_task_created thread message:', err);
      }
    }

    // ── Step 6: return { tasks: [{ id, number }] } ────────────────────────────
    return reply.code(201).send({
      tasks: createdTasks.map((t) => ({
        id: t.id,
        number: t.number,
        title: t.title,
        status: 'todo',
        owner_instance_id: null,
        owner_display_name: null,
        assignee_id: null,
        assignee_display_name: null,
        creator_instance_id: auth.agent.id,
        creator_display_name: auth.agent.displayName?.trim() || auth.agent.name,
        created_at: t.createdAt.toISOString(),
      })),
    });
  });

  /**
   * POST /internal/agent-api/tasks/claim
   *
   * Body (JSON):
   *   channel — `#channel-name` (required)
   *   number  — task number within the channel (required, integer)
   *
   * Responses:
   *   200 { ok: true }           — claimed (or self-idempotent)
   *   400 INVALID_BODY
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER
   *   404 TASK_NOT_FOUND         — no task with that number in this channel
   *   409 TASK_CLAIM_CONFLICT    — task is owned by a different agent
   *   409 AMBIGUOUS_CHANNEL
   */
  app.post('/internal/agent-api/tasks/claim', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as { channel?: unknown; number?: unknown } | null;

    if (!body?.channel || typeof body.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel is required' } });
    }
    if (body.number === undefined || body.number === null || typeof body.number !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'number is required' } });
    }
    const taskNumber = body.number as number;

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(body.channel, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    // ── Step 4: find the task by number ───────────────────────────────────────
    const task = await findTaskByNumber(channelId, taskNumber);
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: `Task #${taskNumber} not found in this channel` } });
    }

    // ── Step 5: CAS claim ─────────────────────────────────────────────────────
    const casResult = await claimControlTaskCas(task.id, agent.id);

    if (!casResult.ok) {
      if (casResult.reason === 'not_found') {
        return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
      }
      if (casResult.reason === 'terminal') {
        return reply.code(409).send({
          error: { code: 'TASK_CLAIM_CONFLICT', message: `Task is ${casResult.task.status} and cannot be claimed` },
        });
      }
      // owned_by_other
      return reply.code(409).send({
        error: {
          code: 'TASK_CLAIM_CONFLICT',
          message: 'Task is already claimed by another agent',
          current_owner_instance_id: casResult.task.ownerInstanceId,
        },
      });
    }

    // ── Step 6: emit status bridge message ────────────────────────────────────
    const newStatus = casResult.alreadyOwn ? casResult.task.status : 'in_progress';
    await emitTaskLifecycleMessage({
      kind: 'status',
      workroomId,
      channelId,
      task: { number: taskNumber, status: newStatus },
    });

    // Fix A: also emit WS task.updated event so iOS task observatory sees the change.
    await writeTaskEventAndBroadcast({
      workroomId,
      topic: 'task.updated',
      payload: {
        task_id: task.id,
        channel_id: channelId,
        status: serverToSlockStatus(newStatus),
        assignee_id: agent.id,
      },
    });

    // M5: if this was a new (non-idempotent) claim, also emit task.assigned and
    // task.status_changed so other co-located agents on this workroom WS know
    // someone took it / the status flipped. assigner_id == assignee_id since
    // the agent self-claimed; the daemon self-loop guard drops it for the
    // claimer's own spine.
    if (!casResult.alreadyOwn) {
      await writeTaskEventAndBroadcast({
        workroomId,
        topic: 'task.assigned',
        payload: {
          task_id: task.id,
          channel_id: channelId,
          workroom_id: workroomId,
          assignee_id: agent.id,
          assigner_id: agent.id,
        },
      });
      await writeTaskEventAndBroadcast({
        workroomId,
        topic: 'task.status_changed',
        payload: {
          task_id: task.id,
          channel_id: channelId,
          workroom_id: workroomId,
          from: serverToSlockStatus(task.status),
          to: serverToSlockStatus(newStatus),
          actor_id: agent.id,
          assignee_id: agent.id,
        },
      });
    }

    return reply.code(200).send({ ok: true });
  });

  /**
   * POST /internal/agent-api/tasks/unclaim
   *
   * Body (JSON):
   *   channel — `#channel-name` (required)
   *   number  — task number within the channel (required, integer)
   *
   * Only the current owner (ownerInstanceId === agent.id) may unclaim.
   *
   * Responses:
   *   200 { ok: true }          — unclaimed; ownerInstanceId cleared, status → todo
   *   400 INVALID_BODY
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   403 UNCLAIM_FORBIDDEN     — agent is not the current owner (or task is terminal)
   *   404 NOT_A_MEMBER
   *   404 TASK_NOT_FOUND
   *   409 AMBIGUOUS_CHANNEL
   */
  app.post('/internal/agent-api/tasks/unclaim', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as { channel?: unknown; number?: unknown } | null;

    if (!body?.channel || typeof body.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel is required' } });
    }
    if (body.number === undefined || body.number === null || typeof body.number !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'number is required' } });
    }
    const taskNumber = body.number as number;

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(body.channel, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId } = resolved;

    // ── Step 4: find the task by number ───────────────────────────────────────
    const task = await findTaskByNumber(channelId, taskNumber);
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: `Task #${taskNumber} not found in this channel` } });
    }

    // ── Step 5: ownership check before unclaim ────────────────────────────────
    if (task.ownerInstanceId !== agent.id) {
      return reply.code(403).send({
        error: { code: 'UNCLAIM_FORBIDDEN', message: 'Only the current owner can unclaim this task' },
      });
    }

    // ── Step 6: CAS unclaim — only release if still owned by this agent ───────
    const result = await db.controlTask.updateMany({
      where: {
        id: task.id,
        ownerInstanceId: agent.id,
        status: { notIn: NON_CLAIMABLE_STATUSES },
      },
      data: {
        ownerInstanceId: null,
        status: 'todo',
      },
    });

    if (result.count === 0) {
      // Task may be terminal (done/canceled) — still 403 per spec
      return reply.code(403).send({
        error: { code: 'UNCLAIM_FORBIDDEN', message: 'Cannot unclaim this task (may be terminal or ownership changed)' },
      });
    }

    return reply.code(200).send({ ok: true });
  });

  /**
   * POST /internal/agent-api/tasks/update-status
   *
   * Body (JSON):
   *   channel — `#channel-name` (required)
   *   number  — task number within the channel (required, integer)
   *   status  — target status string (required)
   *
   * Validates the transition via validateTaskTransition(current, status).
   *
   * Responses:
   *   200 { ok: true }
   *   400 INVALID_BODY
   *   400 INVALID_TASK_TRANSITION  — illegal transition
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER
   *   404 TASK_NOT_FOUND
   *   409 AMBIGUOUS_CHANNEL
   */
  app.post('/internal/agent-api/tasks/update-status', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as { channel?: unknown; number?: unknown; status?: unknown } | null;

    if (!body?.channel || typeof body.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel is required' } });
    }
    if (body.number === undefined || body.number === null || typeof body.number !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'number is required' } });
    }
    if (!body.status || typeof body.status !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'status is required' } });
    }
    const taskNumber = body.number as number;
    const targetStatus = body.status as string;

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(body.channel, auth.agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    // ── Step 4: find the task by number ───────────────────────────────────────
    const task = await findTaskByNumber(channelId, taskNumber);
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: `Task #${taskNumber} not found in this channel` } });
    }

    // ── Step 5: validate transition ───────────────────────────────────────────
    const transition = validateTaskTransition(task.status, targetStatus);
    if (!transition.ok) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_TASK_TRANSITION',
          message: `Cannot transition from '${task.status}' to '${targetStatus}'`,
        },
      });
    }

    // ── Step 5.5: P3 reviewer-gate ────────────────────────────────────────────
    // An AGENT owner cannot self-certify `done`. When an independent reviewer
    // exists, divert in_progress→done into in_progress→in_review and wake that
    // reviewer to adversarially audit the deliverable (mutation/blind-spot check)
    // before it closes. Falls through to done when there is no other agent member
    // (graceful degradation — never deadlock) or once the 1-bounce cap is reached.
    // Only consult the members table on an actual done-submit from active work.
    let reviewerId: string | null = null;
    if (targetStatus === 'done' && task.status === 'in_progress') {
      reviewerId = await resolveTaskReviewer(channelId, task.ownerInstanceId);
    }
    const gate = decideReviewGate({
      currentStatus: task.status,
      targetStatus,
      reviewRound: task.reviewRound,
      hasIndependentReviewer: reviewerId !== null,
    });
    const effectiveStatus = gate.action === 'divert_to_review' ? 'in_review' : targetStatus;
    const diverted = gate.action === 'divert_to_review';

    // ── Step 6: apply the update ──────────────────────────────────────────────
    // Safe under the single-owner contract: only the owning agent calls update-status, so the
    // read-then-write here can't race a concurrent transition. If that contract is ever relaxed
    // (multiple writers), add `status: task.status` to the WHERE to make this a CAS write.
    await db.controlTask.update({
      where: { id: task.id },
      // The divert counts a review round so a post-bounce re-submit auto-passes
      // (reviewRound >= MAX_REVIEW_ROUNDS → no second divert).
      data: diverted
        ? { status: 'in_review', reviewRound: { increment: 1 } }
        : { status: effectiveStatus },
    });

    // ── Step 7: emit status bridge message ────────────────────────────────────
    await emitTaskLifecycleMessage({
      kind: 'status',
      workroomId,
      channelId,
      task: { number: taskNumber, status: effectiveStatus },
    });

    // Fix A: also emit WS task.updated event so iOS task observatory sees the change.
    await writeTaskEventAndBroadcast({
      workroomId,
      topic: 'task.updated',
      payload: {
        task_id: task.id,
        channel_id: channelId,
        status: serverToSlockStatus(effectiveStatus),
        assignee_id: task.ownerInstanceId,
      },
    });

    // M5: dedicated status_changed event for autonomous wake routing.
    if (task.status !== effectiveStatus) {
      await writeTaskEventAndBroadcast({
        workroomId,
        topic: 'task.status_changed',
        payload: {
          task_id: task.id,
          channel_id: channelId,
          workroom_id: workroomId,
          from: serverToSlockStatus(task.status),
          to: serverToSlockStatus(effectiveStatus),
          actor_id: auth.agent.id,
          assignee_id: task.ownerInstanceId,
        },
      });
    }

    // P3: when diverted, wake the chosen reviewer with the audit request. The
    // daemon's task.review_requested handler routes a wake to reviewer_id with
    // mutation-audit instructions; verdict comes back via POST /tasks/review.
    if (diverted && reviewerId) {
      await writeTaskEventAndBroadcast({
        workroomId,
        topic: 'task.review_requested',
        payload: {
          task_id: task.id,
          channel_id: channelId,
          workroom_id: workroomId,
          reviewer_id: reviewerId,
          owner_id: task.ownerInstanceId,
          parent_message_id: task.parentMessageId,
          title: task.title,
          number: taskNumber,
        },
      });
    }

    return reply.code(200).send({
      ok: true,
      status: serverToSlockStatus(effectiveStatus),
      diverted_to_review: diverted,
    });
  });

  /**
   * POST /internal/agent-api/tasks/review
   *   body: { channel, number, verdict: 'pass' | 'bounce', feedback? }
   *
   * P3 reviewer-gate verdict. Called by an INDEPENDENT reviewer agent that was
   * woken via task.review_requested. The task must be in_review.
   *   - pass   → in_review → done   (deliverable cleared the audit)
   *   - bounce → in_review → in_progress (owner reworks; reviewRound is preserved
   *              from the divert so the reworked re-submit auto-passes — 1-bounce cap)
   *
   * Self-pass is impossible: the caller must NOT be the task owner. (No reviewer-id
   * column in the MVP — any independent agent may submit the verdict; the owner is
   * the only one barred.)
   */
  app.post('/internal/agent-api/tasks/review', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const body = request.body as { channel?: unknown; number?: unknown; verdict?: unknown; feedback?: unknown } | null;
    if (!body?.channel || typeof body.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel is required' } });
    }
    if (body.number === undefined || body.number === null || typeof body.number !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'number is required' } });
    }
    if (body.verdict !== 'pass' && body.verdict !== 'bounce') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: "verdict must be 'pass' or 'bounce'" } });
    }
    const taskNumber = body.number as number;
    const verdict = body.verdict as 'pass' | 'bounce';
    const feedback = typeof body.feedback === 'string' ? body.feedback : '';

    const resolved = await resolveAgentChannelTarget(body.channel, auth.agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    const task = await findTaskByNumber(channelId, taskNumber);
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: `Task #${taskNumber} not found in this channel` } });
    }

    // The task must be awaiting review.
    if (task.status !== 'in_review') {
      return reply.code(409).send({
        error: { code: 'TASK_NOT_IN_REVIEW', message: `Task #${taskNumber} is '${task.status}', not in_review` },
      });
    }

    // Self-pass guard: the owner cannot review (and thus pass) their own task.
    if (task.ownerInstanceId && task.ownerInstanceId === auth.agent.id) {
      return reply.code(403).send({
        error: { code: 'CANNOT_REVIEW_OWN_TASK', message: 'You cannot review a task you own' },
      });
    }

    const nextStatus = verdict === 'pass' ? 'done' : 'in_progress';
    const transition = validateTaskTransition(task.status, nextStatus);
    if (!transition.ok) {
      return reply.code(400).send({
        error: { code: 'INVALID_TASK_TRANSITION', message: `Cannot transition from '${task.status}' to '${nextStatus}'` },
      });
    }

    // Apply. reviewRound is intentionally NOT changed here — it was incremented
    // at divert, so a bounce→rework→re-submit sees reviewRound >= MAX and closes.
    await db.controlTask.update({ where: { id: task.id }, data: { status: nextStatus } });

    await emitTaskLifecycleMessage({
      kind: 'status',
      workroomId,
      channelId,
      task: { number: taskNumber, status: nextStatus },
    });

    await writeTaskEventAndBroadcast({
      workroomId,
      topic: 'task.updated',
      payload: {
        task_id: task.id,
        channel_id: channelId,
        status: serverToSlockStatus(nextStatus),
        assignee_id: task.ownerInstanceId,
      },
    });

    // status_changed routes the wake: on bounce the owner (assignee) is woken to
    // rework with the reviewer's feedback; on pass it's the normal close event.
    await writeTaskEventAndBroadcast({
      workroomId,
      topic: 'task.status_changed',
      payload: {
        task_id: task.id,
        channel_id: channelId,
        workroom_id: workroomId,
        from: serverToSlockStatus(task.status),
        to: serverToSlockStatus(nextStatus),
        actor_id: auth.agent.id,
        assignee_id: task.ownerInstanceId,
        review_verdict: verdict,
        review_feedback: feedback,
      },
    });

    return reply.code(200).send({ ok: true, status: serverToSlockStatus(nextStatus), verdict });
  });
}
