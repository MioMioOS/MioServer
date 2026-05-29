/**
 * friendRoutes — R4 (minimal collaboration): human-to-human friendships + adding
 * a human friend to a control-plane channel.
 *
 * All endpoints are authed with a user_sess_ Bearer via resolveUserSession
 * (sources/auth/userSession/resolveUserSession.ts). There is no machine path here:
 * friendships and "pull a friend into a channel" are inherently human acts.
 *
 * ── Friendship model (see prisma UserFriendship) ────────────────────────────────
 * ONE canonical row per pair: userId = lexicographically SMALLER user id, friendId =
 * larger, with @@unique([userId, friendId]) deduping both directions. `requestedBy`
 * records who initiated; `status` is 'pending' | 'accepted'. Discovery is by EXACT
 * email only (no search). A user's accepted friends are
 *   where (userId = me OR friendId = me) AND status = 'accepted'.
 *
 * Endpoints:
 *   POST /v1/friends/request            { email }             — send/idempotent-get a request
 *   POST /v1/friends/:friendUserId/accept                     — the non-requester accepts
 *   GET  /v1/friends                                          — accepted + pending in/out
 *   POST /api/v1/channels/:channelId/members  { friend_user_id }
 *        — workspace OWNER pulls an ACCEPTED friend into a channel (+ grants workroom access)
 *
 * Avatar is derived: identicon(displayName || email) — no upload, no avatar column
 * (locked decision). Mirrors agentApiProfile's buildProfile shape.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { generateIdenticon } from '@/control/profile/identicon';
import { addMemberCore, broadcastChannelEvents } from '@/control/channels/channelCore';

// ── Shared helpers ──────────────────────────────────────────────────────────────

/**
 * Authenticate a user_sess_ Bearer. Returns the userId on success or replies 401
 * and returns null. Centralised so all four handlers share one auth shape.
 */
