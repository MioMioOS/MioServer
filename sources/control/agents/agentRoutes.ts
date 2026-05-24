/**
 * Agents + Computers API — control plane (S2 "Create Agent")
 *
 * Backs the iOS "Create Agent" form (fields: COMPUTER, NAME, DESCRIPTION, RUNTIME,
 * MODEL, ENV VARS).
 *
 * Endpoints:
 *   GET  /api/v1/workrooms/:wid/computers
 *     The "COMPUTER" picker — the org's ControlMachines.
 *     Contract: { computers: [{ id, name, platform, arch, status }] }
 *       name   = displayName ?? ('Machine ' + id.slice(0,6))
 *       status = 'online' if lastSeenAt within ONLINE_WINDOW_MS, else 'offline'
 *     Auth: authorizeControlRead (machine_token OR dev_ctl_).
 *
 *   POST /api/v1/workrooms/:wid/agents
 *     Create a ControlAgent ROW from the form. Body:
 *       { machine_id, name, description?, runtime?, model?, env? }
 *     Auth: op_sess_('create_agent') OR machine_token; dev_ctl_ → 403.
 *     Validates: name non-empty (400); machine_id ∈ workroom's org (404 else).
 *     Publishes 'agent.created'. Returns the GET /members item shape + runtime + model:
 *       { id, kind:'agent', display_name, role, status, machine_id, runtime, model }
 *
 * IMPORTANT (honest scope): this creates the agent ROW only. It does NOT make the agent
 * actually run / reply — that is a separate mio-agent daemon change. status is therefore
 * 'offline' at creation (the agent is not running yet).
 *
 * Auth ordering for the POST mirrors channelRoutes.authorizeChannelWrite:
 *   dev_ctl_ → hard 403 → op_sess_(command) → machine_token (+ org/workroom access).
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { authorizeOperatorWrite } from '@/control/operatorSessions/operatorSessionAuth';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

/** A machine is "online" if it was seen within this window (≈2 min). */
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Resolved actor for an agent WRITE: who is doing the write, and the workroom's org
 * (derived from :wid, never trusted from the token). dev_ctl_ is hard-rejected (403).
 */
type WriteActor =
  | { ok: true; actorId: string; workroomOrgId: string }
  | { ok: false; status: number; body: { error: { code: string; message: string } } };

/**
 * Authorize an agent WRITE: op_sess_('create_agent') OR machine_token. dev_ctl_ → 403.
 * Mirrors channelRoutes.authorizeChannelWrite ordering (defense-in-depth dev_ctl_ reject
 * first, then op_sess_ with hard-403 on wrong scope, then machine_token with org access).
 *
 * Returns workroomOrgId so the caller can both place the new agent in the right org AND
 * validate machine_id belongs to that org — derived from the workroom, not the token.
 */
async function authorizeAgentWrite(
  request: FastifyRequest,
  workroomId: string,
): Promise<WriteActor> {
  const authHeader = request.headers.authorization;

  // 1. dev_ctl_ → hard 403.
  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (rawToken.startsWith('dev_ctl_')) {
    return { ok: false, status: 403, body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } } };
  }

  // Resolve the workroom's org from :wid (NOT trusted from the token). 404 if missing.
  const wr = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { orgId: true } });

  // 2/3. op_sess_ path.
  const opAuth = await authorizeOperatorWrite(request, { command: 'create_agent', workroomId });
  if (opAuth.ok) {
    if (!wr) {
      return { ok: false, status: 404, body: { error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } } };
    }
    return { ok: true, actorId: opAuth.session.operatorSubjectId, workroomOrgId: wr.orgId };
  }
  // valid op_sess_ token, wrong command/workroom → hard 403 (do not fall through to machine).
  if (opAuth.status === 403) {
    return { ok: false, status: 403, body: { error: { code: opAuth.code, message: opAuth.message } } };
  }

  // 4. machine_token path.
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } } };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) {
    return { ok: false, status: access.status, body: { error: access.error } };
  }
  return { ok: true, actorId: machine.id, workroomOrgId: access.workroomOrgId };
}

/** Online iff lastSeenAt is within ONLINE_WINDOW_MS of now. null lastSeenAt → offline. */
function machineStatus(lastSeenAt: Date | null): 'online' | 'offline' {
  if (!lastSeenAt) return 'offline';
  return Date.now() - lastSeenAt.getTime() <= ONLINE_WINDOW_MS ? 'online' : 'offline';
}

/** Display name for a computer in the picker. */
function computerName(displayName: string | null, id: string): string {
  const trimmed = displayName?.trim();
  return trimmed || `Machine ${id.slice(0, 6)}`;
}

