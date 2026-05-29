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
const STATUS_RANK: Record<string, number> = { online: 0, busy: 1, drain: 2, offline: 3 };
const statusRank = (s: string): number => STATUS_RANK[s] ?? 99;

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
      where: { orgId },
      select: { id: true, displayName: true, name: true, role: true, status: true, machineId: true, runtime: true, model: true, description: true, capabilities: true },
      orderBy: [{ displayName: 'asc' }],
    });

    // Sort online-first in JS (Prisma can't express the custom status priority), then by name.
    agents.sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    });

    const members = agents.map((a) => {
      const caps = (a.capabilities && typeof a.capabilities === 'object' && !Array.isArray(a.capabilities))
        ? (a.capabilities as Record<string, unknown>) : {};
      return {
        id: a.id,
        kind: 'agent' as const,
        display_name: a.displayName?.trim() || a.name?.trim(),
        handle: a.name.startsWith('@') ? a.name : '@' + a.name,
        role: a.role,
        status: a.status,
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