async function authUser(
  request: FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<string | null> {
  const session = await resolveUserSession(request.headers.authorization);
  if (!session) {
    reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
    return null;
  }
  return session.userId;
}

/**
 * Canonical ordering for a friendship pair: userId is the lexicographically smaller
 * id, friendId the larger. Guarantees exactly one row per pair regardless of who
 * initiates, matching the @@unique([userId, friendId]) constraint.
 */
function canonicalPair(a: string, b: string): { userId: string; friendId: string } {
  return a < b ? { userId: a, friendId: b } : { userId: b, friendId: a };
}

type FriendUserRow = { id: string; email: string; displayName: string | null };

/** Public friend shape: { id, email, display_name, avatar(identicon) }. */
function buildFriendView(u: FriendUserRow) {
  return {
    id: u.id,
    email: u.email,
    display_name: u.displayName,
    avatar: generateIdenticon(u.displayName || u.email),
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function friendRoutes(app: FastifyInstance) {
  /**
   * POST /v1/friends/request  { email }
   *
   * Look up the target user by EXACT email; create (or fetch) the canonical
   * UserFriendship row (status 'pending', requestedBy = me). Idempotent: if a row
   * already exists for the pair, return its current status (does NOT reset it).
   *
   * Responses:
   *   200 { status, requested_by, friend: {...} }
   *   400 INVALID_BODY        — email missing/blank
   *   400 CANNOT_FRIEND_SELF  — email resolves to the caller
   *   401 INVALID_SESSION
   *   404 USER_NOT_FOUND      — no user with that exact email
   */
  app.post('/v1/friends/request', async (request, reply) => {
    const myId = await authUser(request, reply);
    if (!myId) return;

    const body = request.body as { email?: unknown } | null;
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!email) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'email is required' } });
    }

    // Case-INSENSITIVE email match (emails are effectively case-insensitive; the iOS client
    // lowercases input, so an exact match would 404 a mixed-case-registered user).
    const target = await db.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, displayName: true },
    });
    if (!target) {
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message: 'No user with that email' } });
    }
    if (target.id === myId) {
      return reply.code(400).send({ error: { code: 'CANNOT_FRIEND_SELF', message: 'Cannot friend yourself' } });
    }

    const pair = canonicalPair(myId, target.id);

    const existing = await db.userFriendship.findUnique({
      where: { userId_friendId: pair },
    });
    if (existing) {
      // Idempotent: surface the current state without mutating it.
      return reply.code(200).send({
        status: existing.status,
        requested_by: existing.requestedBy,
        friend: buildFriendView(target),
      });
    }

    const created = await db.userFriendship.create({
      data: { userId: pair.userId, friendId: pair.friendId, status: 'pending', requestedBy: myId },
    });

    return reply.code(200).send({
      status: created.status,
      requested_by: created.requestedBy,
      friend: buildFriendView(target),
    });
  });

  /**
   * POST /v1/friends/:friendUserId/accept
   *
   * Accept a pending incoming request. Only the NON-requester (the party that did
   * not initiate) may accept. Idempotent on an already-accepted pair.
   *
   * Responses:
   *   200 { status: 'accepted', friend: {...} }
   *   401 INVALID_SESSION
   *   403 NOT_THE_RECIPIENT   — caller is the requester (can't accept own request)
   *   404 REQUEST_NOT_FOUND   — no friendship row for the pair
   */
  app.post('/v1/friends/:friendUserId/accept', async (request, reply) => {
    const myId = await authUser(request, reply);
    if (!myId) return;

    const { friendUserId } = request.params as { friendUserId: string };
    const pair = canonicalPair(myId, friendUserId);

    const row = await db.userFriendship.findUnique({
      where: { userId_friendId: pair },
    });
    if (!row) {
      return reply.code(404).send({ error: { code: 'REQUEST_NOT_FOUND', message: 'No friend request to accept' } });
    }

    const other = await db.user.findUnique({
      where: { id: friendUserId },
      select: { id: true, email: true, displayName: true },
    });
    if (!other) {
      return reply.code(404).send({ error: { code: 'REQUEST_NOT_FOUND', message: 'No friend request to accept' } });
    }

    // Already accepted → idempotent success.
    if (row.status === 'accepted') {
      return reply.code(200).send({ status: 'accepted', friend: buildFriendView(other) });
    }

    // Only the non-requester may accept.
    if (row.requestedBy === myId) {
      return reply.code(403).send({ error: { code: 'NOT_THE_RECIPIENT', message: 'Only the recipient can accept' } });
    }

    await db.userFriendship.update({
      where: { userId_friendId: pair },
      data: { status: 'accepted' },
    });

    return reply.code(200).send({ status: 'accepted', friend: buildFriendView(other) });
  });

  /**
   * GET /v1/friends
   *
   * List the caller's friendships partitioned into accepted, incoming (pending,
   * someone else requested me) and outgoing (pending, I requested). Each entry
   * carries the OTHER user's { id, email, display_name, avatar }.
   *
   * Responses:
   *   200 { accepted: [...], incoming: [...], outgoing: [...] }
   *   401 INVALID_SESSION
   */
  app.get('/v1/friends', async (request, reply) => {
    const myId = await authUser(request, reply);
    if (!myId) return;

    const rows = await db.userFriendship.findMany({
      where: { OR: [{ userId: myId }, { friendId: myId }] },
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        friend: { select: { id: true, email: true, displayName: true } },
      },
    });

    const accepted: ReturnType<typeof buildFriendView>[] = [];
    const incoming: ReturnType<typeof buildFriendView>[] = [];
    const outgoing: ReturnType<typeof buildFriendView>[] = [];

    for (const r of rows) {
      // The "other" user is whichever side of the canonical pair isn't me.
      const other = r.userId === myId ? r.friend : r.user;
      const view = buildFriendView(other);
      if (r.status === 'accepted') {
        accepted.push(view);
      } else if (r.requestedBy === myId) {
        outgoing.push(view);
      } else {
        incoming.push(view);
      }
    }

    return reply.code(200).send({ accepted, incoming, outgoing });
  });

  /**
   * POST /api/v1/channels/:channelId/members  { friend_user_id }
   *
   * Pull a HUMAN friend into a channel. Distinct from the workroom-scoped
   * /api/v1/workrooms/:wid/channels/:cid/members route (that one is for the
   * owner/machine adding any opaque actor); this one is the human-collaboration
   * affordance with friendship + ownership gating.
   *
   * PERMISSION (locked): only the WORKSPACE OWNER may add — the caller must hold a
   * UserWorkroomMembership with role 'owner' for the workroom the channel belongs to.
   * The added human must be an ACCEPTED friend of the caller.
   *
   * Effects:
   *   1. ControlChannelMember(channelId, memberId = friend_user_id)  [humans use their user id].
   *      Idempotent (re-add is a no-op). Emits channel.member_added + roster.member_added.
   *   2. Ensures the friend can reach the workroom: creates a UserWorkroomMembership
   *      (role 'member') if absent (idempotent).
   *
   * Responses:
   *   200 { ok: true }
   *   400 INVALID_BODY         — friend_user_id missing
   *   401 INVALID_SESSION
   *   403 NOT_WORKSPACE_OWNER  — caller doesn't own the workroom
   *   403 NOT_FRIENDS          — target isn't an accepted friend
   *   404 CHANNEL_NOT_FOUND
   */
  app.post('/api/v1/channels/:channelId/members', async (request, reply) => {
    const myId = await authUser(request, reply);
    if (!myId) return;

    const { channelId } = request.params as { channelId: string };
    const body = request.body as { friend_user_id?: unknown } | null;
    const friendUserId = typeof body?.friend_user_id === 'string' ? body.friend_user_id.trim() : '';
    if (!friendUserId) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'friend_user_id is required' } });
    }

    // Resolve channel → workroom (404 if missing).
    const channel = await db.controlChannel.findUnique({
      where: { id: channelId },
      select: { workroomId: true, archivedAt: true },
    });
    if (!channel || channel.archivedAt !== null) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    const workroomId = channel.workroomId;

    // PERMISSION: caller must OWN the workroom this channel belongs to.
    const ownerMembership = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: myId, workroomId } },
      select: { role: true },
    });
    if (!ownerMembership || ownerMembership.role !== 'owner') {
      return reply.code(403).send({ error: { code: 'NOT_WORKSPACE_OWNER', message: 'Only the workspace owner can add members' } });
    }

    // The added human must be an ACCEPTED friend of the caller.
    const pair = canonicalPair(myId, friendUserId);
    const friendship = await db.userFriendship.findUnique({
      where: { userId_friendId: pair },
      select: { status: true },
    });
    if (!friendship || friendship.status !== 'accepted') {
      return reply.code(403).send({ error: { code: 'NOT_FRIENDS', message: 'Target is not an accepted friend' } });
    }

    // Atomic: add the channel membership AND grant workroom access in ONE transaction,
    // so we never over-grant — if the channel-add fails/not-found the workroom 'member'
    // grant is rolled back (previously the grant happened first and leaked when the
    // channel-add then failed). Channel-add runs first; the membership grant only runs
    // after it succeeds; a throw in either aborts both.
    const result = await db.$transaction(async (tx) => {
      const r = await addMemberCore({
        workroomId,
        channelId,
        memberId: friendUserId,
        actorId: myId,
        db: tx,
      });
      if (r.notFound) return r; // channel gone → no membership grant, nothing to roll back
      // Grant workroom access (role 'member') if not already present.
      // Idempotent: P2002 on the @@unique([userId, workroomId]) means already a member.
      try {
        await tx.userWorkroomMembership.create({
          data: { userId: friendUserId, workroomId, role: 'member' },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
          throw err;
        }
      }
      return r;
    });
    if (result.notFound) {
      // Race: channel deleted between the lookup above and now.
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    broadcastChannelEvents(result.events);

    return reply.code(200).send({ ok: true });
  });
}
