/**
 * Slock Task API — control plane (S3).
 *
 * The iOS Slock client speaks an UPPERCASE task-status vocabulary and a snake_case
 * task wire shape. These routes translate at the boundary (slockTaskStatus.ts) and
 * keep the server's stored vocab internal.
 *
 * Endpoints:
 *   GET   /api/v1/workrooms/:wid/channels/:cid/tasks   → tasks for ONE channel.
 *   POST  /api/v1/workrooms/:wid/channels/:cid/tasks   → create a task in a channel.
 *   PATCH /api/v1/workrooms/:wid/tasks/:id/status      → update status (Slock vocab).
 *   PATCH /api/v1/workrooms/:wid/tasks/:id/assignee    → set/clear assignee.
 *
 * (The workroom-aggregate GET /api/v1/workrooms/:wid/tasks lives in taskRoutes.ts —
 *  it already emits the S3 Slock wire shape additively. We do NOT re-register it here
 *  to avoid a Fastify duplicate-route error.)
 *
 * Auth (Slice 7 B2-b):
 *   Reads  (GET): userOrMachine — user_sess_ (workroom member) OR machine_token.
 *     Inline resolveActor preserves 401/403/404 status-code matrix (mirrors memberRoutes).
 *   Writes (POST/PATCH): authorizeTaskWrite — user_sess_ (workroom OWNER) OR machine_token.
 *     User non-owner → 403; missing/invalid → 401.
 *
 * Validation: the task/channel must belong to :wid; 404 otherwise.
 * Events: writes publish 'task.created' / 'task.updated' (write-before-broadcast).
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '@/storage/db';
import { resolveActor } from '@/auth/userOrMachine/resolveActor';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { slockToServerStatus, serverToSlockStatus } from './slockTaskStatus';
import { nextChannelTaskNumber } from './nextChannelTaskNumber';
import { emitTaskLifecycleMessage } from './taskMessageBridge';
import { writeTaskEventAndBroadcast } from './writeTaskEventAndBroadcast';
import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';

// ── Wire shape ──────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  channelId: string | null;
  title: string;
  status: string;
  ownerInstanceId: string | null;
  creatorInstanceId: string | null;
  threadId: string | null;
  createdAt: Date;
}

/**
 * Resolve assignee (ownerInstanceId → ControlAgent) display names in a batch (no N+1).
 * ownerInstanceId is @db.Uuid (FK → ControlAgent); a null/unresolvable owner → absent from the map.
 */
