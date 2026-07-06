/**
 * Channel API — control plane.
 *
 * Endpoints:
 *   GET    /api/v1/workrooms/:wid/channels
 *   GET    /api/v1/workrooms/:wid/dms
 *   POST   /api/v1/workrooms/:wid/dms
 *   POST   /api/v1/workrooms/:wid/channels
 *   POST   /api/v1/workrooms/:wid/channels/:cid/members
 *   DELETE /api/v1/workrooms/:wid/channels/:cid/members/:memberId
 *   POST   /api/v1/workrooms/:wid/channels/:cid/stop-agents
 *
 * Auth (Slice 7 B2-c — user_sess_/machine unification):
 *   Reads (GET):  userOrMachine — user_sess_ (workroom MEMBER) OR machine_token.
 *     Inline resolution preserves the route-specific status-code matrix
 *     (no-bearer → 401, invalid session → 401, user non-member → 403,
 *     machine cross-org → 403, workroom missing → 404). Mirrors memberRoutes.
 *   Writes:       authorizeChannelWrite — user_sess_ (workroom OWNER) OR machine_token.
 *     Non-owner user → 403; missing/invalid → 401. Mirrors authorizeTaskWrite (B2-b).
 *
 * Visibility (GET /channels): public channels visible to all members; private/dm only to
 * those with an explicit ControlChannelMember row. visibleChannels is called with the
 * `{ viewerId }` overload — viewerId = user.id for user actors, machine.id for machine actors
 * (additive overload added in B2-a; legacy ControlReadAuth overload remains until messageRoutes
 * is also converted in B2-d).
 *
 * DMs scoping (GET /dms): user actors see dm channels they're an explicit member of (by user.id);
 * machine actors see dm channels they're a member of (by machine.id). The previous "dev mode = all"
 * branch is gone — there are no anonymous read tokens any more.
 *
 * Spec: docs/superpowers/specs/2026-05-26-slock-clone-slice7-user-auth-unification-design.md §6.2
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '@/storage/db';
import { resolveActor } from '@/auth/userOrMachine/resolveActor';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { visibleChannels } from '@/control/channels/channelVisibility';
import { generateIdenticon } from '@/control/profile/identicon';
import { verifyMachineToken } from '@/machines/machineRoutes';
import {
  createChannelCore,
  addMemberCore,
  broadcastChannelEvents,
  writeChannelEventAndBroadcast,
  lookupMemberKind,
} from '@/control/channels/channelCore';
import { reelectForChannel } from '@/control/channels/coreAgentElection';

/**
 * Resolved actor for a channel WRITE: who is doing the write (the opaque id used as
 * createdBy / member id / etc.). Kept as `{ ok: true; actorId }` to stay binary-compatible
 * with existing callers (preparedActionOperatorRoutes + this file's 5 write handlers).
 */
export type WriteActor =
  | { ok: true; actorId: string }
  | { ok: false; status: number; body: { error: { code: string; message: string } } };

/**
 * Authorize a channel WRITE request (Slice 7 B2-c):
 *   1. user_sess_  → must be a workroom OWNER (per §6.2). Non-owner → 403; non-member → 403.
 *   2. machine_token → must have org access to the workroom.
 *   3. anything else / missing bearer → 401.
 *
 * `command` is preserved for API compatibility and future per-command auditing but is not
 * gated against an allowlist (granular per-command grants died with Slice 7 — mirrors
 * authorizeTaskWrite / authorizeAgentWrite in B2-b).
 */
export async function authorizeChannelWrite(
  request: FastifyRequest,
  command: 'create_channel' | 'manage_members' | 'stop_agents',
  workroomId: string,
): Promise<WriteActor> {
  void command; // reserved for future audit; user/machine path does not gate by command

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } },
    };
  }
  const token = authHeader.slice(7);

  // ── Path 1: user_sess_ ──
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return {
        ok: false,
        status: 401,
        body: { error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } },
      };
    }
    const actor = await resolveActor(request, { workroomId });
    if (!actor || actor.kind !== 'user') {
      return {
        ok: false,
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
      };
    }
    if (actor.workroomRole !== 'owner') {
      return {
        ok: false,
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
      };
    }
    return { ok: true, actorId: actor.userId };
  }

  // ── Path 2: machine_token ──
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return {
      ok: false,
      status: 401,
      body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } },
    };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) {
    return { ok: false, status: access.status, body: { error: access.error } };
  }
  return { ok: true, actorId: machine.id };
}

