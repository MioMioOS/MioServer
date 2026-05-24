/**
 * Task API — control plane
 *
 * HARD POINT: Task Claim is a DB-level Compare-And-Swap.
 *
 *   Prisma updateMany:
 *     WHERE id = $taskId
 *       AND owner_instance_id IS NULL
 *       AND status NOT IN ('done', 'canceled')
 *     SET owner_instance_id = $agentId, status = 'in_progress'
 *
 *   PostgreSQL executes this atomically: 0 rows affected → 409 CONFLICT.
 *   No application-layer check-then-write. No TOCTOU race.
 *
 *   Concurrent agents both call claim → DB row lock serializes them →
 *   winner gets count=1 (200 OK), loser gets count=0 (409).
 *
 * Endpoints:
 *   POST   /api/v1/workrooms/:workroomId/tasks   → create task
 *   GET    /api/v1/workrooms/:workroomId/tasks   → list tasks (filter by status/owner)
 *   GET    /api/v1/tasks/:id                     → get task detail
 *   PATCH  /api/v1/tasks/:id                     → update status / title / description
 *   POST   /api/v1/tasks/:id/claim               → *** CAS CLAIM (hard point) ***
 *   POST   /api/v1/tasks/:id/unclaim             → release claim
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { SUMMARY_TERMINAL_STATUSES } from '@/control/actionStatusSets';
import { serverToSlockStatus } from './slockTaskStatus';

const CLAIMABLE_STATUSES = ['todo', 'in_progress', 'waiting_approval', 'in_review'];
const NON_CLAIMABLE_STATUSES = ['done', 'canceled'];

/**
 * #186 — per-task ATTENTION signal for the attention-first Home (Option A, PM/Aaron/Nova/Research
 * ratified). The Home buckets each task into Attention / Active / Recent. Bucketing must be
 * ACTION-DRIVEN (not a task-status proxy): a task is in Attention if any of its actions needs human
 * attention. Computed server-side (single source of truth; no client N+1 / join — ControlAction has
 * no task_id over the wire, so the client cannot compute this itself).
 *
 * Attention admission taxonomy (Research §2a / #131§6/#136§4 — designed WIDE so P1 dims don't
 * re-migrate). Enum values are FROZEN as the cross-team contract:
 *   ① 'needs_human'        ← V1 (computable from action.status)
 *   ② 'unresolved_failure' ← P1 (needs a resolution flag; not yet modeled)
 *   ③ 'auth_config_blocked'← P1
 *   ④ 'stale'              ← P1 (client-side / capabilities-changed signal)
 * `attention_reason` is an extensible string[] (a SET — a task may match multiple values); V1 only
 * ever contains 'needs_human'. Empty array == "none" (task not in Attention). Field name matches the
 * cross-team frozen contract (Research §2a / PM); it is a multi-value set, hence an array.
 *
 * Client bucketing contract:
 *   Attention = attention_reason.length > 0
 *   Active    = attention_reason empty AND pending_action_count > 0   (in-flight, not blocking)
 *   Recent    = neither (all actions terminal / no actions)
 */
const ATTENTION_REASON_NEEDS_HUMAN = 'needs_human';

type TaskAttention = { attention_reason: string[]; pending_attention_count: number; pending_action_count: number };

/** Aggregate per-task attention signal in ONE query (no N+1) for the given task ids. */
async function computeTaskAttention(workroomId: string, taskIds: string[]): Promise<Map<string, TaskAttention>> {
  const result = new Map<string, TaskAttention>();
  if (taskIds.length === 0) return result;
  const actions = await db.controlAction.findMany({
    where: { workroomId, taskId: { in: taskIds } },
    select: { taskId: true, status: true },
  });
  for (const a of actions) {
    if (!a.taskId) continue;
    let e = result.get(a.taskId);
    if (!e) { e = { attention_reason: [], pending_attention_count: 0, pending_action_count: 0 }; result.set(a.taskId, e); }
    // Attention dim (V1): needs_human.
    if (a.status === 'needs_human') {
      if (!e.attention_reason.includes(ATTENTION_REASON_NEEDS_HUMAN)) e.attention_reason.push(ATTENTION_REASON_NEEDS_HUMAN);
      e.pending_attention_count += 1;
    }
    // In-flight: any non-terminal action (proposed/approved/fired/needs_human/reconciling).
    if (!SUMMARY_TERMINAL_STATUSES.has(a.status)) e.pending_action_count += 1;
  }
  return result;
}

/**
 * #188① — resolve owner_instance_id (a ControlAgent id) → a human-readable display name for the
 * task-row subtitle, so the main UI shows "Demo Ops Agent · 3m ago" instead of a bare UUID
 * (#131§6 "Owner readable"). One batched query (no N+1). null when the owner is unset OR the agent
 * can't be resolved → client hides the subtitle (never falls back to the raw UUID). Prefers
 * displayName, then name; never returns the id.
 */