async function resolveAssigneeDisplayNames(ownerIds: Array<string | null>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const ids = [...new Set(ownerIds.filter((x): x is string => !!x))];
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

const resolveAgentDisplayNames = resolveAssigneeDisplayNames;

/** Format a task row as the S3 Slock wire shape (snake_case, Slock-vocab status). */
function formatTask(t: TaskRow, agentNames: Map<string, string>) {
  return {
    id: t.id,
    channel_id: t.channelId,
    title: t.title,
    status: serverToSlockStatus(t.status),       // Slock vocab
    slock_status: serverToSlockStatus(t.status), // alias so iOS reads `slock_status` uniformly across endpoints
    assignee_id: t.ownerInstanceId,
    assignee_display_name: t.ownerInstanceId ? (agentNames.get(t.ownerInstanceId) ?? null) : null,
    owner_instance_id: t.ownerInstanceId,
    owner_display_name: t.ownerInstanceId ? (agentNames.get(t.ownerInstanceId) ?? null) : null,
    creator_id: t.creatorInstanceId,
    creator_display_name: t.creatorInstanceId ? (agentNames.get(t.creatorInstanceId) ?? null) : null,
    creator_instance_id: t.creatorInstanceId,
    created_at: t.createdAt.toISOString(),
    thread_id: t.threadId,
  };
}

/** Re-fetch a task by id and return its full Slock wire shape (or null if it vanished). */
async function fetchFormattedTask(id: string) {
  const row = await db.controlTask.findUnique({
    where: { id },
    select: { id: true, channelId: true, title: true, status: true, ownerInstanceId: true, creatorInstanceId: true, threadId: true, createdAt: true },
  });
  if (!row) return null;
  const names = await resolveAgentDisplayNames([row.ownerInstanceId, row.creatorInstanceId]);
  return formatTask(row, names);
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function slockTaskRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/channels/:cid/tasks
   * Tasks belonging to ONE channel. userOrMachine read (user_sess_ member OR machine_token).
   *
   * Inline resolution (not requireActor) so we preserve route-specific status codes
   * mirroring the memberRoutes pattern: no-bearer → 401; bad-token → 401; user
   * non-member → 403; machine cross-org → 403; workroom missing → 404. resolveActor's
   * uniform-401 collapse would regress the existing test matrix.
   */
  app.get('/api/v1/workrooms/:wid/channels/:cid/tasks', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };
    const guard = await resolveTaskReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

    const tasks = await db.controlTask.findMany({
      where: { workroomId: wid, channelId: cid },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, channelId: true, title: true, status: true, ownerInstanceId: true, creatorInstanceId: true, threadId: true, createdAt: true },
    });

    const names = await resolveAgentDisplayNames([
      ...tasks.map((t) => t.ownerInstanceId),
      ...tasks.map((t) => t.creatorInstanceId),
    ]);
    return { tasks: tasks.map((t) => formatTask(t, names)) };
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/tasks   body { title }
   * Create a task in a channel (status 'todo').
   * Auth: user_sess_ (workroom OWNER) OR machine_token (via authorizeTaskWrite).
   * Validates the channel belongs to :wid (404 otherwise).
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/tasks', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const subject = await authorizeTaskWrite(request, { workroomId: wid, command: 'create_task' });
    if (!subject.ok) return reply.code(subject.status).send({ error: subject.error });

    const body = request.body as { title?: unknown; owner_instance_id?: unknown; attach_to_message_id?: unknown } | null;
    if (!body?.title || typeof body.title !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'title is required' } });
    }

    // Optional initial owner (M5): accept owner_instance_id on create so callers can
    // create-and-assign atomically. Null/missing → unassigned (existing behavior).
    const initialOwner: string | null =
      typeof body.owner_instance_id === 'string' && body.owner_instance_id.length > 0
        ? body.owner_instance_id
        : null;

    // Bug-2 Thread feature: optional attach_to_message_id pins the new task to
    // an existing message in the same channel. The server additionally writes a
    // system_task_created reply under that message so reply_count increments
    // and iOS surfaces the thread.
    const attachToMessageId: string | null =
      typeof body.attach_to_message_id === 'string' && body.attach_to_message_id.length > 0
        ? body.attach_to_message_id
        : null;

    // Validate the channel belongs to this workroom (404 otherwise).
    const channel = await db.controlChannel.findUnique({ where: { id: cid }, select: { workroomId: true } });
    if (!channel || channel.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    // Validate the attach target message belongs to THIS channel (not just this workroom)
    // — the thread under it must be in the channel iOS will fetch replies from.
    if (attachToMessageId) {
      const parentMsg = await db.controlMessage.findUnique({
        where: { id: attachToMessageId },
        select: { id: true, channelId: true, workroomId: true },
      });
      if (!parentMsg || parentMsg.channelId !== cid || parentMsg.workroomId !== wid) {
        return reply.code(404).send({
          error: { code: 'ATTACH_MESSAGE_NOT_FOUND', message: 'attach_to_message_id not found in this channel' },
        });
      }
    }

    // Allocate per-channel number inside a transaction (serialized via FOR UPDATE on
    // the channel row — mirrors agentApiTasks.ts A5 pattern).
    let task!: { id: string; channelId: string | null; title: string; status: string; ownerInstanceId: string | null; creatorInstanceId: string | null; threadId: string | null; createdAt: Date; number: number | null };
    await db.$transaction(async (tx) => {
      const num = await nextChannelTaskNumber(tx, cid);
      task = await tx.controlTask.create({
        data: {
          workroomId: wid,
          channelId: cid,
          title: body.title as string,
          status: 'todo',
          number: num,
          ownerInstanceId: initialOwner,
          parentMessageId: attachToMessageId,
        },
        select: { id: true, channelId: true, title: true, status: true, ownerInstanceId: true, creatorInstanceId: true, threadId: true, createdAt: true, number: true },
      });
    });

    // Actor id (creator) — for task.created.created_by and task.assigned.assigner_id.
    const actorId: string = subject.subject.kind === 'user' ? subject.subject.userId : subject.subject.machineId;

    await writeTaskEventAndBroadcast({
      workroomId: wid,
      topic: 'task.created',
      payload: {
        task_id: task.id,
        channel_id: task.channelId,
        workroom_id: wid,
        title: task.title,
        status: serverToSlockStatus(task.status),
        assignee_id: task.ownerInstanceId,
        owner_id: task.ownerInstanceId,    // alias for M5 wake-reason payload
        created_by: actorId,
      },
    });

    // M5: if created with an initial assignee, ALSO emit task.assigned so the
    // daemon can wake the assignee (the create wake alone may be filtered out
    // by relevance gates for non-owner channel members).
    if (initialOwner) {
      await writeTaskEventAndBroadcast({
        workroomId: wid,
        topic: 'task.assigned',
        payload: {
          task_id: task.id,
          channel_id: task.channelId,
          workroom_id: wid,
          assignee_id: initialOwner,
          assigner_id: actorId,
        },
      });
    }

    // Emit 📋 bridge message so agents see iOS-created tasks (best-effort, after commit).
    if (task.number !== null) {
      await emitTaskLifecycleMessage({
        kind: 'created',
        workroomId: wid,
        channelId: task.channelId,
        tasks: [{ number: task.number, title: task.title }],
      });
    }

    // Bug-2 Thread feature: when the task is attached to a message, write a
    // system_task_created reply under that parent so the parent's reply_count
    // increments and iOS shows the thread inline. Same channel as the task.
    // Best-effort: failure here must not roll back the task write.
    if (attachToMessageId && task.channelId && task.number !== null) {
      try {
        const sysRow = await insertSystemMessage({
          workroomId: wid,
          channelId: task.channelId,
          content: `1 new task created: #${task.number} "${task.title}"`,
          parentMessageId: attachToMessageId,
        });
        await writeEventAndBroadcast(sysRow);
      } catch (err) {
        console.error('[slockTaskRoutes] failed to emit system_task_created thread message:', err);
      }
    }

    const names = await resolveAgentDisplayNames([task.ownerInstanceId, task.creatorInstanceId]);
    return reply.code(201).send(formatTask(task, names));
  });

  /**
   * PATCH /api/v1/workrooms/:wid/tasks/:id/status   body { status }  (Slock vocab)
   * Translate + update. Auth: user_sess_ (workroom OWNER) OR machine_token.
   * Validates the task belongs to :wid (404 otherwise).
   */
  app.patch('/api/v1/workrooms/:wid/tasks/:id/status', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    const subject = await authorizeTaskWrite(request, { workroomId: wid, command: 'update_task_status' });
    if (!subject.ok) return reply.code(subject.status).send({ error: subject.error });

    const body = request.body as { status?: unknown } | null;
    if (!body?.status || typeof body.status !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'status is required' } });
    }
    const serverStatus = slockToServerStatus(body.status);
    if (serverStatus === null) {
      return reply.code(400).send({ error: { code: 'INVALID_STATUS', message: 'Unknown status' } });
    }

    const task = await db.controlTask.findUnique({ where: { id }, select: { workroomId: true, status: true } });
    if (!task || task.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }
    const prevStatus = task.status;

    const updated = await db.controlTask.update({
      where: { id },
      data: { status: serverStatus },
      select: { id: true, channelId: true, status: true, ownerInstanceId: true, number: true },
    });

    await writeTaskEventAndBroadcast({
      workroomId: wid,
      topic: 'task.updated',
      payload: {
        task_id: updated.id,
        channel_id: updated.channelId,
        status: serverToSlockStatus(updated.status),
        assignee_id: updated.ownerInstanceId,
      },
    });

    // M5: dedicated status_changed event for autonomous wake routing.
    if (prevStatus !== updated.status) {
      const actorId: string = subject.subject.kind === 'user' ? subject.subject.userId : subject.subject.machineId;
      await writeTaskEventAndBroadcast({
        workroomId: wid,
        topic: 'task.status_changed',
        payload: {
          task_id: updated.id,
          channel_id: updated.channelId,
          workroom_id: wid,
          from: serverToSlockStatus(prevStatus),
          to: serverToSlockStatus(updated.status),
          actor_id: actorId,
          assignee_id: updated.ownerInstanceId,
        },
      });
    }

    // Fix B: emit the channel lifecycle system message so agents see operator status changes.
    if (updated.number !== null) {
      await emitTaskLifecycleMessage({
        kind: 'status',
        workroomId: wid,
        channelId: updated.channelId,
        task: { number: updated.number, status: serverStatus },   // server vocab, matches agent path
      });
    }

    return reply.code(200).send((await fetchFormattedTask(id))!);
  });

  /**
   * PATCH /api/v1/workrooms/:wid/tasks/:id/assignee   body { assignee_id }  (nullable)
   * Set/clear ownerInstanceId. Auth: user_sess_ (workroom OWNER) OR machine_token.
   * Validates the task belongs to :wid (404 otherwise).
   */
  app.patch('/api/v1/workrooms/:wid/tasks/:id/assignee', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    const subject = await authorizeTaskWrite(request, { workroomId: wid, command: 'assign_task' });
    if (!subject.ok) return reply.code(subject.status).send({ error: subject.error });

    const body = request.body as { assignee_id?: unknown } | null;
    // assignee_id is nullable: explicit null clears, a string sets. Missing key → 400.
    if (!body || !('assignee_id' in body)) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'assignee_id is required (may be null)' } });
    }
    const assigneeId = body.assignee_id;
    if (assigneeId !== null && typeof assigneeId !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'assignee_id must be a string or null' } });
    }

    const task = await db.controlTask.findUnique({ where: { id }, select: { workroomId: true, ownerInstanceId: true } });
    if (!task || task.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }
    const prevAssignee = task.ownerInstanceId;

    const updated = await db.controlTask.update({
      where: { id },
      data: { ownerInstanceId: assigneeId },
      select: { id: true, channelId: true, status: true, ownerInstanceId: true },
    });

    await writeTaskEventAndBroadcast({
      workroomId: wid,
      topic: 'task.updated',
      payload: {
        task_id: updated.id,
        channel_id: updated.channelId,
        status: serverToSlockStatus(updated.status),
        assignee_id: updated.ownerInstanceId,
      },
    });

    // M5: emit task.assigned when the assignee actually changed AND landed on a
    // non-null id (clears don't wake anyone). assigner_id is the actor making
    // the change.
    if (prevAssignee !== updated.ownerInstanceId && updated.ownerInstanceId !== null) {
      const actorId: string = subject.subject.kind === 'user' ? subject.subject.userId : subject.subject.machineId;
      await writeTaskEventAndBroadcast({
        workroomId: wid,
        topic: 'task.assigned',
        payload: {
          task_id: updated.id,
          channel_id: updated.channelId,
          workroom_id: wid,
          assignee_id: updated.ownerInstanceId,
          assigner_id: actorId,
          prev_assignee_id: prevAssignee,
        },
      });
    }

    return reply.code(200).send((await fetchFormattedTask(id))!);
  });

  /**
   * POST /api/v1/workrooms/:wid/tasks/:taskId/dispatch — 客户需求单派发(07-09)。
   *
   * owner 把 client 频道里已批准的需求单派发到内部频道:生成镜像任务
   * (mirrorOfTaskId → 需求单),指派给执行 agent(born in_progress + task.assigned
   * 唤醒),需求单转「开发中」并在客户频道发一行进度语。
   * Auth:user_sess_ workroom OWNER(仅真人可派发,agent/机器不可)。
   */
  app.post('/api/v1/workrooms/:wid/tasks/:taskId/dispatch', async (request, reply) => {
    const { wid, taskId } = request.params as { wid: string; taskId: string };
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith(`Bearer ${USER_SESSION_TOKEN_PREFIX}`)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
    const session = await resolveUserSession(authHeader);
    if (!session) return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId: wid } },
      select: { role: true },
    });
    if (mem?.role !== 'owner') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Owner only' } });
    }
    const body = request.body as { target_channel_id?: unknown; assignee_agent_id?: unknown } | null;
    const targetChannelId = typeof body?.target_channel_id === 'string' ? body.target_channel_id : null;
    const assigneeId = typeof body?.assignee_agent_id === 'string' ? body.assignee_agent_id : null;
    const source = await db.controlTask.findUnique({
      where: { id: taskId },
      select: { id: true, workroomId: true, channelId: true, number: true, title: true, description: true, mirrorOfTaskId: true },
    });
    if (!source || source.workroomId !== wid || !source.channelId) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }
    // 客户频道关联了内部频道 → 强制派发到它(忽略传入的 target,防止误发)。
    const sourceChannel = await db.controlChannel.findUnique({
      where: { id: source.channelId }, select: { linkedChannelId: true, type: true },
    });
    const effectiveTarget = sourceChannel?.type === 'client' && sourceChannel.linkedChannelId
      ? sourceChannel.linkedChannelId
      : targetChannelId;
    if (!effectiveTarget) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'target_channel_id is required (客户频道未关联内部频道时必须指定)' } });
    }
    const target = await db.controlChannel.findUnique({
      where: { id: effectiveTarget }, select: { id: true, workroomId: true, name: true },
    });
    if (!target || target.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Target channel not found' } });
    }
    // 幂等防重派:该需求单已有存活镜像 → 409。
    const existing = await db.controlTask.findFirst({
      where: { mirrorOfTaskId: source.id, status: { notIn: ['canceled', 'closed'] } },
      select: { id: true, number: true },
    });
    if (existing) {
      return reply.code(409).send({ error: { code: 'ALREADY_DISPATCHED', message: `Already dispatched as #${existing.number}` } });
    }

    let mirror!: { id: string; number: number | null; title: string };
    await db.$transaction(async (tx) => {
      const num = await nextChannelTaskNumber(tx, target.id);
      mirror = await tx.controlTask.create({
        data: {
          workroomId: wid,
          channelId: target.id,
          number: num,
          title: source.title,
          description: `${source.description ?? ''}\n\n[来源:客户需求单 #${source.number ?? '?'}]`.trim(),
          status: assigneeId ? 'in_progress' : 'todo',
          ownerInstanceId: assigneeId,
          mirrorOfTaskId: source.id,
        },
        select: { id: true, number: true, title: true },
      });
      // 需求单 → 开发中(客户可见的粗状态)。
      await tx.controlTask.update({ where: { id: source.id }, data: { status: 'in_progress' } });
    });

    await writeTaskEventAndBroadcast({
      workroomId: wid,
      topic: 'task.created',
      payload: {
        task_id: mirror.id, channel_id: target.id, workroom_id: wid,
        title: mirror.title, status: serverToSlockStatus(assigneeId ? 'in_progress' : 'todo'),
        assignee_id: assigneeId, owner_id: assigneeId, created_by: session.userId, source: 'dispatch',
      },
    });
    if (assigneeId) {
      await writeTaskEventAndBroadcast({
        workroomId: wid,
        topic: 'task.assigned',
        payload: { task_id: mirror.id, channel_id: target.id, workroom_id: wid, assignee_id: assigneeId, assigner_id: session.userId },
      });
    }
    await emitTaskLifecycleMessage({
      kind: 'created', workroomId: wid, channelId: target.id,
      tasks: [{ number: mirror.number ?? 0, title: mirror.title }],
    });
    // 客户频道进度语。
    try {
      const row = await insertSystemMessage({
        workroomId: wid, channelId: source.channelId,
        content: `📌 需求 #${source.number ?? '?'} 已排期,进入开发`,
      });
      await writeEventAndBroadcast({
        id: row.id, seq: row.seq, created_at: row.created_at,
        workroomId: wid, channelId: source.channelId,
        senderKind: 'system', senderId: 'system', content: row.content, mentions: [],
      });
    } catch { /* 进度语失败不影响派发 */ }

    return reply.send({ ok: true, mirror_task_id: mirror.id, mirror_number: mirror.number });
  });
}