// ── Read-auth resolver (user_sess_ member OR machine_token) ──────────────────────
//
// Inline path that preserves the route-specific status-code matrix (401/403/404),
// mirroring memberRoutes / slockTaskRoutes (B2-a/b precedent). resolveActor exists
// but uniformly collapses failures to null — using it would lose the existing
// 401-vs-403-vs-404 disambiguation tested today.

type ChannelReadResult =
  | { ok: true; viewerId: string; viewerKind: 'user' | 'machine' }
  | { ok: false; status: number; error: { code: string; message: string } };

async function resolveChannelReadActor(
  req: FastifyRequest,
  workroomId: string,
): Promise<ChannelReadResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    };
  }
  const token = authHeader.slice(7);

  // ── Path 1: user_sess_ ──
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return {
        ok: false,
        status: 401,
        error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' },
      };
    }
    // 404 if workroom missing (anti-enumeration, mirrors memberRoutes).
    const wr = await db.controlWorkroom.findUnique({
      where: { id: workroomId },
      select: { id: true, archivedAt: true },
    });
    if (!wr) {
      return {
        ok: false,
        status: 404,
        error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' },
      };
    }
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId } },
    });
    if (!mem) {
      return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    return { ok: true, viewerId: session.userId, viewerKind: 'user' };
  }

  // ── Path 2: machine_token ──
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return {
      ok: false,
      status: 401,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, viewerId: machine.id, viewerKind: 'machine' };
}

/** Per-channel unread counts for a USER viewer: messages newer than the
 *  caller's read cursor, excluding own + system messages and thread replies. */
async function unreadCountsFor(userId: string, channelIds: string[]): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ channel_id: string; n: bigint }>>`
    SELECT m.channel_id, count(*)::bigint AS n
    FROM control_messages m
    LEFT JOIN control_channel_reads r
      ON r.channel_id = m.channel_id AND r.user_id = ${userId}
    WHERE m.channel_id = ANY(${channelIds}::uuid[])
      AND m.seq > COALESCE(r.last_read_seq, 0)
      AND m.sender_id <> ${userId}
      AND m.sender_kind <> 'system'
      AND m.parent_message_id IS NULL
    GROUP BY m.channel_id`;
  return new Map(rows.map((r) => [r.channel_id, Number(r.n)]));
}

