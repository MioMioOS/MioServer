/**
 * agentApiAttachments — Fastify route plugin for agent-api attachment upload/view.
 *
 * Endpoints:
 *
 * POST /internal/agent-api/attachments
 *   Body (JSON, per-route bodyLimit: 12 MiB): { filename, mime_type, data_base64, target }
 *   - target (REQUIRED): #channel-name the agent belongs to. Anchors workroomId + membership scope.
 *   - mime_type must be in ALLOWED_MIME (reused from blobRoutes).
 *   - Decoded data_base64 must be ≤ 8 MiB.
 *   - Returns 201 { attachment_id }
 *
 * GET /internal/agent-api/attachments/:id
 *   - Load attachment by id. 404 if absent.
 *   - Membership check: agent must be a member of the attachment's channelId. 403 if not.
 *   - Returns 200 { filename, mime_type, size_bytes, data_base64 }
 *
 * Both endpoints require authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id).
 */

import type { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeAgentApi } from '@/control/agentApi/agentApiAuth';
import { resolveAgentChannelTarget } from '@/control/agentApi/agentApiTargets';
// Single source of truth for the image MIME allowlist (defined in blobRoutes.ts).
import { ALLOWED_MIME } from '@/blob/blobRoutes';

const MAX_DECODED_BYTES = 8 * 1024 * 1024;  // 8 MiB cap on the decoded image bytes
// Per-route request bodyLimit on the raw (base64) wire body. base64 inflates bytes by ~4/3,
// so 12 MiB of wire comfortably carries the ≤8 MiB decoded cap above. This OVERRIDES the
// 10 MiB global default in api.ts — a ~7.8 MiB image (~10.4 MiB base64) is above the global
// default but under this cap, so it must succeed.
const MAX_WIRE_BYTES = 12 * 1024 * 1024;

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentApiAttachments(app: FastifyInstance) {
  /**
   * POST /internal/agent-api/attachments
   *
   * Body: { filename, mime_type, data_base64, target }
   *
   * Per-route bodyLimit: 12 MiB. The global JSON parser (registered as 'string')
   * honors a route-level bodyLimit override, so this cap applies to the raw request body
   * (the base64 string is ~33% larger than the decoded data; 12 MiB allows ≤8 MiB decoded).
   *
   * Responses:
   *   201 { attachment_id }
   *   400 INVALID_BODY       — missing/empty required fields
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER       — resolveAgentChannelTarget: agent not a member
   *   409 AMBIGUOUS_CHANNEL
   *   413 PAYLOAD_TOO_LARGE  — decoded data > 8 MiB
   *   415 UNSUPPORTED_MIME   — mime_type not in allowlist
   */
  app.post('/internal/agent-api/attachments', {
    bodyLimit: MAX_WIRE_BYTES,
  }, async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as {
      filename?: unknown;
      mime_type?: unknown;
      data_base64?: unknown;
      target?: unknown;
    } | null;

    if (!body?.target || typeof body.target !== 'string' || body.target.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'target is required' } });
    }
    if (!body.filename || typeof body.filename !== 'string' || body.filename.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'filename is required' } });
    }
    if (!body.mime_type || typeof body.mime_type !== 'string' || body.mime_type.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'mime_type is required' } });
    }
    if (!body.data_base64 || typeof body.data_base64 !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'data_base64 is required' } });
    }

    const target = body.target;
    const filename = body.filename;
    const mimeType = body.mime_type;
    const dataBase64 = body.data_base64;

    // ── Step 3: validate MIME ─────────────────────────────────────────────────
    if (!ALLOWED_MIME.has(mimeType)) {
      return reply.code(415).send({ error: { code: 'UNSUPPORTED_MIME', message: `Unsupported mime type: ${mimeType}` } });
    }

    // ── Step 4: decode and check size ────────────────────────────────────────
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length > MAX_DECODED_BYTES) {
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Decoded data exceeds 8 MiB limit' } });
    }

    // ── Step 5: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(target, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    // ── Step 6: create attachment row ─────────────────────────────────────────
    const attachment = await db.controlAttachment.create({
      data: {
        workroomId,
        channelId,
        uploaderKind: 'agent',
        uploaderId: agent.id,
        filename,
        mimeType,
        sizeBytes: BigInt(buf.length),
        data: buf,
      },
    });

    return reply.code(201).send({ attachment_id: attachment.id });
  });

  /**
   * GET /internal/agent-api/attachments/:id
   *
   * Responses:
   *   200 { filename, mime_type, size_bytes, data_base64 }
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   403 FORBIDDEN          — agent not a member of the attachment's channel
   *   404 NOT_FOUND          — attachment not found
   */
  app.get('/internal/agent-api/attachments/:id', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: load attachment ───────────────────────────────────────────────
    const { id } = request.params as { id: string };

    const attachment = await db.controlAttachment.findUnique({
      where: { id },
      select: { data: true, channelId: true, filename: true, mimeType: true, sizeBytes: true },
    });

    if (!attachment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment not found' } });
    }

    // A ControlAttachment.data is a nullable Bytes? column, and GET reads ANY
    // attachment by id — including rows created by other writers that may have no
    // inline data. Guard before Buffer.from(null) (which would throw → 500). Treat a
    // data-less row as "not found" for this inline-bytes API.
    if (!attachment.data) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Attachment has no data' } });
    }

    // ── Step 3: membership check ──────────────────────────────────────────────
    // channelId is always set now (upload requires target), so we always check.
    const channelId = attachment.channelId;
    if (!channelId) {
      // Should not happen for attachments created via this API (target required).
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }

    const membership = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId, memberId: agent.id } },
    });
    if (!membership) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }

    // ── Step 4: return attachment data ────────────────────────────────────────
    // Prisma returns Bytes fields as Uint8Array. Convert explicitly to Buffer so
    // .toString('base64') uses Buffer's base64 encoding (not Uint8Array's default
    // comma-separated toString). This is required for correct bytes round-trip.
    const dataBuf = Buffer.from(attachment.data as Uint8Array);
    return reply.code(200).send({
      filename: attachment.filename,
      mime_type: attachment.mimeType,
      size_bytes: Number(attachment.sizeBytes),
      data_base64: dataBuf.toString('base64'),
    });
  });
}
