/**
 * agentApiThreads — Fastify route plugin for /internal/agent-api/* thread + message-by-id
 * routes used by the daemon (mio-agent).
 *
 * Endpoints:
 *   POST /internal/agent-api/threads/reply
 *       body: { parent_message_id, content, client_idempotency_key? }
 *       mirrors POST /api/v1/workrooms/:wid/threads/:parentId/reply.
 *
 *   GET  /internal/agent-api/threads/:parentId/replies?after_seq=&limit=
 *       mirrors GET /api/v1/workrooms/:wid/threads/:parentId/replies.
 *
 *   GET  /internal/agent-api/messages/:id
 *       mirrors GET /api/v1/messages/:id.
 *
 * Auth: authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id → real ControlAgent),
 * same as every other /internal/agent-api/* route. Sender attribution for replies is the
 * resolved acting agent (senderKind='agent', senderId=agent.id) — never "system".
 *
 * Membership / visibility:
 *   The workroom + channel are DERIVED from the parent message / message id (mirrors the
 *   user-side /api/v1/messages/:id semantics). Membership is membership-anchored on the
 *   agent: the agent must have a ControlChannelMember row for the parent's channel.
 *   If absent → 404 NOT_A_MEMBER (uniform 404 — does not reveal whether the message
 *   exists; matches the anti-enumeration posture used elsewhere in agent-api).
 *
 * Wire shape:
 *   Reply/read responses use formatMessage + resolveAttachedTasks so each message carries
 *   `attached_task` + `reply_count` — the same recently-updated wire shape that the user
 *   routes return (single source of truth for the iOS / daemon clients).
 */

import type { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeAgentApi } from './agentApiAuth';
import { resolveAgentChannelTarget } from './agentApiTargets';
import { sendMessageTransaction } from '@/control/messages/sendMessageTransaction';
import { writeThreadReplyEventAndBroadcast } from '@/control/messages/writeThreadReplyEventAndBroadcast';
import {
  resolveSenderDisplayNames,
  formatMessage,
  resolveAttachedTasks,
} from '@/control/messages/messageFormatting';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;

/**
 * Membership check: the agent must be a ControlChannelMember of `channelId`.
 * Returns true on member, false otherwise. Used by every handler in this file to gate
 * access to messages in a derived (parent-message-id / message-id) channel.
 *
 * Unlike the user routes' "public channel auto-visible" semantic, the agent-api keeps
 * the existing membership-anchored design (see agentApiChannels.ts §16-21): PUBLIC ≠
 * auto-member for an agent. The agent must have an explicit membership row.
 */
async function isAgentMemberOfChannel(agentId: string, channelId: string): Promise<boolean> {
  const row = await db.controlChannelMember.findUnique({
    where: { channelId_memberId: { channelId, memberId: agentId } },
    select: { memberId: true },
  });
  return !!row;
}

async function resolveParentMessageForReply(input: {
  rawParentId: string;
  target: string | null;
  agentId: string;
}): Promise<{ id: string; channelId: string; workroomId: string } | null> {
  if (UUID_RE.test(input.rawParentId)) {
    return db.controlMessage.findUnique({
      where: { id: input.rawParentId },
      select: { id: true, channelId: true, workroomId: true },
    });
  }

  if (!SHORT_ID_RE.test(input.rawParentId) || !input.target) return null;

  const resolved = await resolveAgentChannelTarget(input.target, input.agentId);
  if (!resolved.ok) return null;

  const matches = await db.$queryRaw<
    Array<{ id: string; channel_id: string; workroom_id: string }>
  >`
    SELECT id::text, channel_id::text, workroom_id::text
    FROM control_messages
    WHERE channel_id = ${resolved.channelId}::uuid
      AND replace(id::text, '-', '') LIKE ${input.rawParentId.toLowerCase() + '%'}
    LIMIT 2
  `;
  if (matches.length !== 1) return null;
  const row = matches[0]!;
  return { id: row.id, channelId: row.channel_id, workroomId: row.workroom_id };
}

/**
 * Re-fetch a written message by id and shape it into the full wire format
 * (formatMessage + attached_task). Mirrors the user-route fetchFormattedMessage helper.
 */