// ── Read-auth resolver (user_sess_ member OR machine_token) ──────────────────────
//
// Inline path that preserves the route-specific status-code matrix (401/403/404),
// mirroring memberRoutes.ts. resolveActor exists but uniformly collapses to null →
// using it here would require duplicating the disambiguation logic at the caller.

type TaskReadResult =
  | { ok: true; subject: { kind: 'user'; userId: string } | { kind: 'machine'; machineId: string } }
  | { ok: false; status: number; error: { code: string; message: string } };

async function resolveTaskReadActor(req: FastifyRequest, workroomId: string): Promise<TaskReadResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const token = authHeader.slice(7);

  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return { ok: false, status: 401, error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } };
    }
    const wr = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { orgId: true } });
    if (!wr) {
      return { ok: false, status: 404, error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } };
    }
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId } },
    });
    if (!mem) {
      return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    return { ok: true, subject: { kind: 'user', userId: session.userId } };
  }

  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, subject: { kind: 'machine', machineId: machine.id } };
}

// ── Shared write-auth guard (user_sess_ owner OR machine fallback) ───────────────

export type TaskWriteSubject =
  | { kind: 'user'; userId: string }
  | { kind: 'machine'; machineId: string };

type TaskWriteResult =
  | { ok: true; subject: TaskWriteSubject }
  | { ok: false; status: number; error: { code: string; message: string } };

