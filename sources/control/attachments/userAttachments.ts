/**
 * userAttachments — Fastify route plugin for user-auth attachment bytes.
 *
 * Endpoint:
 *
 * GET /api/v1/workrooms/:wid/attachments/:id/blob
 *   - Auth: user_sess_ (workroom MEMBER) OR machine_token (org-scoped to workroom).
 *     Mirrors the read-side auth in messageRoutes.ts (resolveMessageReadActor pattern).
 *   - Loads ControlAttachment by id. 404 if absent or .data is null.
 *   - Cross-workroom guard: attachment.workroomId must equal :wid. 404 otherwise
 *     (anti-enumeration uniform 404 — never reveal cross-workroom existence).
 *   - Returns the binary bytes with Content-Type: <mime> and
 *     Content-Disposition: inline; filename="…". NOT base64-encoded — iOS
 *     AsyncImage and WKWebView consume binary URLs directly.
 *
 * Sibling of agentApiAttachments.ts (which is machine-token-gated). Kept in a
 * separate plugin so both can register without route collisions.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { verifyMachineToken } from '@/machines/machineRoutes';

/**
 * Resolve a workroom-scoped read actor (user_sess_ MEMBER or machine_token with
 * org access). Mirrors resolveMessageReadActor in messageRoutes.ts but inlined
 * here so we keep the file self-contained.
 */
type ReadResult =
  | { ok: true; viewerId: string; kind: 'user' | 'machine' }
  | { ok: false; status: number; code: string; message: string };

async function resolveAttachmentReadActor(
  req: FastifyRequest,
  workroomId: string,
): Promise<ReadResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
  }
  const token = authHeader.slice(7);

  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'Invalid or expired session' };
    }
    const wr = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { id: true } });
    if (!wr) {
      return { ok: false, status: 404, code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' };
    }
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId } },
    });
    if (!mem) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
    }
    return { ok: true, viewerId: session.userId, kind: 'user' };
  }

  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) {
    return { ok: false, status: access.status, code: access.error.code, message: access.error.message };
  }
  return { ok: true, viewerId: machine.id, kind: 'machine' };
}

export async function userAttachments(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/attachments/:id/blob
   *
   * Responses:
   *   200  binary body, Content-Type: <mime>, Content-Disposition: inline; filename="…"
   *   401  UNAUTHORIZED / INVALID_SESSION
   *   403  FORBIDDEN  — user not a member of the workroom
   *   404  WORKROOM_NOT_FOUND / NOT_FOUND  — uniform anti-enumeration shape
   */
  app.get('/api/v1/workrooms/:wid/attachments/:id/blob', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    // ── Step 1: workroom-scoped auth ─────────────────────────────────────────
    const guard = await resolveAttachmentReadActor(request, wid);
    if (!guard.ok) {
      return reply.code(guard.status).send({ error: { code: guard.code, message: guard.message } });
    }

    // ── Step 2: load attachment ──────────────────────────────────────────────
    let attachment: { data: Uint8Array | null; workroomId: string; filename: string; mimeType: string } | null = null;
    try {
      attachment = await db.controlAttachment.findUnique({
        where: { id },
        select: { data: true, workroomId: true, filename: true, mimeType: true },
      });
    } catch {
      // Malformed uuid → P2023 → uniform 404
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment not found' } });
    }
    if (!attachment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment not found' } });
    }

    // Cross-workroom guard — anti-enumeration uniform 404.
    if (attachment.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment not found' } });
    }

    // .data is a nullable Bytes column; rows without inline bytes can't serve binary.
    if (!attachment.data) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment has no data' } });
    }

    // ── Step 3: send binary ──────────────────────────────────────────────────
    const buf = Buffer.from(attachment.data as Uint8Array);
    // Escape any quotes/backslashes in the filename so the header stays valid.
    const safeFilename = attachment.filename.replace(/["\\]/g, '_');
    return reply
      .code(200)
      .header('Content-Type', attachment.mimeType)
      .header('Content-Disposition', `inline; filename="${safeFilename}"`)
      .header('Content-Length', String(buf.length))
      .send(buf);
  });
}
