/**
 * R2.4 — workspace membership lifecycle (phone-side, user_sess_ authed).
 *
 * CORRECTED MODEL: a "workspace" == one ControlWorkroom, created computer-side at machine
 * enrollment (see machineEnrollmentRoutes.ts). These routes let the phone owner LEAVE a
 * workspace, and REVOKE a machine they own so its daemon disconnects.
 *
 * Endpoints:
 *   DELETE /v1/users/me/workrooms/:workroomId   (Bearer user_sess_)
 *     → drop the CURRENT user's UserWorkroomMembership for that workroom. If that leaves the
 *       workroom with NO remaining owner members, ARCHIVE it (set archivedAt) rather than
 *       cascade-delete (the workroom has many child tables whose FKs are NO ACTION — a delete
 *       would error and is not the intended semantics). Idempotent-ish: re-leaving a workroom
 *       you're no longer in → 404.
 *
 *   POST /api/v1/machines/:id/revoke            (Bearer user_sess_)
 *     → revoke a ControlMachine the caller owns. There is no direct user→machine FK; ownership
 *       is derived: the caller must be an OWNER member of at least one workroom in the machine's
 *       org. Revoke = expire the machine_token: rotate tokenHash to an unusable random value AND
 *       set tokenExpiresAt to the past, so verifyMachineToken() rejects it immediately and the
 *       daemon disconnects on its next call / refresh. (tokenHash is non-nullable in the schema,
 *       so we cannot null it; expiring + scrambling is the equivalent kill.)
 *
 * Auth: resolveUserSession on the raw Authorization header (the user_sess_ convention shared with
 * /v1/users/me and the workroom GET). No machine-token path here — these are phone-owner actions.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';

function unauth(reply: import('fastify').FastifyReply) {
  return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
}

async function resolveSession(req: FastifyRequest) {
  return resolveUserSession(req.headers.authorization);
}

export const workspaceMembershipRoutes: FastifyPluginAsync = async (app) => {
  /**
   * DELETE /v1/users/me/workrooms/:workroomId
   *
   * Responses:
   *   200 { workroom_id, left: true, archived: boolean }
   *   401 INVALID_SESSION
   *   404 NOT_A_MEMBER       — caller has no membership in this workroom (already left / never joined)
   */
  app.delete('/v1/users/me/workrooms/:workroomId', async (req, reply) => {
    const session = await resolveSession(req);
    if (!session) return unauth(reply);

    const { workroomId } = req.params as { workroomId: string };
    const userId = session.userId;

    const result = await db.$transaction(async (tx) => {
      const membership = await tx.userWorkroomMembership.findUnique({
        where: { userId_workroomId: { userId, workroomId } },
      });
      if (!membership) return { ok: false as const };

      await tx.userWorkroomMembership.delete({
        where: { userId_workroomId: { userId, workroomId } },
      });

      // Repoint the user's default workspace if it pointed at the one just left
      // (else GET /me / the client would surface a workroom the user no longer belongs to).
      const me = await tx.user.findUnique({ where: { id: userId }, select: { defaultWorkroomId: true } });
      if (me?.defaultWorkroomId === workroomId) {
        const next = await tx.userWorkroomMembership.findFirst({
          where: { userId },
          select: { workroomId: true },
          orderBy: { createdAt: 'asc' },
        });
        await tx.user.update({ where: { id: userId }, data: { defaultWorkroomId: next?.workroomId ?? null } });
      }

      // Archive ONLY when NO members of ANY role remain (truly empty). Counting just owners
      // would archive a SHARED workroom out from under invited 'member's (R4) — silently
      // locking them out of a room they still belong to. An owner-less but non-empty workroom
      // keeps members' access (ownership transfer is future work). No cascade delete.
      const remaining = await tx.userWorkroomMembership.count({ where: { workroomId } });
      let archived = false;
      if (remaining === 0) {
        const workroom = await tx.controlWorkroom.findUnique({
          where: { id: workroomId },
          select: { archivedAt: true },
        });
        if (workroom && workroom.archivedAt === null) {
          await tx.controlWorkroom.update({
            where: { id: workroomId },
            data: { archivedAt: new Date() },
          });
          archived = true;
        }
      }
      return { ok: true as const, archived };
    });

    if (!result.ok) {
      return reply.code(404).send({ error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this workspace' } });
    }
    return reply.code(200).send({ workroom_id: workroomId, left: true, archived: result.archived });
  });

  /**
   * POST /api/v1/machines/:id/revoke
   *
   * Responses:
   *   200 { machine_id, revoked: true }
   *   401 INVALID_SESSION
   *   403 FORBIDDEN         — caller does not own this machine (no owner membership in its org)
   *   404 MACHINE_NOT_FOUND
   */
  app.post('/api/v1/machines/:id/revoke', async (req, reply) => {
    const session = await resolveSession(req);
    if (!session) return unauth(reply);

    const { id } = req.params as { id: string };
    const userId = session.userId;

    const machine = await db.controlMachine.findUnique({
      where: { id },
      select: { id: true, orgId: true },
    });
    if (!machine) {
      return reply.code(404).send({ error: { code: 'MACHINE_NOT_FOUND', message: 'Machine not found' } });
    }

    // Ownership: caller must be an OWNER member of at least one workroom in this machine's org.
    // (No direct user→machine FK exists; org-scoped owner membership is the ownership proxy.)
    // UserWorkroomMembership has no Prisma relation to ControlWorkroom (workroomId is a bare
    // @db.Uuid column), so we resolve the org's workroom ids first, then check membership.
    if (!machine.orgId) {
      // Unbound machine has no org → nobody can claim ownership through a workroom. Deny.
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'You do not own this machine' } });
    }
    const orgWorkrooms = await db.controlWorkroom.findMany({
      where: { orgId: machine.orgId },
      select: { id: true },
    });
    const orgWorkroomIds = orgWorkrooms.map((w) => w.id);
    const ownsViaWorkroom =
      orgWorkroomIds.length === 0
        ? null
        : await db.userWorkroomMembership.findFirst({
            where: { userId, role: 'owner', workroomId: { in: orgWorkroomIds } },
            select: { id: true },
          });
    if (!ownsViaWorkroom) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'You do not own this machine' } });
    }

    // Revoke: scramble the token hash to an unusable value AND expire it. tokenHash is
    // non-nullable, so the kill is "rotate to a hash of fresh random bytes nobody holds" +
    // "tokenExpiresAt in the past". verifyMachineToken() filters on tokenExpiresAt > now, so
    // the daemon's next call fails auth → it disconnects.
    const deadHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    await db.controlMachine.update({
      where: { id },
      data: { tokenHash: deadHash, tokenExpiresAt: new Date(0) },
    });

    return reply.code(200).send({ machine_id: id, revoked: true });
  });
};
