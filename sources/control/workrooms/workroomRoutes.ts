/**
 * Workroom API — control plane
 *
 * Workrooms are the top-level collaboration unit in the control plane.
 * Each workroom belongs to an Org and contains tasks, actions, sessions, messages.
 *
 * Schema fields (ControlWorkroom):
 *   id, orgId, name, description, visibility, purpose, currentGoalId,
 *   createdBy, createdAt, archivedAt
 *
 * Endpoints:
 *   POST  /api/v1/orgs/:orgId/workrooms   → create workroom
 *   GET   /api/v1/orgs/:orgId/workrooms   → list workrooms
 *   GET   /api/v1/workrooms/:id           → get workroom detail
 *   PATCH /api/v1/workrooms/:id           → update workroom (name, visibility, current_goal_id)
 */

import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { resolveActor } from '@/auth/userOrMachine/resolveActor';
import { visibleChannels } from '@/control/channels/channelVisibility';

export async function workroomRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/orgs/:orgId/workrooms
   * Create a new workroom for an org.
   */
  app.post('/api/v1/orgs/:orgId/workrooms', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { orgId } = request.params as { orgId: string };
    const body = request.body as {
      name: string;
      description?: string;
      visibility?: string;
      purpose?: string;
      created_by: string;  // agent_instance_id of creator
    };

    if (!body.name) {
      return reply.code(400).send({ error: { code: 'MISSING_NAME', message: 'name is required' } });
    }
    if (!body.created_by) {
      return reply.code(400).send({ error: { code: 'MISSING_CREATED_BY', message: 'created_by is required' } });
    }

    if (!machine.orgId || machine.orgId !== orgId) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Machine org does not match requested org' } });
    }

    const org = await db.controlOrg.findUnique({ where: { id: orgId } });
    if (!org) {
      return reply.code(404).send({ error: { code: 'ORG_NOT_FOUND', message: 'Org not found' } });
    }

    const workroom = await db.controlWorkroom.create({
      data: {
        orgId,
        name: body.name,
        description: body.description,
        visibility: body.visibility ?? 'private',
        purpose: body.purpose,
        createdBy: body.created_by,
      },
    });

    return reply.code(201).send({
      workroom_id: workroom.id,
      org_id: workroom.orgId,
      name: workroom.name,
      visibility: workroom.visibility,
      archived: false,
      created_at: workroom.createdAt.toISOString(),
    });
  });

  /**
   * GET /api/v1/orgs/:orgId/workrooms
   * List workrooms for an org. Excludes archived by default.
   */
  app.get('/api/v1/orgs/:orgId/workrooms', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { orgId } = request.params as { orgId: string };

    if (!machine.orgId || machine.orgId !== orgId) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Machine org does not match requested org' } });
    }

    const query = request.query as { include_archived?: string; visibility?: string };
    const includeArchived = query.include_archived === 'true';

    const workrooms = await db.controlWorkroom.findMany({
      where: {
        orgId,
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(query.visibility ? { visibility: query.visibility } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return {
      workrooms: workrooms.map((w) => ({
        workroom_id: w.id,
        name: w.name,
        visibility: w.visibility,
        current_goal_id: w.currentGoalId,
        archived: w.archivedAt !== null,
        created_at: w.createdAt.toISOString(),
      })),
    };
  });

  /**
   * GET /api/v1/workrooms/:id
   * Get workroom detail.
   */
  app.get('/api/v1/workrooms/:id', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }

    const token = authHeader.slice(7);
    const { id } = request.params as { id: string };
    const workroom = await db.controlWorkroom.findUnique({
      where: { id },
      include: {
        _count: {
          select: { tasks: true, actions: true, sessions: true },
        },
      },
    });

    if (!workroom) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
      const session = await resolveUserSession(authHeader);
      if (!session) {
        return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
      }
      const membership = await db.userWorkroomMembership.findUnique({
        where: { userId_workroomId: { userId: session.userId, workroomId: id } },
      });
      if (!membership) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
    } else {
      const machine = await verifyMachineToken(authHeader);
      if (!machine) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }
      const access = await requireMachineAccessToWorkroom(machine, id, { orgId: workroom.orgId });
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    return {
      workroom_id: workroom.id,
      org_id: workroom.orgId,
      name: workroom.name,
      description: workroom.description,
      visibility: workroom.visibility,
      purpose: workroom.purpose,
      current_goal_id: workroom.currentGoalId,
      created_by: workroom.createdBy,
      archived: workroom.archivedAt !== null,
      archived_at: workroom.archivedAt?.toISOString() ?? null,
      counts: {
        tasks: workroom._count.tasks,
        actions: workroom._count.actions,
        sessions: workroom._count.sessions,
      },
      created_at: workroom.createdAt.toISOString(),
    };
  });

  /**
   * PATCH /api/v1/workrooms/:id
   * Update workroom metadata.
   */
  app.patch('/api/v1/workrooms/:id', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      description?: string;
      visibility?: string;
      purpose?: string;
      current_goal_id?: string | null;
      archive?: boolean;  // set to true to archive
    };

    const workroom = await db.controlWorkroom.findUnique({ where: { id } });
    if (!workroom) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, id, { orgId: workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    if (workroom.archivedAt !== null) {
      return reply.code(409).send({ error: { code: 'WORKROOM_ARCHIVED', message: 'Cannot update an archived workroom' } });
    }

    const updated = await db.controlWorkroom.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
        ...(body.current_goal_id !== undefined ? { currentGoalId: body.current_goal_id } : {}),
        ...(body.archive ? { archivedAt: new Date() } : {}),
      },
    });

    return {
      workroom_id: updated.id,
      name: updated.name,
      visibility: updated.visibility,
      current_goal_id: updated.currentGoalId,
      archived: updated.archivedAt !== null,
      archived_at: updated.archivedAt?.toISOString() ?? null,
    };
  });

  /**
   * GET /api/v1/workrooms/:wid/roster  (M1: L2 Companion Graph source)
   *
   * Returns a complete view of the workroom suitable for hydrating the daemon's
   * per-agent companion graph:
   *   - workroom: id, name, org_id
   *   - channels: every channel visible to the caller, with member_ids
   *   - members:  every unique member_id appearing in any visible channel,
   *               resolved to {id, kind, display_name, role, description}
   *
   * Auth: user_sess_ OR machine_token (resolveActor with workroom scope).
   * Visibility is enforced via visibleChannels (machine viewer expands to its
   * owned agents) so daemons see private channels their agent is a member of.
   */
  app.get('/api/v1/workrooms/:wid/roster', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const workroom = await db.controlWorkroom.findUnique({
      where: { id: wid },
      select: { id: true, orgId: true, name: true },
    });
    if (!workroom) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    const actor = await resolveActor(request, { workroomId: wid });
    if (!actor) {
      return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid session or no access' } });
    }

    const viewerId = actor.kind === 'user' ? actor.userId : actor.machineId;
    const channels = await visibleChannels(
      { viewerId, viewerKind: actor.kind },
      wid,
    );

    // For each visible channel, fetch its full member list.
    const channelIds = channels.map((c) => c.id);
    const memberRows = channelIds.length === 0
      ? []
      : await db.controlChannelMember.findMany({
          where: { channelId: { in: channelIds } },
          select: { channelId: true, memberId: true },
        });

    const membersByChannel = new Map<string, string[]>();
    const allMemberIds = new Set<string>();
    for (const r of memberRows) {
      const arr = membersByChannel.get(r.channelId) ?? [];
      arr.push(r.memberId);
      membersByChannel.set(r.channelId, arr);
      allMemberIds.add(r.memberId);
    }

    // Resolve member ids → entities. memberId is opaque; for agents it's a UUID
    // (ControlAgent.id, @db.Uuid), for humans it's a User cuid (e.g. "cm…"). We
    // must shard by id shape BEFORE querying — passing a non-uuid to a uuid-typed
    // column makes Prisma throw P2023 on the whole batch.
    const memberIdList = Array.from(allMemberIds);
    const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const uuidIds = memberIdList.filter((id) => UUID_RE.test(id));
    const nonUuidIds = memberIdList.filter((id) => !UUID_RE.test(id));

    const agents = uuidIds.length === 0
      ? []
      : await db.controlAgent.findMany({
          where: { id: { in: uuidIds } },
          select: { id: true, displayName: true, name: true, role: true, description: true },
        });
    const agentIds = new Set(agents.map((a) => a.id));
    const remainingForUsers = nonUuidIds.concat(uuidIds.filter((id) => !agentIds.has(id)));

    const users = remainingForUsers.length === 0
      ? []
      : await db.user.findMany({
          where: { id: { in: remainingForUsers } },
          select: { id: true, email: true },
        });

    const members = [
      ...agents.map((a) => ({
        id: a.id,
        kind: 'agent' as const,
        display_name: (a.displayName?.trim() || a.name?.trim() || a.id),
        role: a.role,
        description: a.description ?? '',
      })),
      ...users.map((u) => ({
        id: u.id,
        kind: 'user' as const,
        display_name: u.email,
        role: 'human',
        description: '',
      })),
    ];

    return {
      workroom: {
        id: workroom.id,
        name: workroom.name,
        org_id: workroom.orgId,
      },
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        visibility: c.visibility,
        member_ids: membersByChannel.get(c.id) ?? [],
      })),
      members,
    };
  });
}
