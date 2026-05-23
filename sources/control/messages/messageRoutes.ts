/**
 * Message API — control plane (S1 Chunk 3, READ-ONLY)
 *
 * Endpoints (read; write is Chunk 4):
 *   GET /api/v1/workrooms/:wid/channels/:cid/messages?after_seq=<n>&limit=<=100
 *     Returns seq-ascending page of messages in a channel.
 *     Private channel non-member → 404 (uniform, anti-enumeration).
 *
 *   GET /api/v1/messages/:id
 *     Returns a single message by id (for thread parent / deep links).
 *     Private channel non-member → 404 (uniform, anti-enumeration).
 *
 * Auth: dual-read via authorizeControlRead (machine_token OR dev_control_token).
 *       machine mode: also enforces org/workroom access via requireMachineAccessToWorkroom.
 *       dev mode: authorizeControlRead already enforced allowlist + workroom scope.
 *
 * Pagination: after_seq is an EXCLUSIVE lower bound (seq > after_seq). Absent → most recent limit rows.
 * limit: capped at MAX_PAGE_SIZE (100). Default MAX_PAGE_SIZE.
 *
 * Spec: §4.2 (list) + §4.4 (single).
 */

import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { visibleChannels } from '@/control/channels/channelVisibility';

const MAX_PAGE_SIZE = 100;

/**
 * Resolve sender display names in a batch (no N+1).
 * For `agent` senderKind: look up ControlAgent.displayName / name.
 * For `user` or `system` senderKind: no agent row; return null (client renders kind as label).
 *
 * Returns a map from senderId → display name string.
 * Missing or unresolvable senders → absent from map (caller converts to null).
 */
