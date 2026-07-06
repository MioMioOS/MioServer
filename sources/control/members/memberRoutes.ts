/**
 * Members API — control plane (S2 Chunk 1)
 *
 * Endpoints:
 *   GET /api/v1/workrooms/:wid/members
 *     Returns the workroom org's ControlAgent rows (the "AI team"). humans are not
 *     included this period (no human display-name table; see spec §6/§8).
 *
 * Contract (§4.1 spec):
 *   { members: [{ id, kind:'agent', display_name, role, status, machine_id, runtime, model }] }
 *   (runtime + model are ADDITIVE fields for the "Create Agent" surface so a freshly
 *    created agent's runtime/model show up in the members list immediately.)
 *
 * Auth (Slice 7 B2-a): userOrMachine — accepts EITHER user_sess_ OR machine_token.
 *   - user mode: must be a UserWorkroomMembership row for :wid (else 403).
 *   - machine mode: machine.orgId must match the workroom's orgId (else 403);
 *                   missing machine.orgId → 403; workroom not found → 404.
 *   We resolve manually (not via `requireActor` middleware) because this route
 *   wants to preserve the existing 401-vs-403-vs-404 distinction — `requireActor`
 *   collapses everything to 401, which would break the existing memberRoutes
 *   integration coverage and the anti-enumeration "missing workroom → 404"
 *   semantic.
 *
 * org derivation: the org is resolved from the :wid workroom (NOT trusted from the
 * caller), so members are always the agents of the workroom's owning org.
 *
 * Sort: status 'online' first, then by display_name. (Cannot be done in a single Prisma
 * orderBy — lexicographic status would put 'online' last, after busy/drain/offline — so we
 * rank in JS via STATUS_RANK.)
 */

import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';

// Status sort priority — 'online' first. Unknown statuses sort last.
const STATUS_RANK: Record<string, number> = { online: 0, busy: 1, drain: 2, paused: 3, offline: 4 };
const statusRank = (s: string): number => STATUS_RANK[s] ?? 99;

/**
 * An agent's machine is "online" if seen within this window. The mio-agent
 * daemon refreshes the roster every 30s (and bumps lastSeenAt via
 * verifyMachineToken), so a 2-minute window (== the COMPUTER picker's
 * ONLINE_WINDOW_MS in agentRoutes) reliably reflects a live daemon without
 * flapping between refreshes.
 */
const MACHINE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Derive an agent's REAL status. This deliberately does NOT trust the stored
 * control_agents.status column as a liveness signal — that column was a
 * manually-written flag (set at create / pause / resume) with no connection to
 * whether the agent's daemon is actually running, which is why agents that were
 * happily replying in channel still showed "offline".
 *
 * Truth model:
 *   - 'paused'  → a real, user-expressed intent (the Stop button). The daemon
 *                 honors it and stops ticking, so we surface it verbatim.
 *   - otherwise → derived from the host machine's heartbeat: a live daemon
 *                 keeps lastSeenAt fresh, so bound + fresh ⇒ 'online', else
 *                 'offline'. Fine-grained per-turn state (starting/thinking)
 *                 rides on top via the ephemeral WS `agent.status` presence the
 *                 client already consumes — it is not persisted here.
 */
function deriveAgentStatus(storedStatus: string, machineLastSeenAt: Date | null | undefined): string {
  if (storedStatus === 'paused') return 'paused';
  if (!machineLastSeenAt) return 'offline';
  return Date.now() - machineLastSeenAt.getTime() <= MACHINE_ONLINE_WINDOW_MS ? 'online' : 'offline';
}

export async function memberRoutes(app: FastifyInstance) {
  app.get('/api/v1/workrooms/:wid/members', async (request, reply) => {
    const { wid } = request.params as { wid: string };
    const authHeader = request.headers.authorization;

    // ── User OR Machine resolution (inline so we keep route-specific error codes) ──
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
    const token = authHeader.slice(7);

    let orgId: string | undefined;
    if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
      // Path 1: user_sess_ — verify session + workroom membership.
      const session = await resolveUserSession(authHeader);
      if (!session) {
        return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
      }
      // Resolve workroom (404 if missing — anti-enumeration mirrored from machine path).
      const wr = await db.controlWorkroom.findUnique({ where: { id: wid }, select: { orgId: true } });
      if (!wr) {
        return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
      }
      const mem = await db.userWorkroomMembership.findUnique({
        where: { userId_workroomId: { userId: session.userId, workroomId: wid } },
      });
      if (!mem) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
      orgId = wr.orgId;
    } else {
      // Path 2: machine_token — verify token, then require org/workroom access.
      const machine = await verifyMachineToken(authHeader);
      if (!machine) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }
      const access = await requireMachineAccessToWorkroom(machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      orgId = access.workroomOrgId;
    }

    const agents = await db.controlAgent.findMany({
      // machineId null = soft-deleted (the delete route unbinds the machine).
      // The row is kept so historical messages still resolve the sender name,
      // but the roster must not resurrect it — "点了移除还在" bug.
      where: { orgId, machineId: { not: null } },
      select: { id: true, displayName: true, name: true, role: true, status: true, machineId: true, runtime: true, model: true, description: true, capabilities: true },
      orderBy: [{ displayName: 'asc' }],
    });

    // Resolve the heartbeat (lastSeenAt) of every machine these agents are bound
    // to, so status can be DERIVED from real liveness instead of the stale
    // stored column. One batched query keyed by the distinct machine ids.
    const machineIds = [...new Set(agents.map((a) => a.machineId).filter((m): m is string => !!m))];
    const machines = machineIds.length
      ? await db.controlMachine.findMany({
          where: { id: { in: machineIds } },
          select: { id: true, lastSeenAt: true },
        })
      : [];
    const lastSeenByMachine = new Map(machines.map((m) => [m.id, m.lastSeenAt]));

    // Compute the derived status once per agent, then sort online-first by it
    // (Prisma can't express the custom status priority), then by name.
    const withStatus = agents.map((a) => ({
      a,
      derivedStatus: deriveAgentStatus(a.status, a.machineId ? lastSeenByMachine.get(a.machineId) : null),
    }));
    withStatus.sort((x, y) => {
      const r = statusRank(x.derivedStatus) - statusRank(y.derivedStatus);
      if (r !== 0) return r;
      return (x.a.displayName || x.a.name).localeCompare(y.a.displayName || y.a.name);
    });

    const members = withStatus.map(({ a, derivedStatus }) => {
      const caps = (a.capabilities && typeof a.capabilities === 'object' && !Array.isArray(a.capabilities))
        ? (a.capabilities as Record<string, unknown>) : {};
      return {
        id: a.id,
        kind: 'agent' as const,
        display_name: a.displayName?.trim() || a.name?.trim(),
        handle: a.name.startsWith('@') ? a.name : '@' + a.name,
        role: a.role,
        status: derivedStatus,
        machine_id: a.machineId,
        runtime: a.runtime,
        model: a.model,
        description: a.description,
        reasoning_effort: typeof caps.reasoning_effort === 'string' ? caps.reasoning_effort : null,
        fast_mode: typeof caps.fast_mode === 'boolean' ? caps.fast_mode : null,
      };
    });

    return { members };
  });
}
