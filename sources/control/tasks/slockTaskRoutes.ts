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
 * Auth:
 *   Reads  (GET): authorizeControlRead (machine_token OR dev_ctl_ on the allowlist).
 *   Writes (POST/PATCH): op_sess_ (per-command) OR machine_token. dev_ctl_ → hard 403.
 *   Mirrors messageRoutes auth ordering (dev_ctl_ 403 first, then op_sess_, then machine).
 *
 * Validation: the task/channel must belong to :wid; 404 otherwise.
 * Events: writes publish 'task.created' / 'task.updated' (write-before-broadcast).
 */

import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { authorizeOperatorWrite } from '@/control/operatorSessions/operatorSessionAuth';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { slockToServerStatus, serverToSlockStatus } from './slockTaskStatus';

// ── Wire shape ──────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  channelId: string | null;
  title: string;
  status: string;
  ownerInstanceId: string | null;
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

/** Format a task row as the S3 Slock wire shape (snake_case, Slock-vocab status). */
function formatTask(t: TaskRow, assigneeNames: Map<string, string>) {
  return {
    id: t.id,
    channel_id: t.channelId,
    title: t.title,
    status: serverToSlockStatus(t.status),       // Slock vocab
    slock_status: serverToSlockStatus(t.status), // alias so iOS reads `slock_status` uniformly across endpoints
    assignee_id: t.ownerInstanceId,
    assignee_display_name: t.ownerInstanceId ? (assigneeNames.get(t.ownerInstanceId) ?? null) : null,
    // ControlTask has no stored creator identity → null (not fabricated). See taskRoutes.ts note.
    creator_id: null as string | null,
    created_at: t.createdAt.toISOString(),
    thread_id: t.threadId,
  };
}

/** Re-fetch a task by id and return its full Slock wire shape (or null if it vanished). */
async function fetchFormattedTask(id: string) {
  const row = await db.controlTask.findUnique({
    where: { id },
    select: { id: true, channelId: true, title: true, status: true, ownerInstanceId: true, threadId: true, createdAt: true },
  });
  if (!row) return null;
  const names = await resolveAssigneeDisplayNames([row.ownerInstanceId]);
  return formatTask(row, names);
}

// ── Event publish (write-before-broadcast; mirrors messageRoutes) ────────────────

/**
 * Persist a task event (awaited → exists before the route returns) then fire-and-forget
 * the WS broadcast (non-fatal; clients catch up via GET). topic: 'task.created' | 'task.updated'.
 */