async function resolveSenderDisplayNames(
  senders: Array<{ senderId: string; senderKind: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const agentIds = [
    ...new Set(
      senders
        .filter((s) => s.senderKind === 'agent')
        .map((s) => s.senderId),
    ),
  ];
  if (agentIds.length === 0) return result;

  const agents = await db.controlAgent.findMany({
    where: { id: { in: agentIds } },
    select: { id: true, displayName: true, name: true },
  });

  for (const a of agents) {
    const label = a.displayName?.trim() || a.name?.trim();
    if (label) result.set(a.id, label);
  }
  return result;
}

/**
 * Format a ControlMessage row as the wire shape (§4.2).
 * sender_display_name: resolved for agents; null for user/system.
 */
function formatMessage(
  msg: {
    id: string;
    seq: bigint;
    senderKind: string;
    senderId: string;
    content: string;
    mentions: string[];
    embeddedCardType: string | null;
    embeddedCardId: string | null;
    threadReplyCount: number;
    createdAt: Date;
    channelId: string | null;
  },
  senderNames: Map<string, string>,
) {
  return {
    id: msg.id,
    seq: msg.seq.toString(),
    sender_kind: msg.senderKind,
    sender_id: msg.senderId,
    sender_display_name: senderNames.get(msg.senderId) ?? null,
    content: msg.content,
    mentions: msg.mentions,
    embedded_card_type: msg.embeddedCardType,
    embedded_card_id: msg.embeddedCardId,
    thread_reply_count: msg.threadReplyCount,
    created_at: msg.createdAt.toISOString(),
  };
}

export async function messageRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/channels/:cid/messages
   *
   * Seq-ascending paginated messages for a channel.
   *
   * Query params:
   *   after_seq  — exclusive lower bound (seq > after_seq). Absent → most recent `limit` rows.
   *   limit      — max rows to return, capped at MAX_PAGE_SIZE (100). Default MAX_PAGE_SIZE.
   *
   * Private channel non-member: 404 (uniform — does not reveal existence).
   * Channel not in workroom: 404.
   */
  app.get('/api/v1/workrooms/:wid/channels/:cid/messages', async (request, reply) => {
    // Dual-auth: machine_token (full) OR dev_control_token (read-only, allowlist + workroom-scope).
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { wid, cid } = request.params as { wid: string; cid: string };

    // machine mode: enforce org/workroom access.
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    // Parse query params.
    const query = request.query as { after_seq?: string; limit?: string };

    let afterSeq: bigint | undefined;
    if (query.after_seq !== undefined) {
      if (!/^\d+$/.test(query.after_seq)) {
        return reply.code(400).send({ error: { code: 'INVALID_AFTER_SEQ', message: 'after_seq must be a non-negative integer' } });
      }
      afterSeq = BigInt(query.after_seq);
    }

    const requestedLimit = query.limit !== undefined
      ? Math.min(Math.max(1, parseInt(query.limit, 10) || 1), MAX_PAGE_SIZE)
      : MAX_PAGE_SIZE;

    // Verify the channel belongs to this workroom AND is visible to this viewer.
    // visibleChannels returns all visible (non-archived) channels for the workroom.
    // We then check if cid is among them. This ensures:
    //   - channel exists in this workroom
    //   - viewer can see it (public or member of private)
    // 404 for both missing and private-non-member (uniform, anti-enumeration).
    const visible = await visibleChannels(auth, wid);
    const channel = visible.find((ch) => ch.id === cid);
    if (!channel) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    // Fetch messages.
    // after_seq present → forward page: seq > after_seq, ascending, limit+1 to detect has_more.
    // after_seq absent  → most recent page: fetch descending limit+1, slice limit, reverse to asc.
    let page: Awaited<ReturnType<typeof db.controlMessage.findMany>>;
    let hasMore: boolean;

    if (afterSeq !== undefined) {
      const rows = await db.controlMessage.findMany({
        where: { channelId: cid, seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
        take: requestedLimit + 1,
      });
      hasMore = rows.length > requestedLimit;
      page = rows.slice(0, requestedLimit);
    } else {
      // No after_seq: most recent `limit` rows.
      // Fetch limit+1 desc to detect has_more; slice to limit; reverse to ascending order.
      const rows = await db.controlMessage.findMany({
        where: { channelId: cid },
        orderBy: { seq: 'desc' },
        take: requestedLimit + 1,
      });
      hasMore = rows.length > requestedLimit;
      const pageDesc = rows.slice(0, requestedLimit);
      pageDesc.reverse(); // seq-ascending
      page = pageDesc;
    }

    // Resolve sender display names (batch, no N+1).
    const senderNames = await resolveSenderDisplayNames(
      page.map((m) => ({ senderId: m.senderId, senderKind: m.senderKind })),
    );

    return {
      channel_id: cid,
      messages: page.map((m) => formatMessage(m, senderNames)),
      has_more: hasMore,
    };
  });

  /**
   * GET /api/v1/messages/:id
   *
   * Fetch a single message by id. Used for thread parent / deep links (§4.4).
   *
   * Auth: dual-read + channel visibility check.
   * Returns the message including its channel_id.
   * Private channel non-member → 404 (uniform, anti-enumeration).
   */
  app.get('/api/v1/messages/:id', async (request, reply) => {
    // Dual-auth: machine_token (full) OR dev_control_token (read-only, allowlist + workroom-scope).
    // NOTE: /api/v1/messages/:id is NOT on the dev-token allowlist in S1 (added in Chunk 5).
    // For now only machine tokens can reach this endpoint via authorizeControlRead.
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { id } = request.params as { id: string };

    // Fetch the message first.
    const msg = await db.controlMessage.findUnique({
      where: { id },
    });

    // 404 if message doesn't exist or has no channel (shouldn't happen post-backfill).
    if (!msg || !msg.channelId) {
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    // machine mode: enforce org/workroom access.
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, msg.workroomId);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    // Channel visibility check: verify the viewer can see this channel.
    // 404 uniform for non-member private channels (anti-enumeration).
    const visible = await visibleChannels(auth, msg.workroomId);
    const isVisible = visible.some((ch) => ch.id === msg.channelId);
    if (!isVisible) {
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    // Resolve sender display name.
    const senderNames = await resolveSenderDisplayNames([{ senderId: msg.senderId, senderKind: msg.senderKind }]);

    return {
      ...formatMessage(msg, senderNames),
      channel_id: msg.channelId,
    };
  });
}
