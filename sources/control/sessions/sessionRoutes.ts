/**
 * Sessions API — control plane agent sessions.
 *
 * A session represents a live agent runtime connection within a workroom.
 * Sessions have status: idle | running | waiting_for_user | blocked |
 *                       completed | failed | disconnected | reconnecting
 *
 * Key design notes:
 * - machineId links the session to a registered daemon machine (optional for dev mode).
 * - currentTaskId is a UI cache hint only; Task ownership is the source of truth.
 * - Status transitions are validated (cannot skip past terminal states to active).
 * - Session creation emits a 'session.created' control event (write-before-broadcast).
 * - Status updates emit 'session.status_changed' control events.
 *
 * Endpoints:
 *   POST  /api/v1/workrooms/:workroomId/sessions          → create session
 *   GET   /api/v1/workrooms/:workroomId/sessions          → list sessions (filter by status)
 *   GET   /api/v1/sessions/:id                            → get session detail
 *   PATCH /api/v1/sessions/:id/status                     → update status
 *   POST  /api/v1/sessions/:id/heartbeat                  → update lastActivityAt
 */

import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { publishControlEvent } from '@/control/events/publishControlEvent';

/** Terminal session states — once reached, cannot transition to active states. */
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

/** All valid session statuses. */
const VALID_STATUSES = new Set([
  'idle', 'running', 'waiting_for_user', 'blocked',
  'completed', 'failed', 'disconnected', 'reconnecting',
]);

/**
 * Validate that a status transition is legal.
 * Returns null if valid, error string if invalid.
 */
function validateStatusTransition(from: string, to: string): string | null {
  if (!VALID_STATUSES.has(to)) {
    return `Invalid target status '${to}'`;
  }
  // Cannot leave terminal states
  if (TERMINAL_STATUSES.has(from)) {
    return `Cannot transition from terminal status '${from}' to '${to}'`;
  }
  return null;
}