export async function channelRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/channels
   *
   * Returns all non-archived channels visible to the caller for the given workroom.
   * Per-channel derived fields: last_activity_at, unread_count (0), attention_count,
   * member_count.
   *
   * Auth: userOrMachine — user_sess_ workroom member OR machine_token org-scoped.
   */
  app.get('/api/v1/workrooms/:wid/channels', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const guard = await resolveChannelReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

    // Verify the workroom is not archived. (resolveChannelReadActor already returned 404
    // for missing workroom on the user path; for machine path the workroom is the access
    // check's source of truth and so cannot be missing here. But we still gate archived.)
    const workroom = await db.controlWorkroom.findUnique({
      where: { id: wid },
      select: { id: true, archivedAt: true },
    });
    if (!workroom || workroom.archivedAt !== null) {
      return reply
        .code(404)
        .send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    // Visible channels — Slice 7.5: machine viewers also see channels where their
    // owned agents are members (daemon auths as machine but agents own membership).
    const channels = await visibleChannels({ viewerId: guard.viewerId, viewerKind: guard.viewerKind }, wid);

    if (channels.length === 0) {
      return { workroom_id: wid, channels: [] };
    }

    const channelIds = channels.map((c) => c.id);

    const [needsHumanActions, pendingApprovals, memberCounts] = await Promise.all([
      db.controlAction.count({ where: { workroomId: wid, status: 'needs_human' } }),
      db.controlApproval.count({ where: { workroomId: wid, status: 'pending' } }),
      db.controlChannelMember.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds } },
        _count: { channelId: true },
      }),
    ]);

    const memberCountMap = new Map<string, number>(
      memberCounts.map((row) => [row.channelId, row._count.channelId]),
    );
    const unreadMap = guard.viewerKind === 'user'
      ? await unreadCountsFor(guard.viewerId, channelIds)
      : new Map<string, number>();
    const totalAttention = needsHumanActions + pendingApprovals;

    const responseChannels = channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      visibility: ch.visibility,
      last_activity_at: ch.lastActivityAt?.toISOString() ?? null,
      unread_count: unreadMap.get(ch.id) ?? 0,
      attention_count: totalAttention,
      member_count: memberCountMap.get(ch.id) ?? 0,
    }));

    return {
      workroom_id: wid,
      channels: responseChannels,
    };
  });

  /**
   * GET /api/v1/workrooms/:wid/dms
   *
   * Returns the direct-message channels for a workroom. Per dm:
   *   peer_member_id = the first ControlChannelMember.memberId that is NOT the caller
   *                    (null if none).
   *   unread_count   = 0 (no read-cursor system yet — honest 0).
   *   last_activity_at = channel.lastActivityAt (ISO8601 or null).
   *
   * Scope (B2-c):
   *   user actor    → dm channels where user.id is a ControlChannelMember.
   *   machine actor → dm channels where machine.id is a ControlChannelMember.
   * The previous "dev mode = ALL dm channels" branch is gone (no anonymous read tokens
   * exist after Slice 7); leaving it would have been a privacy regression (would have
   * exposed every dm in the workroom to any anonymous reader).
   */
  app.get('/api/v1/workrooms/:wid/dms', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const guard = await resolveChannelReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

    const callerId = guard.viewerId;

    const dmChannels = await db.controlChannel.findMany({
      where: {
        workroomId: wid,
        type: 'dm',
        archivedAt: null,
        members: { some: { memberId: callerId } },
      },
      include: {
        members: { select: { memberId: true } },
      },
      orderBy: { lastActivityAt: 'desc' },
    });

    // Resolve each DM peer's display name + avatar so the client shows "Alex", not a raw id.
    // Peers are human users (cuid) or agents (uuid) — batch-fetch both, identicon for avatar.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const peerIds = [...new Set(
      dmChannels
        .map((ch) => ch.members.find((m) => m.memberId !== callerId)?.memberId)
        .filter((x): x is string => !!x),
    )];
    const agentPeerIds = peerIds.filter((id) => UUID_RE.test(id));
    const humanPeerIds = peerIds.filter((id) => !UUID_RE.test(id));
    const [agentPeers, humanPeers] = await Promise.all([
      agentPeerIds.length
        ? db.controlAgent.findMany({ where: { id: { in: agentPeerIds } }, select: { id: true, name: true } })
        : Promise.resolve([]),
      humanPeerIds.length
        ? db.user.findMany({ where: { id: { in: humanPeerIds } }, select: { id: true, email: true, displayName: true } })
        : Promise.resolve([]),
    ]);
    const peerInfo = new Map<string, { name: string; avatar: string }>();
    for (const a of agentPeers) peerInfo.set(a.id, { name: a.name, avatar: generateIdenticon(a.name || a.id) });
    for (const u of humanPeers) {
      const nm = u.displayName || u.email;
      peerInfo.set(u.id, { name: nm, avatar: generateIdenticon(nm) });
    }

    const dmUnread = guard.viewerKind === 'user'
      ? await unreadCountsFor(callerId, dmChannels.map((c) => c.id))
      : new Map<string, number>();
    const dms = dmChannels.map((ch) => {
      const peer = ch.members.find((m) => m.memberId !== callerId)?.memberId ?? null;
      const info = peer ? peerInfo.get(peer) : undefined;
      return {
        id: ch.id,
        peer_member_id: peer,
        peer_display_name: info?.name ?? null,
        peer_avatar: info?.avatar ?? null,
        unread_count: dmUnread.get(ch.id) ?? 0,
        last_activity_at: ch.lastActivityAt?.toISOString() ?? null,
      };
    });

    return { dms };
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/read — advance the caller's read
   * cursor to `seq` (monotone: never moves backwards). User sessions only;
   * machine/agent readers do not participate in unread accounting.
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/read', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };
    const guard = await resolveChannelReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });
    if (guard.viewerKind !== 'user') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'User sessions only' } });
    }
    const body = request.body as { seq?: unknown } | null;
    let seq: bigint;
    try { seq = BigInt(String(body?.seq ?? '')); } catch {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'seq is required' } });
    }
    const ch = await db.controlChannel.findUnique({ where: { id: cid }, select: { workroomId: true } });
    if (!ch || ch.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    // Monotone upsert: GREATEST keeps a stale tab from rolling the cursor back.
    await db.$executeRaw`
      INSERT INTO control_channel_reads (channel_id, user_id, last_read_seq, updated_at)
      VALUES (${cid}::uuid, ${guard.viewerId}, ${seq}, now())
      ON CONFLICT (channel_id, user_id)
      DO UPDATE SET last_read_seq = GREATEST(control_channel_reads.last_read_seq, EXCLUDED.last_read_seq), updated_at = now()`;
    return reply.send({ ok: true });
  });

  /**
   * POST /api/v1/workrooms/:wid/dms  (start a direct message)
   *
   * Find-or-create a dm channel between the caller and a target member.
   * Auth: user_sess_ (workroom OWNER) OR machine_token (via authorizeChannelWrite).
   * Body: { member_id: string }.
   *
   * Find-or-create looks for an existing dm whose member set is EXACTLY {caller, member_id};
   * if found, returns it (idempotent), else creates new dm + member rows + publishes
   * channel.created.
   */
  app.post('/api/v1/workrooms/:wid/dms', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const actor = await authorizeChannelWrite(request, 'create_channel', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const body = request.body as { member_id?: unknown } | null;
    const memberId = typeof body?.member_id === 'string' ? body.member_id.trim() : '';
    if (!memberId) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_MEMBER_ID', message: 'member_id is required' } });
    }

    const callerId = actor.actorId;

    const candidates = await db.controlChannel.findMany({
      where: {
        workroomId: wid,
        type: 'dm',
        archivedAt: null,
        members: { some: { memberId } },
      },
      include: { members: { select: { memberId: true } } },
    });
    const existing = candidates.find((ch) => {
      const set = new Set(ch.members.map((m) => m.memberId));
      return set.size === 2 && set.has(callerId) && set.has(memberId);
    });

    if (existing) {
      return reply.code(201).send({
        id: existing.id,
        peer_member_id: memberId,
        unread_count: 0,
        last_activity_at: existing.lastActivityAt?.toISOString() ?? null,
      });
    }

    const now = new Date();
    const channel = await db.controlChannel.create({
      data: {
        workroomId: wid,
        name: 'dm',
        type: 'dm',
        visibility: 'private',
        description: '',
        createdBy: callerId,
        lastActivityAt: now,
      },
    });

    await db.controlChannelMember.createMany({
      data: [...new Set([callerId, memberId])].map((m) => ({
        channelId: channel.id,
        memberId: m,
      })),
      skipDuplicates: true,
    });

    await writeChannelEventAndBroadcast(wid, 'channel.created', {
      channel_id: channel.id,
      name: channel.name,
      type: channel.type,
      visibility: channel.visibility,
      created_by: callerId,
      peer_member_id: memberId,
    });

    // roster.* mirrors (M1) — one per unique member of the new DM.
    for (const mid of new Set([callerId, memberId])) {
      const kind = await lookupMemberKind(mid);
      await writeChannelEventAndBroadcast(wid, 'roster.member_added', {
        channel_id: channel.id,
        member_id: mid,
        member_kind: kind,
      });
    }

    // A DM with an agent peer needs a core so an @-nobody message (the normal
    // case in a 1:1) still wakes the agent. Election on a 1-agent channel picks
    // that agent deterministically (no LLM). Off-path.
    reelectForChannel(channel.id);

    return reply.code(201).send({
      id: channel.id,
      peer_member_id: memberId,
      unread_count: 0,
      last_activity_at: channel.lastActivityAt?.toISOString() ?? null,
    });
  });

  /**
   * POST /api/v1/workrooms/:wid/channels  (create a standard channel)
   *
   * Auth: user_sess_ (workroom OWNER) OR machine_token (via authorizeChannelWrite).
   * Body: { name: string, description?: string, visibility: 'public'|'private', member_ids?: string[] }.
   */
  app.post('/api/v1/workrooms/:wid/channels', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const actor = await authorizeChannelWrite(request, 'create_channel', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const body = request.body as {
      name?: unknown;
      description?: unknown;
      visibility?: unknown;
      member_ids?: unknown;
    } | null;

    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_NAME', message: 'name is required' } });
    }

    const visibility = body?.visibility;
    if (visibility !== 'public' && visibility !== 'private') {
      return reply.code(400).send({
        error: {
          code: 'INVALID_VISIBILITY',
          message: "visibility must be 'public' or 'private'",
        },
      });
    }

    const description = typeof body?.description === 'string' ? body.description : '';

    const memberIds = Array.isArray(body?.member_ids)
      ? (body!.member_ids as unknown[]).filter(
          (m): m is string => typeof m === 'string' && m.length > 0,
        )
      : [];

    const { channel, memberCount, events } = await createChannelCore({
      workroomId: wid,
      actorId: actor.actorId,
      name,
      visibility,
      description,
      memberIds,
    });
    broadcastChannelEvents(events);

    return reply.code(201).send({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      visibility: channel.visibility,
      last_activity_at: channel.lastActivityAt?.toISOString() ?? null,
      unread_count: 0,
      attention_count: 0,
      member_count: memberCount,
    });
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/members
   * Add a member (idempotent). Auth: user_sess_ owner OR machine.
   * Channel must be in :wid (404 otherwise). Publishes channel.member_added on real insert.
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/members', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const actor = await authorizeChannelWrite(request, 'manage_members', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const body = request.body as { member_id?: unknown } | null;
    const memberId = typeof body?.member_id === 'string' ? body.member_id.trim() : '';
    if (!memberId) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_MEMBER_ID', message: 'member_id is required' } });
    }

    const r = await addMemberCore({
      workroomId: wid,
      channelId: cid,
      memberId,
      actorId: actor.actorId,
    });
    if (r.notFound) {
      return reply
        .code(404)
        .send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    broadcastChannelEvents(r.events);
    return reply.send({ ok: true });
  });

  /**
   * DELETE /api/v1/workrooms/:wid/channels/:cid/members/:memberId
   * Remove a member (idempotent). Auth: user_sess_ owner OR machine.
   * Channel must be in :wid (404 otherwise). Publishes channel.member_removed on real delete.
   */
  app.delete(
    '/api/v1/workrooms/:wid/channels/:cid/members/:memberId',
    async (request, reply) => {
      const { wid, cid, memberId } = request.params as {
        wid: string;
        cid: string;
        memberId: string;
      };

      const actor = await authorizeChannelWrite(request, 'manage_members', wid);
      if (!actor.ok) return reply.code(actor.status).send(actor.body);

      const channel = await db.controlChannel.findUnique({
        where: { id: cid },
        select: { workroomId: true },
      });
      if (!channel || channel.workroomId !== wid) {
        return reply
          .code(404)
          .send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
      }

      const result = await db.controlChannelMember.deleteMany({
        where: { channelId: cid, memberId },
      });
      if (result.count === 0) {
        return reply.send({ ok: true });
      }

      await writeChannelEventAndBroadcast(wid, 'channel.member_removed', {
        channel_id: cid,
        member_id: memberId,
        removed_by: actor.actorId,
      });
      // roster.* mirror (M1)
      await writeChannelEventAndBroadcast(wid, 'roster.member_removed', {
        channel_id: cid,
        member_id: memberId,
      });

      // Roster changed → re-elect the channel's core agent (off-path).
      reelectForChannel(cid);

      return reply.send({ ok: true });
    },
  );

  /**
   * GET /api/v1/workrooms/:wid/channels/:cid/members
   *
   * List member IDs of a channel. Returns `{ channel_id, members: [{ member_id }] }`.
   * Auth: same read-auth as GET /channels (user_sess_ workroom member OR machine).
   * Used by the iOS member sheet so it can show who is currently in the channel
   * (the GET /channels list response does not include member IDs).
   */
  app.get('/api/v1/workrooms/:wid/channels/:cid/members', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const guard = await resolveChannelReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

    const channel = await db.controlChannel.findUnique({
      where: { id: cid },
      select: { workroomId: true, archivedAt: true },
    });
    if (!channel || channel.workroomId !== wid || channel.archivedAt !== null) {
      return reply
        .code(404)
        .send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    const rows = await db.controlChannelMember.findMany({
      where: { channelId: cid },
      select: { memberId: true },
    });

    return {
      channel_id: cid,
      members: rows.map((r) => ({ member_id: r.memberId })),
    };
  });

  /**
   * PATCH /api/v1/workrooms/:wid/channels/:cid
   *
   * Update mutable channel fields. Body may include `name?: string` and/or
   * `visibility?: 'public'|'private'`. At least one must be present. Auth:
   * user_sess_ workroom OWNER OR machine (mirrors POST /channels).
   * Returns the updated channel in the same wire shape as the list item.
   */
  app.patch('/api/v1/workrooms/:wid/channels/:cid', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const actor = await authorizeChannelWrite(request, 'manage_members', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const body = request.body as { name?: unknown; visibility?: unknown } | null;
    const update: { name?: string; visibility?: 'public' | 'private' } = {};

    if (body?.name !== undefined) {
      const n = typeof body.name === 'string' ? body.name.trim() : '';
      if (!n) {
        return reply
          .code(400)
          .send({ error: { code: 'INVALID_NAME', message: 'name is required' } });
      }
      update.name = n;
    }
    if (body?.visibility !== undefined) {
      if (body.visibility !== 'public' && body.visibility !== 'private') {
        return reply.code(400).send({
          error: {
            code: 'INVALID_VISIBILITY',
            message: "visibility must be 'public' or 'private'",
          },
        });
      }
      update.visibility = body.visibility;
    }
    if (update.name === undefined && update.visibility === undefined) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_BODY', message: 'name or visibility required' } });
    }

    const existing = await db.controlChannel.findUnique({
      where: { id: cid },
      select: { workroomId: true, archivedAt: true, type: true },
    });
    if (!existing || existing.workroomId !== wid || existing.archivedAt !== null) {
      return reply
        .code(404)
        .send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    if (existing.type === 'dm') {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_CHANNEL_TYPE', message: 'DM channels cannot be edited' } });
    }

    const updated = await db.controlChannel.update({
      where: { id: cid },
      data: update,
    });

    const memberCount = await db.controlChannelMember.count({ where: { channelId: cid } });

    await writeChannelEventAndBroadcast(wid, 'channel.updated', {
      channel_id: cid,
      name: updated.name,
      visibility: updated.visibility,
      updated_by: actor.actorId,
    });

    return reply.send({
      id: updated.id,
      name: updated.name,
      type: updated.type,
      visibility: updated.visibility,
      last_activity_at: updated.lastActivityAt?.toISOString() ?? null,
      unread_count: 0,
      attention_count: 0,
      member_count: memberCount,
    });
  });

  /**
   * DELETE /api/v1/workrooms/:wid/channels/:cid
   *
   * Hard-delete a channel and its membership rows. Auth: user_sess_ OWNER OR
   * machine (mirrors POST /channels). DMs cannot be deleted via this route.
   * Publishes channel.deleted on success.
   */
  app.delete('/api/v1/workrooms/:wid/channels/:cid', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const actor = await authorizeChannelWrite(request, 'manage_members', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const existing = await db.controlChannel.findUnique({
      where: { id: cid },
      select: { workroomId: true, type: true },
    });
    if (!existing || existing.workroomId !== wid) {
      return reply
        .code(404)
        .send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    if (existing.type === 'dm') {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_CHANNEL_TYPE', message: 'DM channels cannot be deleted' } });
    }

    // No onDelete cascade exists on any of these FKs, so children must be deleted
    // (or FK-nulled) in strict dependency order before the channel itself, or
    // Postgres raises P2003. The full set of real DB FKs that ultimately chain to
    // this channel (verified against the migration DDL — exactly 4 FKs REFERENCE
    // control_channels(id), plus the message-chained FKs below):
    //   control_channel_members.channel_id     → control_channels  (NOT NULL, delete row)
    //   control_messages.channel_id            → control_channels  (nullable, channel-owned → delete)
    //   control_reminders.channel_id           → control_channels  (NOT NULL, no cascade → delete row;
    //                                             control_reminder_events cascades via ON DELETE on reminder_id)
    //   control_prepared_actions.channel_id    → control_channels  (NOT NULL, no cascade → delete row)
    //   control_threads.parent_message_id      → control_messages  (NOT NULL, must delete row)
    //   control_message_reactions.message_id   → control_messages  (NOT NULL, must delete row)
    //   control_attachments.message_id         → control_messages  (nullable, channel-owned → delete)
    //   control_tasks.thread_id                → control_threads    (nullable)
    //   control_tasks.source_message_id        → control_messages   (nullable)
    //   control_working_agreements.created_from_message_id → control_messages (nullable, cross-entity → null)
    //   control_handoffs.created_from_message_id           → control_messages (nullable, cross-entity → null)
    //   control_role_insights.related_message_id           → control_messages (nullable, cross-entity → null)
    //   control_router_decisions.trigger_message_id        → control_messages (nullable, cross-entity → null)
    //   control_goals.source_message_id                    → control_messages (nullable, cross-entity → null)
    // ControlSavedMessage / ControlClientCursor have NO DB FK (control-plane
    // self-ref convention) so they are intentionally left untouched.
    //
    // Explicit timeout/maxWait: a large channel cascade can exceed Prisma's default
    // 5s interactive-transaction budget mid-way and abort, so we widen it.
    // SCALE GUARD: child deletes/updates that filter by an id-array (`{ in: ids }`)
    // bind one Postgres parameter per id. A channel with tens of thousands of
    // messages would blow Postgres' ~65535 extended-protocol parameter ceiling
    // and abort the whole tx (and big arrays also pressure the 30s budget).
    // Two mitigations below:
    //   1. Prefer a direct `channelId` filter wherever the child table has one
    //      (control_tasks, control_attachments) — one bound param regardless of
    //      row count. Only the id-array-driven steps that have NO channelId
    //      column remain.
    //   2. Chunk every remaining `{ in: ids }` step into ID_CHUNK-sized batches.
    const ID_CHUNK = 1000;
    const chunk = <T>(arr: T[]): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += ID_CHUNK) out.push(arr.slice(i, i + ID_CHUNK));
      return out;
    };

    await db.$transaction(async (tx) => {
      const messages = await tx.controlMessage.findMany({
        where: { channelId: cid },
        select: { id: true },
      });
      const messageIds = messages.map((m) => m.id);
      const messageIdChunks = chunk(messageIds);

      // Threads anchored to this channel's messages (and their ids, for tasks).
      const threads = await tx.controlThread.findMany({
        where: { parentMessageId: { in: messageIds } },
        select: { id: true },
      });
      const threadIds = threads.map((t) => t.id);
      const threadIdChunks = chunk(threadIds);

      // Tasks belonging to this channel: by channelId, or referencing one of this
      // channel's messages/threads. The channelId-owned tasks are deleted by the
      // direct channelId filter below; we still need the id-array for tasks that
      // belong to OTHER channels but reference one of this channel's
      // messages/threads (cross-channel thread/source refs), so gather those ids.
      const crossRefTasks = await tx.controlTask.findMany({
        where: {
          channelId: { not: cid },
          OR: [
            { threadId: { in: threadIds } },
            { sourceMessageId: { in: messageIds } },
            { parentMessageId: { in: messageIds } },
          ],
        },
        select: { id: true },
      });
      const channelOwnedTaskIds = (
        await tx.controlTask.findMany({ where: { channelId: cid }, select: { id: true } })
      ).map((t) => t.id);
      // Full set of task ids whose children must be detached + that must be deleted.
      const taskIds = [...channelOwnedTaskIds, ...crossRefTasks.map((t) => t.id)];
      const crossRefTaskIdChunks = chunk(crossRefTasks.map((t) => t.id));
      const taskIdChunks = chunk(taskIds);

      // Detach cross-entity rows that FK → these tasks (all nullable; rows may
      // belong to other flows so we null rather than delete). Chunked over taskIds.
      for (const ids of taskIdChunks) {
        await tx.controlAction.updateMany({ where: { taskId: { in: ids } }, data: { taskId: null } });
        await tx.controlApproval.updateMany({ where: { taskId: { in: ids } }, data: { taskId: null } });
        await tx.controlArtifact.updateMany({ where: { taskId: { in: ids } }, data: { taskId: null } });
        await tx.controlHandoff.updateMany({ where: { taskId: { in: ids } }, data: { taskId: null } });
      }

      // Delete tasks (ref threads + messages) before threads/messages.
      // channelId-owned tasks: one direct filter (no param explosion).
      await tx.controlTask.deleteMany({ where: { channelId: cid } });
      // cross-channel tasks referencing this channel's messages/threads: by id, chunked.
      for (const ids of crossRefTaskIdChunks) {
        await tx.controlTask.deleteMany({ where: { id: { in: ids } } });
      }

      // Threads (ref messages) — delete before messages. By id, chunked.
      for (const ids of threadIdChunks) {
        await tx.controlThread.deleteMany({ where: { id: { in: ids } } });
      }

      // Rows whose FK → messages is NOT NULL or channel-owned: delete.
      // ControlMessageReaction has only message_id (no channel_id) → chunk by messageIds.
      for (const ids of messageIdChunks) {
        await tx.controlMessageReaction.deleteMany({ where: { messageId: { in: ids } } });
      }
      // ControlAttachment HAS a channel_id column → delete channel-owned rows directly.
      await tx.controlAttachment.deleteMany({ where: { channelId: cid } });
      // …plus any attachment that points at one of this channel's messages but
      // carries a different/null channel_id (message_id-only) → chunk by messageIds.
      for (const ids of messageIdChunks) {
        await tx.controlAttachment.deleteMany({ where: { messageId: { in: ids } } });
      }

      // Cross-entity OPTIONAL FK → messages: null out (rows may belong to other
      // channels/flows; only the dangling pointer to a soon-deleted message matters).
      // None of these have a channel_id column, so chunk by messageIds.
      for (const ids of messageIdChunks) {
        await tx.controlWorkingAgreement.updateMany({
          where: { createdFromMessageId: { in: ids } },
          data: { createdFromMessageId: null },
        });
        await tx.controlHandoff.updateMany({
          where: { createdFromMessageId: { in: ids } },
          data: { createdFromMessageId: null },
        });
        await tx.controlRoleInsight.updateMany({
          where: { relatedMessageId: { in: ids } },
          data: { relatedMessageId: null },
        });
        await tx.controlRouterDecision.updateMany({
          where: { triggerMessageId: { in: ids } },
          data: { triggerMessageId: null },
        });
        await tx.controlGoal.updateMany({
          where: { sourceMessageId: { in: ids } },
          data: { sourceMessageId: null },
        });
      }

      // NOT-NULL channel FKs with no DB cascade: reminders + prepared actions.
      // Must delete these rows before the channel or Postgres raises P2003.
      // control_reminder_events cascades automatically (ON DELETE CASCADE on
      // reminder_id), so deleting the reminder rows is sufficient. Direct channelId.
      await tx.controlReminder.deleteMany({ where: { channelId: cid } });
      await tx.controlPreparedAction.deleteMany({ where: { channelId: cid } });

      // Now safe to delete the messages, membership, and the channel. Direct channelId.
      await tx.controlMessage.deleteMany({ where: { channelId: cid } });
      await tx.controlChannelMember.deleteMany({ where: { channelId: cid } });
      await tx.controlChannel.delete({ where: { id: cid } });
    }, { timeout: 30000, maxWait: 5000 });

    await writeChannelEventAndBroadcast(wid, 'channel.deleted', {
      channel_id: cid,
      deleted_by: actor.actorId,
    });

    return reply.send({ ok: true });
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/stop-agents  (emergency stop)
   * Auth: user_sess_ owner OR machine. Channel must be in :wid. Publishes agents.stop.
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/stop-agents', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const actor = await authorizeChannelWrite(request, 'stop_agents', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const channel = await db.controlChannel.findUnique({
      where: { id: cid },
      select: { workroomId: true },
    });
    if (!channel || channel.workroomId !== wid) {
      return reply
        .code(404)
        .send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    await writeChannelEventAndBroadcast(wid, 'agents.stop', {
      channel_id: cid,
      stopped_by: actor.actorId,
    });

    return reply.send({ ok: true });
  });
}