async function writeTaskEventAndBroadcast(topic: 'task.created' | 'task.updated', task: {
  id: string;
  workroomId: string;
  channelId: string | null;
  status: string;
  ownerInstanceId: string | null;
}): Promise<void> {
  const event = await publishControlEvent({
    workroomId: task.workroomId,
    eventId: randomUUID(),
    topic,
    payload: {
      task_id: task.id,
      channel_id: task.channelId,
      status: serverToSlockStatus(task.status),
      assignee_id: task.ownerInstanceId,
    },
  });

  if (!event.idempotent) {
    workroomBroadcaster.broadcast(task.workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function slockTaskRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/channels/:cid/tasks
   * Tasks belonging to ONE channel. authorizeControlRead (machine OR dev_ctl_ allowlist).
   */
  app.get('/api/v1/workrooms/:wid/channels/:cid/tasks', async (request, reply) => {
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { wid, cid } = request.params as { wid: string; cid: string };

    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    const tasks = await db.controlTask.findMany({
      where: { workroomId: wid, channelId: cid },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, channelId: true, title: true, status: true, ownerInstanceId: true, threadId: true, createdAt: true },
    });

    const names = await resolveAssigneeDisplayNames(tasks.map((t) => t.ownerInstanceId));
    return { tasks: tasks.map((t) => formatTask(t, names)) };
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/tasks   body { title }
   * Create a task in a channel (status 'todo'). Auth: op_sess_('create_task') OR machine.
   * dev_ctl_ → hard 403. Validates the channel belongs to :wid (404 otherwise).
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/tasks', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };
    const authHeader = request.headers.authorization;

    // dev_ctl_ → hard 403 first (defense-in-depth; mirrors messageRoutes ordering).
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (rawToken.startsWith('dev_ctl_')) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }

    // op_sess_ first, then machine fallback.
    const opAuth = await authorizeOperatorWrite(request, { command: 'create_task', workroomId: wid });
    if (!opAuth.ok) {
      if (opAuth.status === 403) {
        return reply.code(403).send({ error: { code: opAuth.code, message: opAuth.message } });
      }
      // 401 from op path → try machine.
      const machine = await verifyMachineToken(authHeader);
      if (!machine) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }
      const access = await requireMachineAccessToWorkroom(machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    const body = request.body as { title?: unknown } | null;
    if (!body?.title || typeof body.title !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'title is required' } });
    }

    // Validate the channel belongs to this workroom (404 otherwise).
    const channel = await db.controlChannel.findUnique({ where: { id: cid }, select: { workroomId: true } });
    if (!channel || channel.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    const task = await db.controlTask.create({
      data: { workroomId: wid, channelId: cid, title: body.title, status: 'todo' },
      select: { id: true, channelId: true, title: true, status: true, ownerInstanceId: true, threadId: true, createdAt: true },
    });

    await writeTaskEventAndBroadcast('task.created', {
      id: task.id, workroomId: wid, channelId: task.channelId, status: task.status, ownerInstanceId: task.ownerInstanceId,
    });

    const names = await resolveAssigneeDisplayNames([task.ownerInstanceId]);
    return reply.code(201).send(formatTask(task, names));
  });

  /**
   * PATCH /api/v1/workrooms/:wid/tasks/:id/status   body { status }  (Slock vocab)
   * Translate + update. Auth: op_sess_('update_task_status') OR machine. dev_ctl_ → 403.
   * Validates the task belongs to :wid (404 otherwise).
   */
  app.patch('/api/v1/workrooms/:wid/tasks/:id/status', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };
    const guard = await authorizeTaskWrite(request, reply, wid, 'update_task_status');
    if (!guard.ok) return guard.sent;

    const body = request.body as { status?: unknown } | null;
    if (!body?.status || typeof body.status !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'status is required' } });
    }
    const serverStatus = slockToServerStatus(body.status);
    if (serverStatus === null) {
      return reply.code(400).send({ error: { code: 'INVALID_STATUS', message: 'Unknown status' } });
    }

    const task = await db.controlTask.findUnique({ where: { id }, select: { workroomId: true } });
    if (!task || task.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }

    const updated = await db.controlTask.update({
      where: { id },
      data: { status: serverStatus },
      select: { id: true, channelId: true, status: true, ownerInstanceId: true },
    });

    await writeTaskEventAndBroadcast('task.updated', {
      id: updated.id, workroomId: wid, channelId: updated.channelId, status: updated.status, ownerInstanceId: updated.ownerInstanceId,
    });

    return reply.code(200).send((await fetchFormattedTask(id))!);
  });

  /**
   * PATCH /api/v1/workrooms/:wid/tasks/:id/assignee   body { assignee_id }  (nullable)
   * Set/clear ownerInstanceId. Auth: op_sess_('assign_task') OR machine. dev_ctl_ → 403.
   * Validates the task belongs to :wid (404 otherwise).
   */
  app.patch('/api/v1/workrooms/:wid/tasks/:id/assignee', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };
    const guard = await authorizeTaskWrite(request, reply, wid, 'assign_task');
    if (!guard.ok) return guard.sent;

    const body = request.body as { assignee_id?: unknown } | null;
    // assignee_id is nullable: explicit null clears, a string sets. Missing key → 400.
    if (!body || !('assignee_id' in body)) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'assignee_id is required (may be null)' } });
    }
    const assigneeId = body.assignee_id;
    if (assigneeId !== null && typeof assigneeId !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'assignee_id must be a string or null' } });
    }

    const task = await db.controlTask.findUnique({ where: { id }, select: { workroomId: true } });
    if (!task || task.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }

    const updated = await db.controlTask.update({
      where: { id },
      data: { ownerInstanceId: assigneeId },
      select: { id: true, channelId: true, status: true, ownerInstanceId: true },
    });

    await writeTaskEventAndBroadcast('task.updated', {
      id: updated.id, workroomId: wid, channelId: updated.channelId, status: updated.status, ownerInstanceId: updated.ownerInstanceId,
    });

    return reply.code(200).send((await fetchFormattedTask(id))!);
  });
}

// ── Shared write-auth guard (op_sess_ per-command OR machine; dev_ctl_ → 403) ────

type TaskWriteGuard =
  | { ok: true }
  | { ok: false; sent: unknown };

/**
 * Authorize a task write: dev_ctl_ → hard 403, then op_sess_(command), then machine fallback.
 * On failure, sends the reply and returns { ok:false, sent } so the caller can `return guard.sent`.
 * Mirrors the messageRoutes write auth ordering exactly.
 */
async function authorizeTaskWrite(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  wid: string,
  command: string,
): Promise<TaskWriteGuard> {
  const authHeader = request.headers.authorization;

  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (rawToken.startsWith('dev_ctl_')) {
    return { ok: false, sent: reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }) };
  }

  const opAuth = await authorizeOperatorWrite(request, { command, workroomId: wid });
  if (opAuth.ok) return { ok: true };

  if (opAuth.status === 403) {
    return { ok: false, sent: reply.code(403).send({ error: { code: opAuth.code, message: opAuth.message } }) };
  }

  // 401 from op path → try machine.
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, sent: reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }) };
  }
  const access = await requireMachineAccessToWorkroom(machine, wid);
  if (!access.ok) {
    return { ok: false, sent: reply.code(access.status).send({ error: access.error }) };
  }
  return { ok: true };
}
