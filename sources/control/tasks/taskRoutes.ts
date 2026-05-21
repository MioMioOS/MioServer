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

const CLAIMABLE_STATUSES = ['todo', 'in_progress', 'waiting_approval', 'in_review'];
const NON_CLAIMABLE_STATUSES = ['done', 'canceled'];

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
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
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

    return {
      tasks: tasks.map((t) => ({
        task_id: t.id,
        title: t.title,
        status: t.status,
        owner_instance_id: t.ownerInstanceId,
        owner_role: t.ownerRole,
        created_at: t.createdAt.toISOString(),
        updated_at: t.updatedAt.toISOString(),
      })),
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
    const task = await db.controlTask.findUnique({ where: { id } });
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }

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

    const task = await db.controlTask.findUnique({ where: { id } });
    if (!task) {
      return reply.code(404).send({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    }
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