async function resolveOwnerDisplayNames(ownerIds: Array<string | null>): Promise<Map<string, string>> {
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

export async function taskRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/workrooms/:workroomId/tasks
   * Create a new task in a workroom.
   * Auth: machine token (agent session creates tasks).
   */
  app.post('/api/v1/workrooms/:workroomId/tasks', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
    const body = request.body as {
      title: string;
      description?: string;
      owner_role?: string;
      goal_id?: string;
      source_message_id?: string;
    };

    const workroom = await db.controlWorkroom.findUnique({ where: { id: workroomId } });
    if (!workroom) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, workroomId, { orgId: workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    const task = await db.controlTask.create({
      data: {
        workroomId,
        title: body.title,
        description: body.description ?? '',
        ownerRole: body.owner_role,
        goalId: body.goal_id,
        sourceMessageId: body.source_message_id,
        status: 'todo',
      },
    });

    return reply.code(201).send({
      task_id: task.id,
      workroom_id: task.workroomId,
      title: task.title,
      status: task.status,
      owner_instance_id: task.ownerInstanceId,
      created_at: task.createdAt.toISOString(),
    });
  });

  /**
   * GET /api/v1/workrooms/:workroomId/tasks
   * List tasks. Filter by status and/or owner_instance_id.
   */
  app.get('/api/v1/workrooms/:workroomId/tasks', async (request, reply) => {
    // Dual-auth: machine_token (full) OR dev_control_token (read-only, allowlist + workroom-scope).
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { workroomId } = request.params as { workroomId: string };

    // machine mode: enforce org/workroom access. dev mode: path workroomId already
    // matched against token.workroomId in authorizeControlRead.
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, workroomId);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    const query = request.query as { status?: string; owner_instance_id?: string };

    const tasks = await db.controlTask.findMany({
      where: {
        workroomId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.owner_instance_id ? { ownerInstanceId: query.owner_instance_id } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    // #186: per-task action-driven attention signal (one batched query, no N+1).
    const attention = await computeTaskAttention(workroomId, tasks.map((t) => t.id));
    // #188①: resolve owner_instance_id → readable agent name (one batched query, no N+1).
    const ownerNames = await resolveOwnerDisplayNames(tasks.map((t) => t.ownerInstanceId));

    return {
      tasks: tasks.map((t) => {
        const a = attention.get(t.id);
        const ownerDisplayName = t.ownerInstanceId ? (ownerNames.get(t.ownerInstanceId) ?? null) : null;
        return {
          // ── S3 Slock wire shape (workroom-aggregate = iOS tasks(channelId:nil)) ──
          // Added ADDITIVELY. `status` is LEFT as the server vocab below (the pre-S3
          // attention-first Home / legacy ControlPlaneClient decodes `status` as server vocab —
          // must not change). The Slock (iOS) vocab is exposed as `slock_status`; the iOS
          // LiveTaskRepository reads `slock_status`.
          id: t.id,
          channel_id: t.channelId,
          slock_status: serverToSlockStatus(t.status),
          assignee_id: t.ownerInstanceId,
          assignee_display_name: ownerDisplayName,
          // S3: ControlTask has no creator column. We do not have a stored creator identity, so
          // creator_id is null rather than a fabricated/derived value. (Adding a real creator
          // column is a follow-up if the iOS Tasks UI needs to attribute task authorship.)
          creator_id: null,
          thread_id: t.threadId,

          // ── Pre-S3 attention-first Home contract (unchanged; #186 / #188①) ──
          task_id: t.id,
          title: t.title,
          status: t.status, // server vocab — legacy ControlPlaneClient decodes this
          owner_instance_id: t.ownerInstanceId,
          owner_role: t.ownerRole,
          // #188①: human-readable owner for the task-row subtitle; null → client hides it (no raw UUID).
          owner_display_name: ownerDisplayName,
          created_at: t.createdAt.toISOString(),
          updated_at: t.updatedAt.toISOString(),
          // #186 attention-first signal (action-driven). Empty/0 when the task has no actions.
          attention_reason: a?.attention_reason ?? [],
          pending_attention_count: a?.pending_attention_count ?? 0,
          pending_action_count: a?.pending_action_count ?? 0,
        };
      }),
    };
  });

  /**
   * GET /api/v1/tasks/:id
   * Get a single task by ID.
   */
  app.get('/api/v1/tasks/:id', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const task = await db.controlTask.findUnique({
      where: { id },
      include: { workroom: { select: { orgId: true } } },
    });
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, task.workroomId, { orgId: task.workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    return {
      task_id: task.id,
      workroom_id: task.workroomId,
      title: task.title,
      description: task.description,
      status: task.status,
      owner_instance_id: task.ownerInstanceId,
      owner_role: task.ownerRole,
      goal_id: task.goalId,
      source_message_id: task.sourceMessageId,
      thread_id: task.threadId,
      linked_session_ids: task.linkedSessionIds,
      created_at: task.createdAt.toISOString(),
      updated_at: task.updatedAt.toISOString(),
    };
  });

  /**
   * PATCH /api/v1/tasks/:id
   * Update task: status, title, description.
   * Does NOT update ownership — use /claim and /unclaim for that.
   */
  app.patch('/api/v1/tasks/:id', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const body = request.body as {
      status?: string;
      title?: string;
      description?: string;
    };

    const task = await db.controlTask.findUnique({
      where: { id },
      include: { workroom: { select: { orgId: true } } },
    });
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, task.workroomId, { orgId: task.workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    if (task.status === 'done' || task.status === 'canceled') {
      return reply.code(422).send({ error: { code: 'TASK_TERMINAL', message: 'Cannot update a done or canceled task' } });
    }

    const updated = await db.controlTask.update({
      where: { id },
      data: {
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
    });

    return {
      task_id: updated.id,
      status: updated.status,
      title: updated.title,
      updated_at: updated.updatedAt.toISOString(),
    };
  });

  /**
   * POST /api/v1/tasks/:id/claim
   *
   * *** HARD POINT: CAS CLAIM ***
   *
   * Atomic Compare-And-Swap via Prisma updateMany WHERE clause.
   * PostgreSQL evaluates the WHERE predicate as a single row-level operation.
   *
   * Safety invariant: owner_instance_id transitions from NULL → agentId
   * in one DB statement. Any concurrent claim on the same task hits count=0
   * and gets 409. The application never reads-then-writes ownership.
   *
   * Body: { agent_instance_id: string }
   */
  app.post('/api/v1/tasks/:id/claim', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: taskId } = request.params as { id: string };
    const { agent_instance_id } = request.body as { agent_instance_id: string };

    if (!agent_instance_id) {
      return reply.code(400).send({ error: { code: 'MISSING_AGENT_ID', message: 'agent_instance_id is required' } });
    }

    // Verify agent exists in this org/machine context
    const agent = await db.controlAgent.findUnique({ where: { id: agent_instance_id } });
    if (!agent) {
      return reply.code(404).send({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
    }

    // Org access guard: fetch task to get workroom context
    const taskForAuth = await db.controlTask.findUnique({
      where: { id: taskId },
      include: { workroom: { select: { orgId: true } } },
    });
    if (!taskForAuth) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }
    const access = await requireMachineAccessToWorkroom(machine, taskForAuth.workroomId, { orgId: taskForAuth.workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    // *** CAS CLAIM — single atomic DB statement ***
    // WHERE owner_instance_id IS NULL ensures only one winner.
    // WHERE status NOT IN ('done','canceled') prevents stale claims.
    const result = await db.controlTask.updateMany({
      where: {
        id: taskId,
        ownerInstanceId: null,                // CAS: must be unclaimed
        status: { notIn: NON_CLAIMABLE_STATUSES }, // must be claimable
      },
      data: {
        ownerInstanceId: agent_instance_id,
        status: 'in_progress',
      },
    });

    if (result.count === 0) {
      // Either already claimed, task doesn't exist, or task is done/canceled.
      // Differentiate for caller.
      const task = await db.controlTask.findUnique({ where: { id: taskId } });
      if (!task) {
        return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
      }
      if (NON_CLAIMABLE_STATUSES.includes(task.status)) {
        return reply.code(409).send({
          error: {
            code: 'TASK_TERMINAL',
            message: `Task is ${task.status} and cannot be claimed`,
          },
        });
      }
      // Already has an owner
      return reply.code(409).send({
        error: {
          code: 'TASK_ALREADY_CLAIMED',
          message: 'Task is already claimed by another agent',
          current_owner_instance_id: task.ownerInstanceId,
        },
      });
    }

    const task = await db.controlTask.findUnique({ where: { id: taskId } });
    return {
      task_id: taskId,
      claimed: true,
      owner_instance_id: agent_instance_id,
      status: task?.status ?? 'in_progress',
      claimed_at: new Date().toISOString(),
    };
  });

  /**
   * POST /api/v1/tasks/:id/unclaim
   * Release the claim. Only the current owner may unclaim.
   * Sets status back to 'todo', clears owner_instance_id.
   */
  app.post('/api/v1/tasks/:id/unclaim', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: taskId } = request.params as { id: string };
    const { agent_instance_id } = request.body as { agent_instance_id: string };

    // Org access guard: fetch task to get workroom context
    const taskForAuth = await db.controlTask.findUnique({
      where: { id: taskId },
      include: { workroom: { select: { orgId: true } } },
    });
    if (!taskForAuth) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }
    const access = await requireMachineAccessToWorkroom(machine, taskForAuth.workroomId, { orgId: taskForAuth.workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    // CAS: only release if current owner matches
    const result = await db.controlTask.updateMany({
      where: {
        id: taskId,
        ownerInstanceId: agent_instance_id,   // must be current owner
        status: { notIn: NON_CLAIMABLE_STATUSES },
      },
      data: {
        ownerInstanceId: null,
        status: 'todo',
      },
    });

    if (result.count === 0) {
      const task = await db.controlTask.findUnique({ where: { id: taskId } });
      if (!task) {
        return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
      }
      return reply.code(409).send({
        error: {
          code: 'UNCLAIM_FORBIDDEN',
          message: 'Only the current owner can unclaim this task, or task is terminal',
        },
      });
    }

    return { task_id: taskId, unclaimed: true };
  });
}