export async function sessionRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/workrooms/:workroomId/sessions
   * Create a new session within a workroom.
   *
   * Body: { mode, runtime, display_name, machine_id?, capabilities?, current_task_id? }
   */
  app.post('/api/v1/workrooms/:workroomId/sessions', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
    const body = request.body as {
      mode?: string;                // cmux | daemon | applescript
      runtime?: string;             // claude | codex | opencode | kimi | other
      display_name?: string;
      machine_id?: string;
      capabilities?: Record<string, unknown>;
      current_task_id?: string;
    };

    if (!body.mode || !body.runtime || !body.display_name) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'mode, runtime, display_name are required' } });
    }

    const VALID_MODES = new Set(['cmux', 'daemon', 'applescript']);
    const VALID_RUNTIMES = new Set(['claude', 'codex', 'opencode', 'kimi', 'other']);
    if (!VALID_MODES.has(body.mode)) {
      return reply.code(400).send({ error: { code: 'INVALID_MODE', message: `mode must be one of: ${[...VALID_MODES].join(', ')}` } });
    }
    if (!VALID_RUNTIMES.has(body.runtime)) {
      return reply.code(400).send({ error: { code: 'INVALID_RUNTIME', message: `runtime must be one of: ${[...VALID_RUNTIMES].join(', ')}` } });
    }

    // Verify workroom exists AND machine is authorized (orgId must match).
    const access = await requireMachineAccessToWorkroom(machine, workroomId);
    if (!access.ok) return reply.code(access.status).send({ error: access.error });
    const workroomOrgId = access.workroomOrgId;

    // Also fetch workroom for org verification in machine_id check
    const workroom = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { id: true, orgId: true } });
    if (!workroom) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    // Verify machine_id if provided (must belong to same org)
    if (body.machine_id) {
      const linkedMachine = await db.controlMachine.findFirst({
        where: { id: body.machine_id, orgId: workroom.orgId },
        select: { id: true },
      });
      if (!linkedMachine) {
        return reply.code(400).send({ error: { code: 'MACHINE_NOT_FOUND', message: 'machine_id not found or does not belong to this workroom org' } });
      }
    }

    const session = await db.controlSession.create({
      data: {
        orgId: workroomOrgId,
        workroomId,
        machineId: body.machine_id ?? null,
        mode: body.mode,
        runtime: body.runtime,
        displayName: body.display_name,
        status: 'idle',
        currentTaskId: body.current_task_id ?? null,
        capabilities: (body.capabilities ?? {}) as Prisma.InputJsonValue,
      },
    });

    // Emit session.created event (write-before-broadcast via publishControlEvent)
    await publishControlEvent({
      workroomId,
      eventId: crypto.randomUUID(),
      topic: 'session.created',
      payload: {
        session_id: session.id,
        mode: session.mode,
        runtime: session.runtime,
        display_name: session.displayName,
        machine_id: session.machineId,
      },
    });

    return reply.code(201).send(formatSession(session));
  });

  /**
   * GET /api/v1/workrooms/:workroomId/sessions
   * List sessions in a workroom. Optional ?status= filter (comma-separated).
   *
   * Org guard applied: session topology (machineId / displayName / runtime / status) is
   * org-scoped data — listing must be restricted to the machine's org.
   */
  app.get('/api/v1/workrooms/:workroomId/sessions', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };

    const access = await requireMachineAccessToWorkroom(machine, workroomId);
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    const query = request.query as { status?: string; limit?: string };

    const statusFilter = query.status
      ? query.status.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.has(s))
      : undefined;
    const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 50, 200) : 50;

    const sessions = await db.controlSession.findMany({
      where: {
        workroomId,
        ...(statusFilter?.length ? { status: { in: statusFilter } } : {}),
      },
      orderBy: { lastActivityAt: 'desc' },
      take: limit,
    });

    return { sessions: sessions.map(formatSession) };
  });

  /**
   * GET /api/v1/sessions/:id
   * Get a single session by ID.
   *
   * Org guard: session.orgId must match machine.orgId (derived from workroom at creation time).
   */
  app.get('/api/v1/sessions/:id', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const session = await db.controlSession.findUnique({ where: { id } });
    if (!session) {
      return reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
    }

    // Verify machine is authorized for this session's workroom.
    // session.orgId === workroom.orgId by construction (set at creation); use as override to skip extra DB query.
    const access = await requireMachineAccessToWorkroom(machine, session.workroomId, { orgId: session.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    return formatSession(session);
  });

  /**
   * PATCH /api/v1/sessions/:id/status
   *
   * Update session status with validation:
   * - Cannot leave terminal statuses (completed, failed)
   * - Must be a valid status string
   * - Emits session.status_changed event (write-before-broadcast)
   *
   * Body: { status, current_task_id? }
   *
   * Org guard: session.orgId must match machine.orgId. Without this guard, any valid
   * machine token can flip another org's session to completed/failed and inject
   * session.status_changed events into their workroom event stream.
   */
  app.patch('/api/v1/sessions/:id/status', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; current_task_id?: string };

    if (!body.status) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'status is required' } });
    }

    const current = await db.controlSession.findUnique({ where: { id } });
    if (!current) {
      return reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
    }

    // Verify machine is authorized for this session's workroom before applying any state change.
    const access = await requireMachineAccessToWorkroom(machine, current.workroomId, { orgId: current.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    const validationError = validateStatusTransition(current.status, body.status);
    if (validationError) {
      return reply.code(409).send({ error: { code: 'INVALID_TRANSITION', message: validationError } });
    }

    const updated = await db.controlSession.update({
      where: { id },
      data: {
        status: body.status,
        lastActivityAt: new Date(),
        ...(body.current_task_id !== undefined ? { currentTaskId: body.current_task_id ?? null } : {}),
      },
    });

    // Emit status change event
    await publishControlEvent({
      workroomId: updated.workroomId,
      eventId: crypto.randomUUID(),
      topic: 'session.status_changed',
      payload: {
        session_id: updated.id,
        from_status: current.status,
        to_status: updated.status,
        current_task_id: updated.currentTaskId,
      },
    });

    return formatSession(updated);
  });

  /**
   * POST /api/v1/sessions/:id/heartbeat
   * Update lastActivityAt — used by daemon to signal the session is still alive.
   * No status change, no event emitted (heartbeats are high-frequency, not domain events).
   *
   * Guard order: findUnique → org guard → terminal check → update.
   * Guard before terminal check prevents cross-org probing of terminal state via 409 vs 403.
   */
  app.post('/api/v1/sessions/:id/heartbeat', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };

    const session = await db.controlSession.findUnique({ where: { id } });
    if (!session) {
      return reply.code(404).send({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } });
    }

    // Org guard BEFORE terminal check: cross-org requests must get 403, not 409.
    // Checking terminal first would leak whether the target session is terminal.
    const access = await requireMachineAccessToWorkroom(machine, session.workroomId, { orgId: session.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    if (TERMINAL_STATUSES.has(session.status)) {
      return reply.code(409).send({ error: { code: 'SESSION_TERMINAL', message: `Cannot heartbeat a ${session.status} session` } });
    }

    await db.controlSession.update({
      where: { id },
      data: { lastActivityAt: new Date() },
    });

    return reply.code(200).send({ session_id: id, last_activity_at: new Date().toISOString() });
  });
}

/** Serialize a ControlSession row to the API response shape. */
function formatSession(session: {
  id: string;
  orgId: string;
  workroomId: string;
  machineId: string | null;
  mode: string;
  runtime: string;
  displayName: string;
  status: string;
  currentTaskId: string | null;
  capabilities: unknown;
  lastActivityAt: Date;
  createdAt: Date;
}) {
  return {
    id: session.id,
    org_id: session.orgId,
    workroom_id: session.workroomId,
    machine_id: session.machineId,
    mode: session.mode,
    runtime: session.runtime,
    display_name: session.displayName,
    status: session.status,
    current_task_id: session.currentTaskId,
    capabilities: session.capabilities,
    last_activity_at: session.lastActivityAt.toISOString(),
    created_at: session.createdAt.toISOString(),
  };
}
