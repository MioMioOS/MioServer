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
// Single source of truth for the image MIME allowlist (defined in blobRoutes.ts).
import { isAllowedAttachmentMime } from '@/blob/blobRoutes';
import { cosEnabled, cosKeyFor, presignPut, presignGet, cosHead } from '@/blob/cosStorage';

const MAX_DECODED_BYTES = 8 * 1024 * 1024;   // same caps as the agent-api upload route
const MAX_WIRE_BYTES = 12 * 1024 * 1024;

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
    let attachment: { data: Uint8Array | null; storageKey: string | null; workroomId: string; filename: string; mimeType: string } | null = null;
    try {
      attachment = await db.controlAttachment.findUnique({
        where: { id },
        select: { data: true, storageKey: true, workroomId: true, filename: true, mimeType: true },
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

    // COS-backed rows (storageKey set, no inline bytes) → 302 to a presigned
    // GET; the client streams straight from COS, server bandwidth untouched.
    if (!attachment.data && attachment.storageKey && cosEnabled()) {
      const url = await presignGet(attachment.storageKey);
      return reply.code(302).header('Location', url).send();
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

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/attachments — human upload.
   *
   * Body (JSON, per-route bodyLimit 12 MiB): { filename, mime_type, data_base64 }
   * Mirrors the agent-api upload caps (ALLOWED_MIME, ≤8 MiB decoded). user_sess_
   * only — machines have /internal/agent-api/attachments. Private channels
   * require the caller to be a channel member (same guest scoping as reads).
   *
   * Responses:
   *   201 { attachment_id, filename, mime_type, size_bytes }
   *   400 INVALID_BODY · 401 · 403 FORBIDDEN · 404 (workroom/channel, uniform)
   *   413 PAYLOAD_TOO_LARGE · 415 UNSUPPORTED_MIME
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/attachments', {
    bodyLimit: MAX_WIRE_BYTES,
  }, async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    // ── Step 1: user_sess_ membership auth (no machine path for this route) ──
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith(`Bearer ${USER_SESSION_TOKEN_PREFIX}`)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
    }
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId: wid } },
    });
    if (!mem) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }

    // ── Step 2: channel guard (workroom scope + private-channel membership) ──
    let channel: { id: string; workroomId: string; visibility: string } | null = null;
    try {
      channel = await db.controlChannel.findUnique({
        where: { id: cid },
        select: { id: true, workroomId: true, visibility: true },
      });
    } catch {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    if (!channel || channel.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    if (channel.visibility === 'private') {
      const cm = await db.controlChannelMember.findUnique({
        where: { channelId_memberId: { channelId: cid, memberId: session.userId } },
      });
      if (!cm) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
    }

    // ── Step 3: body validation (same shape/caps as agent-api upload) ────────
    const body = request.body as { filename?: unknown; mime_type?: unknown; data_base64?: unknown } | null;
    if (!body?.filename || typeof body.filename !== 'string' || body.filename.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'filename is required' } });
    }
    if (!body.mime_type || typeof body.mime_type !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'mime_type is required' } });
    }
    if (!body.data_base64 || typeof body.data_base64 !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'data_base64 is required' } });
    }
    if (!isAllowedAttachmentMime(body.mime_type)) {
      return reply.code(415).send({ error: { code: 'UNSUPPORTED_MIME', message: `Unsupported mime type: ${body.mime_type}` } });
    }
    const buf = Buffer.from(body.data_base64, 'base64');
    if (buf.length === 0) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'data_base64 decoded to zero bytes' } });
    }
    if (buf.length > MAX_DECODED_BYTES) {
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Decoded data exceeds 8 MiB limit' } });
    }

    // ── Step 4: create row ────────────────────────────────────────────────────
    const attachment = await db.controlAttachment.create({
      data: {
        workroomId: wid,
        channelId: cid,
        uploaderKind: 'user',
        uploaderId: session.userId,
        filename: body.filename,
        mimeType: body.mime_type,
        sizeBytes: BigInt(buf.length),
        data: buf,
      },
    });

    return reply.code(201).send({
      attachment_id: attachment.id,
      filename: body.filename,
      mime_type: body.mime_type,
      size_bytes: buf.length,
    });
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/attachments/presign — COS 直传第一步。
   *
   * Body: { filename, mime_type, size_bytes }
   * 鉴权/频道守卫与上传路由一致。COS 未启用时 404(客户端回退 base64 旧路)。
   * 建 pending 行(storageKey 就位、data 空)→ 返回 10 分钟预签名 PUT URL。
   * 直传上限 60 MiB(直连 COS,不再受服务器带宽/body 限制约束)。
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/attachments/presign', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };
    if (!cosEnabled()) {
      return reply.code(404).send({ error: { code: 'COS_DISABLED', message: 'Direct upload not configured' } });
    }
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith(`Bearer ${USER_SESSION_TOKEN_PREFIX}`)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
    }
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId: wid } },
    });
    if (!mem) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    let channel: { id: string; workroomId: string; visibility: string } | null = null;
    try {
      channel = await db.controlChannel.findUnique({
        where: { id: cid }, select: { id: true, workroomId: true, visibility: true },
      });
    } catch { channel = null; }
    if (!channel || channel.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }
    if (channel.visibility === 'private') {
      const cm = await db.controlChannelMember.findUnique({
        where: { channelId_memberId: { channelId: cid, memberId: session.userId } },
      });
      if (!cm) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }
    const body = request.body as { filename?: unknown; mime_type?: unknown; size_bytes?: unknown } | null;
    if (!body?.filename || typeof body.filename !== 'string' || body.filename.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'filename is required' } });
    }
    if (!isAllowedAttachmentMime(body.mime_type)) {
      return reply.code(415).send({ error: { code: 'UNSUPPORTED_MIME', message: `Unsupported mime type: ${String(body.mime_type)}` } });
    }
    const size = Number(body.size_bytes);
    if (!Number.isFinite(size) || size <= 0) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'size_bytes is required' } });
    }
    if (size > 60 * 1024 * 1024) {
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Direct upload exceeds 60 MiB limit' } });
    }
    const attachment = await db.controlAttachment.create({
      data: {
        workroomId: wid, channelId: cid,
        uploaderKind: 'user', uploaderId: session.userId,
        filename: body.filename, mimeType: body.mime_type,
        sizeBytes: BigInt(size),
        // pending: storageKey set below (needs id), data stays null
      },
    });
    const key = cosKeyFor(wid, attachment.id, body.filename);
    await db.controlAttachment.update({ where: { id: attachment.id }, data: { storageKey: key } });
    const putUrl = await presignPut(key);
    return reply.code(201).send({ attachment_id: attachment.id, put_url: putUrl });
  });

  /**
   * POST /api/v1/workrooms/:wid/attachments/:id/complete — COS 直传第二步。
   * HEAD 校验对象已真实存在,回填 sizeBytes(以 COS 为准)。
   */
  app.post('/api/v1/workrooms/:wid/attachments/:id/complete', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };
    const guard = await resolveAttachmentReadActor(request, wid);
    if (!guard.ok) {
      return reply.code(guard.status).send({ error: { code: guard.code, message: guard.message } });
    }
    let att: { workroomId: string; storageKey: string | null } | null = null;
    try {
      att = await db.controlAttachment.findUnique({ where: { id }, select: { workroomId: true, storageKey: true } });
    } catch { att = null; }
    if (!att || att.workroomId !== wid || !att.storageKey) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment not found' } });
    }
    const head = cosEnabled() ? await cosHead(att.storageKey) : null;
    if (!head) {
      return reply.code(409).send({ error: { code: 'NOT_UPLOADED', message: 'Object not found in storage' } });
    }
    await db.controlAttachment.update({ where: { id }, data: { sizeBytes: BigInt(head.size) } });
    return reply.send({ ok: true, size_bytes: head.size });
  });
}