async function fetchFormattedMessage(id: string) {
  const row = await db.controlMessage.findUnique({
    where: { id },
    select: {
      id: true,
      seq: true,
      senderKind: true,
      senderId: true,
      content: true,
      mentions: true,
      attachmentIds: true,
      embeddedCardType: true,
      embeddedCardId: true,
      threadReplyCount: true,
      createdAt: true,
      channelId: true,
      parentMessageId: true,
    },
  });
  if (!row) return null;
  const names = await resolveSenderDisplayNames([
    { senderId: row.senderId, senderKind: row.senderKind },
  ]);
  const attached = await resolveAttachedTasks([row.id]);
  return formatMessage(row, names, { attachedTask: attached.get(row.id) ?? null });
}

export async function agentApiThreads(app: FastifyInstance) {
  /**
   * POST /internal/agent-api/threads/reply
   *
   * Body:
   *   parent_message_id        — uuid of the parent message (required)
   *   content                  — reply text (required)
   *   client_idempotency_key?  — optional; null → no unique collision (machine semantics)
   *
   * Responses:
   *   201 { ...formattedMessage, idempotent }
   *   400 INVALID_BODY
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 THREAD_NOT_FOUND       — parent missing
   *   404 NOT_A_MEMBER           — agent not a member of the parent's channel
   *   500 INTERNAL_ERROR
   */
  app.post('/internal/agent-api/threads/reply', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply
        .code(auth.status)
        .send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const body = request.body as {
      parent_message_id?: unknown;
      target?: unknown;
      content?: unknown;
      client_idempotency_key?: unknown;
      attachment_ids?: unknown;
    } | null;

    if (!body?.parent_message_id || typeof body.parent_message_id !== 'string') {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_BODY', message: 'parent_message_id is required' } });
    }
    if (!body.content || typeof body.content !== 'string') {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
    }

    const rawParentId = body.parent_message_id;
    const target = typeof body.target === 'string' ? body.target : null;
    const content = body.content;
    const clientIdempotencyKey =
      typeof body.client_idempotency_key === 'string' ? body.client_idempotency_key : null;
    // Attachments: a thread reply may carry attachment ids (e.g. an agent posting
    // an image with `mio message reply --attachment <id>`). Previously dropped here,
    // leaving the file uploaded-but-invisible — the reply was stored with empty
    // attachment_ids. Parse + forward to the transaction (mirrors the send path).
    const attachmentIds = Array.isArray(body.attachment_ids)
      ? body.attachment_ids.filter((x): x is string => typeof x === 'string')
      : undefined;

    // Load parent → derive workroomId + channelId. Malformed uuid → P2023 caught as 404.
    let parent: { id: string; channelId: string; workroomId: string } | null = null;
    try {
      parent = await resolveParentMessageForReply({
        rawParentId,
        target,
        agentId: agent.id,
      });
    } catch {
      return reply
        .code(404)
        .send({ error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } });
    }
    if (!parent) {
      return reply
        .code(404)
        .send({ error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } });
    }

    // Membership-anchored check on the agent (anti-enumeration: 404 not 403).
    if (!(await isAgentMemberOfChannel(agent.id, parent.channelId))) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_A_MEMBER', message: 'Agent is not a member of this channel' } });
    }

    const result = await sendMessageTransaction({
      channelId: parent.channelId,
      workroomId: parent.workroomId,
      senderKind: 'agent',
      senderId: agent.id,
      content,
      clientIdempotencyKey,
      parentMessageId: parent.id,
      ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
    });

    if (!result.ok) {
      if (result.code === 'CHANNEL_NOT_FOUND') {
        return reply
          .code(404)
          .send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
      }
      if (result.code === 'CHANNEL_FORBIDDEN') {
        // Should be unreachable since we just verified ControlChannelMember above, but
        // keep the branch so a future visibility-rule change can't silently 500.
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
      return reply
        .code(500)
        .send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    }

    await writeThreadReplyEventAndBroadcast({
      workroomId: parent.workroomId,
      channelId: parent.channelId,
      parentMessageId: parent.id,
      messageId: result.id,
      seq: result.seq,
      senderKind: 'agent',
      senderId: agent.id,
      content,
      idempotent: result.idempotent,
    });

    return reply.code(201).send({
      ...(await fetchFormattedMessage(result.id))!,
      idempotent: result.idempotent,
    });
  });

  /**
   * GET /internal/agent-api/threads/:parentId/replies?after_seq=&limit=
   *
   * Responses:
   *   200 { parent_message_id, messages: [...], has_more }
   *   400 INVALID_AFTER_SEQ
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 THREAD_NOT_FOUND
   *   404 NOT_A_MEMBER
   */
  app.get('/internal/agent-api/threads/:parentId/replies', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply
        .code(auth.status)
        .send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const { parentId } = request.params as { parentId: string };
    const query = request.query as { after_seq?: string; limit?: string };

    let afterSeq = 0n;
    if (query.after_seq !== undefined) {
      if (!/^\d+$/.test(query.after_seq)) {
        return reply.code(400).send({
          error: { code: 'INVALID_AFTER_SEQ', message: 'after_seq must be a non-negative integer' },
        });
      }
      afterSeq = BigInt(query.after_seq);
    }

    const requestedLimit = query.limit !== undefined
      ? Math.min(Math.max(1, parseInt(query.limit, 10) || 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    // Load parent → derive channelId. Malformed uuid → uniform 404.
    let parent: { id: string; channelId: string; workroomId: string } | null = null;
    try {
      parent = await db.controlMessage.findUnique({
        where: { id: parentId },
        select: { id: true, channelId: true, workroomId: true },
      });
    } catch {
      return reply
        .code(404)
        .send({ error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } });
    }
    if (!parent) {
      return reply
        .code(404)
        .send({ error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } });
    }

    if (!(await isAgentMemberOfChannel(agent.id, parent.channelId))) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_A_MEMBER', message: 'Agent is not a member of this channel' } });
    }

    const rows = await db.controlMessage.findMany({
      where: { parentMessageId: parentId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: requestedLimit + 1,
      select: {
        id: true,
        seq: true,
        senderKind: true,
        senderId: true,
        content: true,
        mentions: true,
        attachmentIds: true,
        embeddedCardType: true,
        embeddedCardId: true,
        threadReplyCount: true,
        createdAt: true,
        channelId: true,
        parentMessageId: true,
      },
    });
    const hasMore = rows.length > requestedLimit;
    const page = rows.slice(0, requestedLimit);

    const senderNames = await resolveSenderDisplayNames(
      page.map((m) => ({ senderId: m.senderId, senderKind: m.senderKind })),
    );
    const attachedByMsg = await resolveAttachedTasks(page.map((m) => m.id));

    return reply.code(200).send({
      parent_message_id: parentId,
      messages: page.map((m) =>
        formatMessage(m, senderNames, { attachedTask: attachedByMsg.get(m.id) ?? null }),
      ),
      has_more: hasMore,
    });
  });

  /**
   * GET /internal/agent-api/messages/:id
   *
   * Responses:
   *   200 { ...formattedMessage, channel_id }
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 MESSAGE_NOT_FOUND     — missing message OR agent not a member of its channel
   */
  app.get('/internal/agent-api/messages/:id', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply
        .code(auth.status)
        .send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const { id } = request.params as { id: string };

    let msg: Awaited<ReturnType<typeof db.controlMessage.findUnique>> = null;
    try {
      msg = await db.controlMessage.findUnique({ where: { id } });
    } catch {
      return reply
        .code(404)
        .send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }
    if (!msg) {
      return reply
        .code(404)
        .send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    // Anti-enumeration: non-member → 404 (NOT 403), mirroring user-side /messages/:id.
    if (!(await isAgentMemberOfChannel(agent.id, msg.channelId))) {
      return reply
        .code(404)
        .send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    const senderNames = await resolveSenderDisplayNames([
      { senderId: msg.senderId, senderKind: msg.senderKind },
    ]);
    const attachedByMsg = await resolveAttachedTasks([msg.id]);

    return reply.code(200).send({
      ...formatMessage(msg, senderNames, { attachedTask: attachedByMsg.get(msg.id) ?? null }),
      channel_id: msg.channelId,
    });
  });
}
