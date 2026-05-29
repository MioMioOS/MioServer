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
 *     Auth (Slice 7 B2-b): userOrMachine — user_sess_ (workroom member) OR machine_token.
 *
 *   POST /api/v1/workrooms/:wid/agents
 *     Create a ControlAgent ROW from the form. Body:
 *       { machine_id, name, description?, runtime?, model?, env?, reasoning_effort? }
 *     Auth (Slice 7 B2-b): user_sess_ (workroom OWNER) OR machine_token (via authorizeAgentWrite).
 *     Validates: name non-empty (400); machine_id ∈ workroom's org (404 else).
 *     Publishes 'agent.created'. Returns the GET /members item shape + runtime + model:
 *       { id, kind:'agent', display_name, role, status, machine_id, runtime, model }
 *
 * IMPORTANT (honest scope): this creates the agent ROW only. It does NOT make the agent
 * actually run / reply — that is a separate mio-agent daemon change. status is therefore
 * 'offline' at creation (the agent is not running yet).
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { resolveActor } from '@/auth/userOrMachine/resolveActor';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

/** A machine is "online" if it was seen within this window (≈2 min). */
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Resolved actor for an agent WRITE: who is doing the write, and the workroom's org
 * (derived from :wid, never trusted from the token).
 */
export type AgentWriteSubject =
  | { kind: 'user'; userId: string; workroomOrgId: string }
  | { kind: 'machine'; machineId: string; workroomOrgId: string };

type AgentWriteResult =
  | { ok: true; subject: AgentWriteSubject }
  | { ok: false; status: number; error: { code: string; message: string } };

/**
 * Authorize an agent WRITE (Slice 7 B2-b):
 *   1. user_sess_  → must be a workroom OWNER (§6.2). Non-member → 403; non-owner → 403.
 *   2. machine_token → must have org access to the workroom.
 *   3. anything else / missing bearer → 401.
 *
 * Returns the workroom's orgId either way so the caller can place the new agent
 * in the right org AND validate machine_id belongs to that org — derived from
 * the workroom, not the token.
 */
export async function authorizeAgentWrite(
  req: FastifyRequest,
  opts: { workroomId: string; command: string },
): Promise<AgentWriteResult> {
  void opts.command; // reserved for future audit
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const token = authHeader.slice(7);

  // Resolve the workroom's org from :wid (NOT trusted from the token). 404 if missing.
  const wr = await db.controlWorkroom.findUnique({ where: { id: opts.workroomId }, select: { orgId: true } });

  // ── Path 1: user_sess_ ──
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return { ok: false, status: 401, error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } };
    }
    if (!wr) {
      return { ok: false, status: 404, error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } };
    }
    // Use resolveActor for the membership/role read (single source of truth for user→workroom binding).
    const actor = await resolveActor(req, { workroomId: opts.workroomId });
    if (!actor || actor.kind !== 'user') {
      return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    if (actor.workroomRole !== 'owner') {
      return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    return { ok: true, subject: { kind: 'user', userId: actor.userId, workroomOrgId: wr.orgId } };
  }

  // ── Path 2: machine_token ──
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const access = await requireMachineAccessToWorkroom(machine, opts.workroomId);
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, subject: { kind: 'machine', machineId: machine.id, workroomOrgId: access.workroomOrgId } };
}

/**
 * Resolve a userOrMachine READ for the GET /computers route. Inline so we preserve the
 * 401/403/404 status-code matrix that resolveActor's uniform-401 collapse would lose
 * (e.g. tests assert "cross-org machine → 403", "non-existent workroom → 404").
 */
type ComputersReadResult =
  | { ok: true; workroomOrgId: string }
  | { ok: false; status: number; error: { code: string; message: string } };

