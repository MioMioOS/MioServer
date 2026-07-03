/**
 * Human members API — invite / list / remove real-person members of a workroom.
 *
 * Before this module there was NO route that could create a UserWorkroomMembership
 * for a second human: memberships were only minted at machine enrollment (owner)
 * and pairing takeover. A friend's account therefore could never read or write
 * anything in someone else's workspace. These routes close that gap.
 *
 * Endpoints (all under the SEPARATE `human-members` segment — the existing
 * GET /workrooms/:wid/members contract returns ControlAgent rows only and is
 * consumed by shipped iOS builds; mixing kind:'user' rows into it would break
 * old clients, so humans get their own collection):
 *
 *   GET    /api/v1/workrooms/:wid/human-members            (any member)
 *   POST   /api/v1/workrooms/:wid/human-members            (owner) { email } → add as role 'member'
 *   DELETE /api/v1/workrooms/:wid/human-members/:userId    (owner) → remove a 'member' row
 *
 * Rules:
 *   - Invite is by EXACT registered email (normalized lowercase, same as signin).
 *     Unknown email → 404 USER_NOT_FOUND (invitee must register first; the app
 *     surfaces the invite code flow separately).
 *   - Already a member → 409 ALREADY_MEMBER.
 *   - Owners cannot be removed via this route (CANNOT_REMOVE_OWNER) — ownership
 *     transfer is out of scope here, and it keeps "last owner" invariants trivial.
 *   - role is always 'member' on invite. Member rights today: read + send
 *     messages + WS subscribe (+ everything gated on plain membership). Channel
 *     and task admin writes stay owner-only via requireUserWrite.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { onlineUserIds } from '@/control/ws/userPresence';
import { db } from '@/storage/db';
import { requireUser } from '@/auth/userSession/requireUser';
import { generateIdenticon } from '@/control/profile/identicon';

/** Avatar is derived, not stored (mirrors /v1/users/me): identicon of displayName||email. */
function avatarFor(displayName: string | null, email: string): string {
  return generateIdenticon(displayName || email);
}

const WID_LOC = { workroomIdFrom: 'param' as const, paramName: 'wid' };

function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.userWorkroomRole !== 'owner') {
    void reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Owner role required' } });
    return false;
  }
  return true;
}

export async function humanMemberRoutes(app: FastifyInstance) {
  // ── list ──────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/workrooms/:wid/human-members',
    { preHandler: requireUser(WID_LOC) },
    async (request) => {
      const { wid } = request.params as { wid: string };
      const memberships = await db.userWorkroomMembership.findMany({
        where: { workroomId: wid },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, email: true, displayName: true, lastSeenAt: true } } },
      });
      const online = onlineUserIds(wid);
      return {
        human_members: memberships.map((m) => ({
          user_id: m.user.id,
          online: online.has(m.user.id),
          last_seen_at: m.user.lastSeenAt ? m.user.lastSeenAt.toISOString() : null,
          email: m.user.email,
          display_name: m.user.displayName,
          avatar: avatarFor(m.user.displayName, m.user.email),
          role: m.role,
          joined_at: m.createdAt.toISOString(),
        })),
      };
    },
  );

  // ── invite ────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/workrooms/:wid/human-members',
    { preHandler: requireUser(WID_LOC) },
    async (request, reply) => {
      if (!requireOwner(request, reply)) return;
      const { wid } = request.params as { wid: string };
      const body = request.body as { email?: unknown } | null;
      if (!body || typeof body.email !== 'string' || body.email.trim().length === 0) {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'email required' } });
      }
      const email = body.email.trim().toLowerCase();

      const invitee = await db.user.findUnique({
        where: { email },
        select: { id: true, email: true, displayName: true },
      });
      if (!invitee) {
        return reply.code(404).send({
          error: { code: 'USER_NOT_FOUND', message: 'No account registered with that email' },
        });
      }

      const existing = await db.userWorkroomMembership.findUnique({
        where: { userId_workroomId: { userId: invitee.id, workroomId: wid } },
      });
      if (existing) {
        return reply.code(409).send({ error: { code: 'ALREADY_MEMBER', message: 'Already a member' } });
      }

      const created = await db.userWorkroomMembership.create({
        data: { userId: invitee.id, workroomId: wid, role: 'member' },
      });

      return reply.code(201).send({
        human_member: {
          user_id: invitee.id,
          email: invitee.email,
          display_name: invitee.displayName,
          avatar: avatarFor(invitee.displayName, invitee.email),
          role: created.role,
          joined_at: created.createdAt.toISOString(),
        },
      });
    },
  );

  // ── remove ────────────────────────────────────────────────────────────────
  app.delete(
    '/api/v1/workrooms/:wid/human-members/:userId',
    { preHandler: requireUser(WID_LOC) },
    async (request, reply) => {
      if (!requireOwner(request, reply)) return;
      const { wid, userId } = request.params as { wid: string; userId: string };

      const target = await db.userWorkroomMembership.findUnique({
        where: { userId_workroomId: { userId, workroomId: wid } },
      });
      if (!target) {
        return reply.code(404).send({ error: { code: 'MEMBER_NOT_FOUND', message: 'Not a member' } });
      }
      if (target.role === 'owner') {
        return reply.code(403).send({
          error: { code: 'CANNOT_REMOVE_OWNER', message: 'Owners cannot be removed' },
        });
      }

      await db.userWorkroomMembership.delete({ where: { id: target.id } });
      return { ok: true };
    },
  );
}
