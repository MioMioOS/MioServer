/**
 * Members API — control plane (S2 Chunk 1)
 *
 * Endpoints:
 *   GET /api/v1/workrooms/:wid/members
 *     Returns the workroom org's ControlAgent rows (the "AI team"). humans are not
 *     included this period (no human display-name table; see spec §6/§8).
 *
 * Contract (§4.1 spec):
 *   { members: [{ id, kind:'agent', display_name, role, status, machine_id }] }
 *
 * Auth: dual-read via authorizeControlRead (machine_token OR dev_control_token).
 *   - machine mode: also enforces org/workroom access via requireMachineAccessToWorkroom
 *     (cross-org machine → 403; workroom not found → 404).
 *   - dev mode: authorizeControlRead already enforced the GET allowlist + workroom scope
 *     (wid != token.workroomId → uniform 403).
 *
 * org derivation: the org is resolved from the :wid workroom (NOT trusted from the token),
 * so members are always the agents of the workroom's owning org.
 *
 * Sort: status 'online' first, then by display_name. (Cannot be done in a single Prisma
 * orderBy — lexicographic status would put 'online' last, after busy/drain/offline — so we
 * rank in JS via STATUS_RANK.)
 */

import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';

// Status sort priority — 'online' first. Unknown statuses sort last.
const STATUS_RANK: Record<string, number> = { online: 0, busy: 1, drain: 2, offline: 3 };
const statusRank = (s: string): number => STATUS_RANK[s] ?? 99;

export async function memberRoutes(app: FastifyInstance) {
  app.get('/api/v1/workrooms/:wid/members', async (request, reply) => {
    // Dual-auth: machine_token (full) OR dev_control_token (read-only, allowlist + workroom-scope).
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { wid } = request.params as { wid: string };

    // machine mode: enforce org/workroom access (cross-org → 403, missing workroom → 404).
    // dev mode: path was already scoped by authorizeControlRead (workroom_id in token = :wid).
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    // Resolve the workroom's org (do not trust the token's orgId; derive from :wid).
    const wr = await db.controlWorkroom.findUnique({ where: { id: wid }, select: { orgId: true } });
    if (!wr) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    const agents = await db.controlAgent.findMany({
      where: { orgId: wr.orgId },
      select: { id: true, displayName: true, name: true, role: true, status: true, machineId: true },
      orderBy: [{ displayName: 'asc' }],
    });

    // Sort online-first in JS (Prisma can't express the custom status priority), then by name.
    agents.sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    });

    const members = agents.map((a) => ({
      id: a.id,
      kind: 'agent' as const,
      display_name: a.displayName?.trim() || a.name?.trim(),
      role: a.role,
      status: a.status,
      machine_id: a.machineId,
    }));

    return { members };
  });
}