async function resolveComputersReadActor(req: FastifyRequest, workroomId: string): Promise<ComputersReadResult> {
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
    return { ok: true, workroomOrgId: wr.orgId };
  }

  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, workroomOrgId: access.workroomOrgId };
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
   * org is derived from :wid (not the token). userOrMachine read.
   */
  app.get('/api/v1/workrooms/:wid/computers', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const guard = await resolveComputersReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

    const machines = await db.controlMachine.findMany({
      where: { orgId: guard.workroomOrgId },
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
   * Create a ControlAgent row from the Create Agent form. Auth: user_sess_ (workroom OWNER)
   * OR machine_token.
   *
   * Body: { machine_id, name, description?, runtime?, model?, env?, reasoning_effort? }
   *   machine_id — required; must be a ControlMachine in the workroom's org (404 else).
   *   name       — required, non-empty after trim (400 else). Used for name + displayName.
   *   description — optional, default ''.
   *   runtime    — optional, default 'claude'.
   *   model      — optional, default null (runtime default).
   *   env        — optional KEY:VALUE map; stored at capabilities.env (default {}).
   *   reasoning_effort — optional 'low'|'medium'|'high'; stored at capabilities.reasoning_effort
   *                      (default null). Only meaningful for codex runtime, but stored as-sent.
   *                      Persisted for the FUTURE codex-runtime daemon — not used at runtime yet.
   *
   * role = 'other', status = 'offline' (the agent is NOT running yet — honest), permissions = {}.
   * Publishes 'agent.created'. Returns the GET /members item shape + runtime + model.
   */
  app.post('/api/v1/workrooms/:wid/agents', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const auth = await authorizeAgentWrite(request, { workroomId: wid, command: 'create_agent' });
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    const subject = auth.subject;

    const body = request.body as {
      machine_id?: unknown;
      name?: unknown;
      description?: unknown;
      runtime?: unknown;
      model?: unknown;
      env?: unknown;
      reasoning_effort?: unknown;
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
    if (!machine || machine.orgId !== subject.workroomOrgId) {
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

    // reasoning_effort ("low"|"medium"|"high") is only meaningful for the codex runtime, but we
    // store whatever's sent (null when absent). Lives in capabilities (no schema change). NOTE:
    // this is persisted for the future codex-runtime daemon — the daemon does NOT use it yet.
    const reasoningEffort = typeof body?.reasoning_effort === 'string' && body.reasoning_effort.trim()
      ? body.reasoning_effort.trim()
      : null;

    // fast_mode (bool) — applies to both claude (faster Opus output) and codex.
    // Stored in capabilities for the daemon; null when absent.
    const fastMode = typeof (body as { fast_mode?: unknown } | null)?.fast_mode === 'boolean'
      ? (body as { fast_mode?: boolean }).fast_mode
      : null;

    // A machine may host MANY agents — there is intentionally NO one-agent-per-machine
    // limit (the DB unique was dropped). Just create the row; no pre-check, no P2002→409.
    const agent = await db.controlAgent.create({
      data: {
        orgId: subject.workroomOrgId,
        machineId,
        name,
        displayName: name,
        description,
        role: 'other',
        runtime,
        model,
        // status 'offline' is honest: creating the row does NOT start the agent (separate daemon change).
        status: 'offline',
        capabilities: { env, reasoning_effort: reasoningEffort, fast_mode: fastMode },
        permissions: {},
      },
      select: { id: true, displayName: true, role: true, status: true, machineId: true, runtime: true, model: true },
    });

    const actorId = subject.kind === 'user' ? subject.userId : subject.machineId;

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
        created_by: actorId,
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

  /**
   * PATCH /api/v1/workrooms/:wid/agents/:agentId
   *
   * Edit an existing ControlAgent's metadata from the iOS "Edit Agent" form.
   * Partial update — only the fields present in the body are changed. Body:
   *   { name?, description?, runtime?, model?, env?, reasoning_effort? }
   *     name        — if present & non-empty after trim → updates name + displayName.
   *     description — if present (string) → set verbatim (may be "").
   *     runtime     — if present & non-empty → set.
   *     model       — if the key is present: trimmed string, or null to clear.
   *     env / reasoning_effort — merged into capabilities (existing keys preserved
   *                  unless overridden; env replaces the whole env map when present).
   *
   * Auth: user_sess_ (workroom OWNER) OR machine_token (authorizeAgentWrite). org
   * is derived from :wid, never the token. Agent must be in that org (404 else).
   *
   * Publishes 'agent.updated'. Returns the GET /members item shape (+ runtime + model)
   * so the client can update its roster row from the response (no WS dependency).
   */
  app.patch('/api/v1/workrooms/:wid/agents/:agentId', async (request, reply) => {
    const { wid, agentId } = request.params as { wid: string; agentId: string };

    const auth = await authorizeAgentWrite(request, { workroomId: wid, command: 'update_agent' });
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    const subject = auth.subject;

    const existing = await db.controlAgent.findUnique({
      where: { id: agentId },
      select: { id: true, orgId: true, capabilities: true },
    });
    if (!existing || existing.orgId !== subject.workroomOrgId) {
      return reply.code(404).send({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found in this org' } });
    }

    const body = request.body as {
      name?: unknown;
      description?: unknown;
      runtime?: unknown;
      model?: unknown;
      env?: unknown;
      reasoning_effort?: unknown;
    } | null;

    const data: Record<string, unknown> = {};

    if (typeof body?.name === 'string') {
      const trimmed = body.name.trim();
      if (!trimmed) {
        return reply.code(400).send({ error: { code: 'INVALID_NAME', message: 'name cannot be empty' } });
      }
      data.name = trimmed;
      data.displayName = trimmed;
    }
    if (typeof body?.description === 'string') data.description = body.description;
    if (typeof body?.runtime === 'string' && body.runtime.trim()) data.runtime = body.runtime.trim();
    if (body && Object.prototype.hasOwnProperty.call(body, 'model')) {
      data.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    }

    // Merge env / reasoning_effort into capabilities (preserve unspecified keys).
    const caps: Record<string, unknown> =
      existing.capabilities && typeof existing.capabilities === 'object' && !Array.isArray(existing.capabilities)
        ? { ...(existing.capabilities as Record<string, unknown>) }
        : {};
    let capsTouched = false;
    if (body?.env && typeof body.env === 'object' && !Array.isArray(body.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
      caps.env = env;
      capsTouched = true;
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')) {
      caps.reasoning_effort =
        typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()
          ? body.reasoning_effort.trim()
          : null;
      capsTouched = true;
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'fast_mode')) {
      caps.fast_mode = typeof (body as { fast_mode?: unknown }).fast_mode === 'boolean'
        ? (body as { fast_mode?: boolean }).fast_mode
        : null;
      capsTouched = true;
    }
    if (capsTouched) data.capabilities = caps;

    const updated = await db.controlAgent.update({
      where: { id: agentId },
      data,
      select: { id: true, displayName: true, role: true, status: true, machineId: true, runtime: true, model: true },
    });

    const actorId = subject.kind === 'user' ? subject.userId : subject.machineId;

    const event = await publishControlEvent({
      workroomId: wid,
      eventId: randomUUID(),
      topic: 'agent.updated',
      payload: {
        agent_id: updated.id,
        machine_id: updated.machineId,
        display_name: updated.displayName,
        role: updated.role,
        status: updated.status,
        runtime: updated.runtime,
        model: updated.model,
        updated_by: actorId,
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

    return reply.send({
      id: updated.id,
      kind: 'agent' as const,
      display_name: updated.displayName,
      role: updated.role,
      status: updated.status,
      machine_id: updated.machineId,
      runtime: updated.runtime,
      model: updated.model,
    });
  });

  /**
   * DELETE /api/v1/workrooms/:wid/agents/:agentId
   *
   * Soft-disable an agent (NOT a hard delete — ControlTask.ownerInstanceId /
   * createdByInstanceId FK at agent rows, so a hard delete would risk P2003).
   * This mirrors exactly what an operator does by hand to stop the daemon from
   * respawning a spine for a throwaway sim agent:
   *   1. remove ALL ControlChannelMember rows for the agent (drop memberships), AND
   *   2. unbind from its machine (machine_id = NULL) + status = 'offline'
   *      → on the next daemon restart there is no machine binding to spawn from.
   *
   * Auth: user_sess_ (workroom OWNER) OR machine_token — same as POST /agents
   * (authorizeAgentWrite). org is derived from :wid, never the token.
   *
   * Idempotent: deleting an already-unbound / already-membership-less agent is a
   * no-op that still returns { ok: true }. A non-existent agent or an agent in a
   * different org → 404 (anti-enumeration), which the caller treats as "already gone".
   *
   * Returns { ok: true }.
   */
  app.delete('/api/v1/workrooms/:wid/agents/:agentId', async (request, reply) => {
    const { wid, agentId } = request.params as { wid: string; agentId: string };

    const auth = await authorizeAgentWrite(request, { workroomId: wid, command: 'disable_agent' });
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    const subject = auth.subject;

    // Agent must exist AND be in the workroom's org (derived from :wid). 404 covers
    // "missing" and "cross-org" alike (anti-enumeration); the caller treats it as gone.
    const agent = await db.controlAgent.findUnique({
      where: { id: agentId },
      select: { id: true, orgId: true },
    });
    if (!agent || agent.orgId !== subject.workroomOrgId) {
      return reply.code(404).send({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found in this org' } });
    }

    // 1) Drop ALL channel memberships for this agent (opaque actor id == agent id).
    await db.controlChannelMember.deleteMany({ where: { memberId: agentId } });

    // 2) Soft-disable: unbind machine + mark offline so the daemon boot snapshot
    //    has nothing to spawn. updatedMany-style update is idempotent.
    await db.controlAgent.update({
      where: { id: agentId },
      data: { machineId: null, status: 'offline' },
    });

    const actorId = subject.kind === 'user' ? subject.userId : subject.machineId;

    // Broadcast a status change so any live client drops it from the roster.
    const event = await publishControlEvent({
      workroomId: wid,
      eventId: randomUUID(),
      topic: 'agent.status',
      payload: {
        agent_id: agentId,
        status: 'offline',
        machine_id: null,
        disabled_by: actorId,
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

    return reply.send({ ok: true });
  });

  // ── Lifecycle: pause / resume / restart ────────────────────────────────────
  //
  // These set the agent's status and broadcast an event the mio-agent daemon
  // acts on. Like create/delete, the SERVER records intent + status; the daemon
  // performing the actual process stop/start/wipe is a separate piece.
  //
  // Auth: authorizeAgentWrite (workroom OWNER or machine_token). org from :wid.

  /** Resolve + authorize an agent lifecycle write; 404 if not in the workroom's org. */
  async function lifecycleGuard(request: FastifyRequest, wid: string, agentId: string, command: string) {
    const auth = await authorizeAgentWrite(request, { workroomId: wid, command });
    if (!auth.ok) return { ok: false as const, status: auth.status, error: auth.error };
    const agent = await db.controlAgent.findUnique({ where: { id: agentId }, select: { id: true, orgId: true } });
    if (!agent || agent.orgId !== auth.subject.workroomOrgId) {
      return { ok: false as const, status: 404, error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found in this org' } };
    }
    return { ok: true as const, subject: auth.subject };
  }

  function broadcastAgent(wid: string, topic: string, payload: Record<string, unknown>) {
    return publishControlEvent({ workroomId: wid, eventId: randomUUID(), topic, payload }).then((event) => {
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
    });
  }

  // POST /agents/:agentId/pause → status 'paused'
  app.post('/api/v1/workrooms/:wid/agents/:agentId/pause', async (request, reply) => {
    const { wid, agentId } = request.params as { wid: string; agentId: string };
    const g = await lifecycleGuard(request, wid, agentId, 'pause_agent');
    if (!g.ok) return reply.code(g.status).send({ error: g.error });
    await db.controlAgent.update({ where: { id: agentId }, data: { status: 'paused' } });
    const actorId = g.subject.kind === 'user' ? g.subject.userId : g.subject.machineId;
    await broadcastAgent(wid, 'agent.status', { agent_id: agentId, status: 'paused', paused_by: actorId });
    return reply.send({ ok: true, status: 'paused' });
  });

  // POST /agents/:agentId/resume → status 'online' (daemon reconciles to actually run)
  app.post('/api/v1/workrooms/:wid/agents/:agentId/resume', async (request, reply) => {
    const { wid, agentId } = request.params as { wid: string; agentId: string };
    const g = await lifecycleGuard(request, wid, agentId, 'resume_agent');
    if (!g.ok) return reply.code(g.status).send({ error: g.error });
    await db.controlAgent.update({ where: { id: agentId }, data: { status: 'online' } });
    const actorId = g.subject.kind === 'user' ? g.subject.userId : g.subject.machineId;
    await broadcastAgent(wid, 'agent.status', { agent_id: agentId, status: 'online', resumed_by: actorId });
    return reply.send({ ok: true, status: 'online' });
  });

  // POST /agents/:agentId/restart { mode: 'restart' | 'reset_session' | 'full_reset' }
  //   restart       — stop+start the process; keep runtime session + workspace files
  //   reset_session — clear runtime session, keep workspace files (MEMORY.md, notes/)
  //   full_reset    — clear session AND delete workspace files, restart from scratch
  app.post('/api/v1/workrooms/:wid/agents/:agentId/restart', async (request, reply) => {
    const { wid, agentId } = request.params as { wid: string; agentId: string };
    const g = await lifecycleGuard(request, wid, agentId, 'restart_agent');
    if (!g.ok) return reply.code(g.status).send({ error: g.error });
    const body = request.body as { mode?: unknown } | null;
    const mode = typeof body?.mode === 'string' ? body.mode : 'restart';
    if (!['restart', 'reset_session', 'full_reset'].includes(mode)) {
      return reply.code(400).send({ error: { code: 'INVALID_MODE', message: 'mode must be restart|reset_session|full_reset' } });
    }
    await db.controlAgent.update({ where: { id: agentId }, data: { status: 'online' } });
    const actorId = g.subject.kind === 'user' ? g.subject.userId : g.subject.machineId;
    await broadcastAgent(wid, 'agent.restart', { agent_id: agentId, mode, restarted_by: actorId });
    return reply.send({ ok: true, mode });
  });
}