export async function agentRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/computers
   *
   * Returns the org's ControlMachines as the "COMPUTER" picker for the Create Agent form.
   * org is derived from :wid (not the token). Dual-read auth (machine OR dev_ctl_).
   */
  app.get('/api/v1/workrooms/:wid/computers', async (request, reply) => {
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { wid } = request.params as { wid: string };

    // machine mode: enforce org/workroom access. dev mode: already workroom-scoped by auth.
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    // Resolve the workroom's org (derive from :wid, do not trust the token).
    const wr = await db.controlWorkroom.findUnique({ where: { id: wid }, select: { orgId: true } });
    if (!wr) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    const machines = await db.controlMachine.findMany({
      where: { orgId: wr.orgId },
      select: { id: true, displayName: true, platform: true, arch: true, lastSeenAt: true },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    });

    const computers = machines.map((m) => ({
      id: m.id,
      name: computerName(m.displayName, m.id),
      platform: m.platform,
      arch: m.arch,
      status: machineStatus(m.lastSeenAt),
    }));

    return { computers };
  });

  /**
   * POST /api/v1/workrooms/:wid/agents
   *
   * Create a ControlAgent row from the Create Agent form. Auth: op_sess_('create_agent')
   * OR machine_token; dev_ctl_ → 403.
   *
   * Body: { machine_id, name, description?, runtime?, model?, env? }
   *   machine_id — required; must be a ControlMachine in the workroom's org (404 else).
   *   name       — required, non-empty after trim (400 else). Used for name + displayName.
   *   description — optional, default ''.
   *   runtime    — optional, default 'claude'.
   *   model      — optional, default null (runtime default).
   *   env        — optional KEY:VALUE map; stored at capabilities.env (default {}).
   *
   * role = 'other', status = 'offline' (the agent is NOT running yet — honest), permissions = {}.
   * Publishes 'agent.created'. Returns the GET /members item shape + runtime + model.
   */
  app.post('/api/v1/workrooms/:wid/agents', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const actor = await authorizeAgentWrite(request, wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const body = request.body as {
      machine_id?: unknown;
      name?: unknown;
      description?: unknown;
      runtime?: unknown;
      model?: unknown;
      env?: unknown;
    } | null;

    // Validate name (non-empty after trim).
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return reply.code(400).send({ error: { code: 'INVALID_NAME', message: 'name is required' } });
    }

    // Validate machine_id (non-empty + belongs to the workroom's org).
    const machineId = typeof body?.machine_id === 'string' ? body.machine_id.trim() : '';
    if (!machineId) {
      return reply.code(400).send({ error: { code: 'INVALID_MACHINE_ID', message: 'machine_id is required' } });
    }
    const machine = await db.controlMachine.findUnique({ where: { id: machineId }, select: { orgId: true } });
    if (!machine || machine.orgId !== actor.workroomOrgId) {
      // 404 covers both "machine does not exist" and "machine is in another org" (anti-enumeration).
      return reply.code(404).send({ error: { code: 'MACHINE_NOT_FOUND', message: 'Machine not found in this org' } });
    }

    const description = typeof body?.description === 'string' ? body.description : '';
    const runtime = typeof body?.runtime === 'string' && body.runtime.trim() ? body.runtime.trim() : 'claude';
    const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : null;

    // env vars live in capabilities.env (no env column). Accept only a flat string→string map.
    const env: Record<string, string> = {};
    if (body?.env && typeof body.env === 'object' && !Array.isArray(body.env)) {
      for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
    }

    let agent;
    try {
      agent = await db.controlAgent.create({
        data: {
          orgId: actor.workroomOrgId,
          machineId,
          name,
          displayName: name,
          description,
          role: 'other',
          runtime,
          model,
          // status 'offline' is honest: creating the row does NOT start the agent (separate daemon change).
          status: 'offline',
          capabilities: { env },
          permissions: {},
        },
        select: { id: true, displayName: true, role: true, status: true, machineId: true, runtime: true, model: true },
      });
    } catch (err) {
      // @@unique([orgId, machineId]): one agent per machine per org. A second create on the
      // same computer collides → 409 (not a 500), so the form can surface a clear message.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({
          error: { code: 'AGENT_EXISTS_FOR_MACHINE', message: 'An agent already exists for this computer' },
        });
      }
      throw err;
    }

    // Publish 'agent.created' (write-before-broadcast). WS fanout is fire-and-forget.
    const event = await publishControlEvent({
      workroomId: wid,
      eventId: randomUUID(),
      topic: 'agent.created',
      payload: {
        agent_id: agent.id,
        machine_id: agent.machineId,
        display_name: agent.displayName,
        role: agent.role,
        status: agent.status,
        runtime: agent.runtime,
        model: agent.model,
        created_by: actor.actorId,
      },
    });
    if (!event.idempotent) {
      workroomBroadcaster.broadcast(wid, {
        event_id: event.eventId,
        workroom_id: event.workroomId,
        seq: event.seq.toString(),
        topic: event.topic,
        payload: event.payloadJson as Record<string, unknown>,
        created_at: event.createdAt.toISOString(),
      });
    }

    // Same wire shape as a GET /members item (+ runtime + model) so it lists immediately.
    return reply.code(201).send({
      id: agent.id,
      kind: 'agent' as const,
      display_name: agent.displayName,
      role: agent.role,
      status: agent.status,
      machine_id: agent.machineId,
      runtime: agent.runtime,
      model: agent.model,
    });
  });
}