/**
 * Authorize a task WRITE. Two-actor ladder:
 *   1. user_sess_  → must be a workroom owner (per §6.2). Non-owner → 403.
 *   2. machine_token → must have org access to the workroom.
 *   3. anything else → 401.
 *
 * `command` parameter is kept for API compatibility / future per-command auditing
 * but is not currently checked against an allowlist (granular per-command grants
 * died with Slice 7's auth unification).
 */
export async function authorizeTaskWrite(
  req: FastifyRequest,
  opts: { workroomId: string; command: string },
): Promise<TaskWriteResult> {
  void opts.command; // reserved for future audit; user/machine path does not gate by command
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const token = authHeader.slice(7);

  // ── Path 1: user_sess_ ──
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const actor = await resolveActor(req, { workroomId: opts.workroomId });
    if (!actor || actor.kind !== 'user') {
      // Non-member user OR invalid session: 401 if session was bad, 403 if member missing.
      const session = await resolveUserSession(authHeader);
      if (!session) {
        return { ok: false, status: 401, error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } };
      }
      return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    if (actor.workroomRole !== 'owner') {
      return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    return { ok: true, subject: { kind: 'user', userId: actor.userId } };
  }

  // ── Path 2: machine_token ──
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const access = await requireMachineAccessToWorkroom(machine, opts.workroomId);
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, subject: { kind: 'machine', machineId: machine.id } };
}
