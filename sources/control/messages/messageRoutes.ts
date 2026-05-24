/**
 * Message API — control plane (S1 Chunks 3 + 4)
 *
 * Endpoints:
 *   GET /api/v1/workrooms/:wid/channels/:cid/messages?after_seq=<n>&limit=<=100
 *     Returns seq-ascending page of messages in a channel.
 *     Private channel non-member → 404 (uniform, anti-enumeration).
 *
 *   GET /api/v1/messages/:id
 *     Returns a single message by id (for thread parent / deep links).
 *     Private channel non-member → 404 (uniform, anti-enumeration).
 *
 *   POST /api/v1/workrooms/:wid/channels/:cid/messages  (Chunk 4)
 *     Send a message. Auth: op_sess_ (command 'send_message') OR machine_token.
 *     dev_ctl_ → 403 hard reject.
 *     op_sess_ path: client_idempotency_key required (missing → 400).
 *     machine path: client_idempotency_key optional (null → no unique collision per spec §4.3).
 *     private non-member → 403.
 *     Post-commit: publishAndBroadcast(message.created) with redacted+truncated preview.
 *
 * Spec: §4.2 (list) + §4.3 (send) + §4.4 (single).
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { visibleChannels } from '@/control/channels/channelVisibility';
import { authorizeOperatorWrite } from '@/control/operatorSessions/operatorSessionAuth';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { sendMessageTransaction } from './sendMessageTransaction';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { redactControlText } from '@/control/redaction/redactControlText';

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
  // ControlAgent.id is @db.Uuid; senderId is opaque text (may be a non-uuid like
  // 'kris' or 'pairing:<uuid>'). Filter to uuid-shaped ids before querying, else
  // Prisma throws P2023 (Inconsistent column data) on the uuid column. Non-uuid
  // agent senderIds simply resolve to no display name (caller falls back).
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const agentIds = [
    ...new Set(
      senders
        .filter((s) => s.senderKind === 'agent')
        .map((s) => s.senderId)
        .filter((id) => uuidRe.test(id)),
    ),
  ];
  if (agentIds.length === 0) return result;

  // S2 §1.4 — additive (id ∪ machineId) resolution. An agent senderId may be either
  // ControlAgent.id (agent sent as itself, S1) OR machine.id (daemon send). Match on
  // either and key the result map by whichever id the sender actually used.
  //   - id is @db.Uuid: agentIds are already uuid-shape-filtered above → safe to query.
  //   - machineId is text: querying it with the same (uuid-shaped) agentIds is safe.
  const agents = await db.controlAgent.findMany({
    where: { OR: [{ id: { in: agentIds } }, { machineId: { in: agentIds } }] },
    select: { id: true, machineId: true, displayName: true, name: true },
  });

  for (const a of agents) {
    const label = a.displayName?.trim() || a.name?.trim();
    if (!label) continue;
    result.set(a.id, label);                         // agent-id senders (S1)
    if (a.machineId) result.set(a.machineId, label); // machine-id senders (daemon)
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
    channelId: string;
    parentMessageId: string | null;
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
    parent_message_id: msg.parentMessageId ?? null,
    created_at: msg.createdAt.toISOString(),
  };
}

/**
 * Re-fetch a written message by id and return its FULL wire shape (§2 In scope C).
 *
 * The thin SendMessageResult returned by sendMessageTransaction lacks mentions,
 * embedded card fields, threadReplyCount and parentMessageId, so the POST routes
 * re-fetch the row (rather than widen the result type) to build the full response
 * the iOS client decodes into a Message. Returns null only if the row vanished.
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
      embeddedCardType: true,
      embeddedCardId: true,
      threadReplyCount: true,
      createdAt: true,
      channelId: true,
      parentMessageId: true,
    },
  });
  if (!row) return null;
  const names = await resolveSenderDisplayNames([{ senderId: row.senderId, senderKind: row.senderKind }]);
  return formatMessage(row, names);
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
        // S2 §3/§5: replies (parentMessageId set) are excluded from the main timeline.
        where: { channelId: cid, seq: { gt: afterSeq }, parentMessageId: null },
        orderBy: { seq: 'asc' },
        take: requestedLimit + 1,
      });
      hasMore = rows.length > requestedLimit;
      page = rows.slice(0, requestedLimit);
    } else {
      // No after_seq: most recent `limit` rows.
      // Fetch limit+1 desc to detect has_more; slice to limit; reverse to ascending order.
      const rows = await db.controlMessage.findMany({
        // S2 §3/§5: replies (parentMessageId set) are excluded from the main timeline.
        where: { channelId: cid, parentMessageId: null },
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

    // 404 if message doesn't exist.
    if (!msg) {
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

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/messages  (S1 Chunk 4)
   *
   * Send a message to a channel.
   *
   * Auth:
   *   1. op_sess_ (command 'send_message', workroomId-scoped) via authorizeOperatorWrite.
   *   2. machine_token via verifyMachineToken + requireMachineAccessToWorkroom.
   *   dev_ctl_ → hard 403 (defense-in-depth; authorizeOperatorWrite rejects it first, but we
   *   also catch it on the machine path because dev_ctl_ does not pass verifyMachineToken).
   *
   * Idempotency:
   *   op_sess_ path: client_idempotency_key REQUIRED (absent → 400).
   *   machine path: client_idempotency_key optional (null → no collision; two machine sends →
   *     two distinct messages, as intended per spec §4.3 / schema @@unique behaviour for NULLs).
   *
   * Membership:
   *   private/dm non-member send → 403.
   *
   * Post-commit broadcast:
   *   publishAndBroadcast('message.created') with preview = redactControlText(content).slice(0,120).
   *   Broadcast failure is non-fatal (client catches up via GET).
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/messages', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    // ── Auth: try op_sess_ first, then machine_token. dev_ctl_ rejected by both. ──
    let senderKind: string;
    let senderId: string;

    const authHeader = request.headers.authorization;

    // Defense-in-depth: explicitly 403 dev_ctl_ before trying either auth path.
    // (authorizeOperatorWrite also hard-rejects dev_ctl_, but we check here too so the
    // machine fallback cannot inadvertently accept a dev token in some edge case.)
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (rawToken.startsWith('dev_ctl_')) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }

    // Path 1: op_sess_ (operator / human)
    const opAuth = await authorizeOperatorWrite(request, { command: 'send_message', workroomId: wid });

    if (opAuth.ok) {
      // op_sess_ path: client_idempotency_key is REQUIRED.
      const body = request.body as {
        content?: unknown;
        mentions?: unknown;
        embedded_card_type?: unknown;
        embedded_card_id?: unknown;
        client_idempotency_key?: unknown;
      } | null;

      if (!body?.client_idempotency_key || typeof body.client_idempotency_key !== 'string') {
        return reply.code(400).send({
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'client_idempotency_key is required for operator sends' },
        });
      }

      if (!body.content || typeof body.content !== 'string') {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
      }

      senderKind = 'user';
      senderId = opAuth.session.operatorSubjectId;

      const result = await sendMessageTransaction({
        channelId: cid,
        workroomId: wid,
        senderKind,
        senderId,
        content: body.content,
        mentions: Array.isArray(body.mentions) ? (body.mentions as string[]) : [],
        embeddedCardType: typeof body.embedded_card_type === 'string' ? body.embedded_card_type : null,
        embeddedCardId: typeof body.embedded_card_id === 'string' ? body.embedded_card_id : null,
        clientIdempotencyKey: body.client_idempotency_key,
      });

      if (!result.ok) {
        if (result.code === 'CHANNEL_NOT_FOUND') {
          return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
        }
        if (result.code === 'CHANNEL_FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
        }
        return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
      }

      // Post-commit write-before-broadcast:
      //   1. publishControlEvent writes the event row to DB (awaited — guarantees event exists before response).
      //   2. WS broadcast is fire-and-forget (non-fatal; client catches up via GET /events).
      await writeEventAndBroadcast(result);

      // S2 §2-C: return the FULL message wire shape (re-fetched) + idempotent flag.
      return reply.code(201).send({
        ...(await fetchFormattedMessage(result.id))!,
        idempotent: result.idempotent,
      });
    }

    // op_sess_ returned 401 (not an op_sess_ token) — fall through to machine path.
    // op_sess_ returned 403 (wrong workroom / command) — hard reject.
    if (opAuth.status === 403) {
      return reply.code(403).send({ error: { code: opAuth.code, message: opAuth.message } });
    }

    // Path 2: machine_token
    const machine = await verifyMachineToken(authHeader);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, wid);
    if (!access.ok) {
      return reply.code(access.status).send({ error: access.error });
    }

    // machine path: parse body (client_idempotency_key is optional → null if absent)
    const machineBody = request.body as {
      content?: unknown;
      mentions?: unknown;
      embedded_card_type?: unknown;
      embedded_card_id?: unknown;
      client_idempotency_key?: unknown;
    } | null;

    if (!machineBody?.content || typeof machineBody.content !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
    }

    senderKind = 'agent';
    senderId = machine.id;

    const machineResult = await sendMessageTransaction({
      channelId: cid,
      workroomId: wid,
      senderKind,
      senderId,
      content: machineBody.content,
      mentions: Array.isArray(machineBody.mentions) ? (machineBody.mentions as string[]) : [],
      embeddedCardType: typeof machineBody.embedded_card_type === 'string' ? machineBody.embedded_card_type : null,
      embeddedCardId: typeof machineBody.embedded_card_id === 'string' ? machineBody.embedded_card_id : null,
      clientIdempotencyKey: typeof machineBody.client_idempotency_key === 'string'
        ? machineBody.client_idempotency_key
        : null,
    });

    if (!machineResult.ok) {
      if (machineResult.code === 'CHANNEL_NOT_FOUND') {
        return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
      }
      if (machineResult.code === 'CHANNEL_FORBIDDEN') {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    }

    // Post-commit write-before-broadcast (same as op_sess_ path above).
    await writeEventAndBroadcast(machineResult);

    // S2 §2-C: return the FULL message wire shape (re-fetched) + idempotent flag.
    return reply.code(201).send({
      ...(await fetchFormattedMessage(machineResult.id))!,
      idempotent: machineResult.idempotent,
    });
  });

  // ── S2 Threads ─────────────────────────────────────────────────────────────

  /**
   * Resolve a thread parent for a read request: load the parent message, enforce
   * machine org/workroom access, and verify the parent's channel is visible to the
   * viewer. Returns the parent row on success, or a reply-status object on failure.
   * 404 (uniform) for missing parent, parent-in-other-workroom, or invisible channel.
   */
  async function loadVisibleParent(
    request: FastifyRequest,
    wid: string,
    parentId: string,
  ): Promise<
    | { ok: true; auth: Extract<Awaited<ReturnType<typeof authorizeControlRead>>, { ok: true }>; parent: { id: string; channelId: string; workroomId: string } }
    | { ok: false; status: number; body: { error: { code: string; message: string } } }
  > {
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return { ok: false, status: auth.status, body: { error: { code: auth.code, message: auth.message } } };
    }

    const parent = await db.controlMessage.findUnique({
      where: { id: parentId },
      select: { id: true, channelId: true, workroomId: true },
    });
    // 404 uniform: missing parent or parent not in this workroom.
    if (!parent || parent.workroomId !== wid) {
      return { ok: false, status: 404, body: { error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } } };
    }

    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) {
        return { ok: false, status: access.status, body: { error: access.error } };
      }
    }

    // Channel visibility: 404 uniform if the parent's channel is not visible (anti-enumeration).
    const visible = await visibleChannels(auth, wid);
    if (!visible.some((ch) => ch.id === parent.channelId)) {
      return { ok: false, status: 404, body: { error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } } };
    }

    return { ok: true, auth, parent };
  }

  /**
   * GET /api/v1/workrooms/:wid/threads/:parentId  (S2 §4.2)
   * Thread meta. No ControlThread row → reply_count 0 / last_reply_at null.
   */
  app.get('/api/v1/workrooms/:wid/threads/:parentId', async (request, reply) => {
    const { wid, parentId } = request.params as { wid: string; parentId: string };

    const resolved = await loadVisibleParent(request, wid, parentId);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);

    const thread = await db.controlThread.findUnique({
      where: { parentMessageId: parentId },
      select: { replyCount: true, lastReplyAt: true },
    });

    return {
      id: parentId,
      parent_message_id: parentId,
      reply_count: thread?.replyCount ?? 0,
      last_reply_at: thread?.lastReplyAt ? thread.lastReplyAt.toISOString() : null,
      task_id: null, // reserved for S3 (task-as-thread); always null this milestone.
    };
  });

  /**
   * GET /api/v1/workrooms/:wid/threads/:parentId/replies  (S2 §4.3)
   * Seq-ascending page of replies. after_seq exclusive lower bound; limit ≤ 100.
   */
  app.get('/api/v1/workrooms/:wid/threads/:parentId/replies', async (request, reply) => {
    const { wid, parentId } = request.params as { wid: string; parentId: string };

    const resolved = await loadVisibleParent(request, wid, parentId);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);

    const query = request.query as { after_seq?: string; limit?: string };

    let afterSeq = 0n;
    if (query.after_seq !== undefined) {
      if (!/^\d+$/.test(query.after_seq)) {
        return reply.code(400).send({ error: { code: 'INVALID_AFTER_SEQ', message: 'after_seq must be a non-negative integer' } });
      }
      afterSeq = BigInt(query.after_seq);
    }

    const requestedLimit = query.limit !== undefined
      ? Math.min(Math.max(1, parseInt(query.limit, 10) || 1), MAX_PAGE_SIZE)
      : MAX_PAGE_SIZE;

    const rows = await db.controlMessage.findMany({
      where: { parentMessageId: parentId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: requestedLimit + 1,
      select: {
        id: true, seq: true, senderKind: true, senderId: true, content: true,
        mentions: true, embeddedCardType: true, embeddedCardId: true,
        threadReplyCount: true, createdAt: true, channelId: true, parentMessageId: true,
      },
    });
    const hasMore = rows.length > requestedLimit;
    const page = rows.slice(0, requestedLimit);

    const senderNames = await resolveSenderDisplayNames(
      page.map((m) => ({ senderId: m.senderId, senderKind: m.senderKind })),
    );

    return {
      parent_message_id: parentId,
      messages: page.map((m) => formatMessage(m, senderNames)),
      has_more: hasMore,
    };
  });

  /**
   * POST /api/v1/workrooms/:wid/threads/:parentId/reply  (S2 §4.4)
   *
   * Auth: op_sess_ (command 'send_message') OR machine_token. dev_ctl_ → hard 403.
   * The reply routes through the extended sendMessageTransaction (parentMessageId set),
   * which does the thread bookkeeping in the same $transaction. Post-commit, publishes a
   * thread.reply event (write-before-broadcast; skipped on idempotent replay).
   */
  app.post('/api/v1/workrooms/:wid/threads/:parentId/reply', async (request, reply) => {
    const { wid, parentId } = request.params as { wid: string; parentId: string };

    const authHeader = request.headers.authorization;

    // Defense-in-depth: explicitly 403 dev_ctl_ before either write-auth path.
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (rawToken.startsWith('dev_ctl_')) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }

    // Resolve sender via op_sess_ first, then machine_token.
    let senderKind: string;
    let senderId: string;
    let clientIdempotencyKey: string | null = null;
    let content: string;
    let mentions: string[] = [];

    const body = request.body as {
      content?: unknown;
      mentions?: unknown;
      client_idempotency_key?: unknown;
    } | null;

    const opAuth = await authorizeOperatorWrite(request, { command: 'send_message', workroomId: wid });

    if (opAuth.ok) {
      if (!body?.client_idempotency_key || typeof body.client_idempotency_key !== 'string') {
        return reply.code(400).send({
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'client_idempotency_key is required for operator sends' },
        });
      }
      if (!body.content || typeof body.content !== 'string') {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
      }
      senderKind = 'user';
      senderId = opAuth.session.operatorSubjectId;
      clientIdempotencyKey = body.client_idempotency_key;
      content = body.content;
      mentions = Array.isArray(body.mentions) ? (body.mentions as string[]) : [];
    } else {
      // op_sess_ returned 403 (wrong workroom / command) — hard reject.
      if (opAuth.status === 403) {
        return reply.code(403).send({ error: { code: opAuth.code, message: opAuth.message } });
      }

      // Path 2: machine_token (client_idempotency_key optional).
      const machine = await verifyMachineToken(authHeader);
      if (!machine) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }
      const access = await requireMachineAccessToWorkroom(machine, wid);
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }
      if (!body?.content || typeof body.content !== 'string') {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
      }
      senderKind = 'agent';
      senderId = machine.id;
      clientIdempotencyKey = typeof body.client_idempotency_key === 'string' ? body.client_idempotency_key : null;
      content = body.content;
      mentions = Array.isArray(body.mentions) ? (body.mentions as string[]) : [];
    }

    // Load the parent → derive channelId (404 if missing / not in this workroom).
    const parent = await db.controlMessage.findUnique({
      where: { id: parentId },
      select: { id: true, channelId: true, workroomId: true },
    });
    if (!parent || parent.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } });
    }

    const result = await sendMessageTransaction({
      channelId: parent.channelId,
      workroomId: wid,
      senderKind,
      senderId,
      content,
      mentions,
      clientIdempotencyKey,
      parentMessageId: parentId,
    });

    if (!result.ok) {
      if (result.code === 'CHANNEL_NOT_FOUND') {
        return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
      }
      if (result.code === 'CHANNEL_FORBIDDEN') {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    }

    // Post-commit write-before-broadcast for thread.reply (skipped on idempotent replay).
    await writeThreadReplyEventAndBroadcast({
      workroomId: wid,
      channelId: parent.channelId,
      parentMessageId: parentId,
      messageId: result.id,
      seq: result.seq,
      senderKind,
      senderId,
      content,
      idempotent: result.idempotent,
    });

    // S2 §4.4: full message wire shape (re-fetched) + idempotent flag. 201 (mirrors S1).
    return reply.code(201).send({
      ...(await fetchFormattedMessage(result.id))!,
      idempotent: result.idempotent,
    });
  });

  // ── S5 Saved messages ────────────────────────────────────────────────────────

  /**
   * Resolve the caller subject for a save/unsave write:
   *   op_sess_('save_message')  → subjectId = operatorSubjectId
   *   machine_token             → subjectId = machine.id
   *   dev_ctl_                  → hard 403 (read-only credential cannot write)
   *
   * Returns { ok: true, subjectId } on success, or a reply-status object on failure.
   * Mirrors the op-first → 403-on-wrong-scope → machine-fallback ordering of the
   * send/reply write routes above.
   */
  async function resolveSaveSubject(
    request: FastifyRequest,
    wid: string,
  ): Promise<
    | { ok: true; subjectId: string }
    | { ok: false; status: number; body: { error: { code: string; message: string } } }
  > {
    const authHeader = request.headers.authorization;

    // Defense-in-depth: dev_ctl_ (read-only) can never authorize a write → 403.
    const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (rawToken.startsWith('dev_ctl_')) {
      return { ok: false, status: 403, body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } } };
    }

    // Path 1: op_sess_ (operator / human).
    const opAuth = await authorizeOperatorWrite(request, { command: 'save_message', workroomId: wid });
    if (opAuth.ok) {
      return { ok: true, subjectId: opAuth.session.operatorSubjectId };
    }
    // op_sess_ valid but wrong workroom / command → hard 403.
    if (opAuth.status === 403) {
      return { ok: false, status: 403, body: { error: { code: opAuth.code, message: opAuth.message } } };
    }

    // Path 2: machine_token.
    const machine = await verifyMachineToken(authHeader);
    if (!machine) {
      return { ok: false, status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } } };
    }
    const access = await requireMachineAccessToWorkroom(machine, wid);
    if (!access.ok) {
      return { ok: false, status: access.status, body: { error: access.error } };
    }
    return { ok: true, subjectId: machine.id };
  }

  /**
   * POST /api/v1/workrooms/:wid/messages/:id/save  (S5)
   *
   * Save (bookmark) a message for the caller subject.
   * Auth: op_sess_('save_message') OR machine_token. dev_ctl_ → 403.
   * Validates the message exists in :wid (404 otherwise — anti-enumeration uniform 404).
   * Idempotent: a second save (P2002 on (subjectId, messageId)) → 200 no-op.
   * Returns { ok: true }.
   */
  app.post('/api/v1/workrooms/:wid/messages/:id/save', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    const subj = await resolveSaveSubject(request, wid);
    if (!subj.ok) return reply.code(subj.status).send(subj.body);

    // Validate the message exists in this workroom (404 uniform for missing / other-workroom).
    let msg: { id: string } | null = null;
    try {
      msg = await db.controlMessage.findFirst({
        where: { id, workroomId: wid },
        select: { id: true },
      });
    } catch {
      // Malformed id (not a valid uuid) → uniform 404.
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }
    if (!msg) {
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    try {
      await db.controlSavedMessage.create({
        data: { workroomId: wid, subjectId: subj.subjectId, messageId: id },
      });
    } catch (err) {
      // Idempotent: already saved (P2002 on the (subject_id, message_id) unique index) → no-op.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(200).send({ ok: true });
      }
      throw err;
    }

    return reply.code(200).send({ ok: true });
  });

  /**
   * DELETE /api/v1/workrooms/:wid/messages/:id/save  (S5)
   *
   * Unsave a message for the caller subject.
   * Auth: op_sess_('save_message') OR machine_token. dev_ctl_ → 403.
   * Idempotent: missing save → 200 no-op (deleteMany returns count 0).
   * Returns { ok: true }.
   */
  app.delete('/api/v1/workrooms/:wid/messages/:id/save', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    const subj = await resolveSaveSubject(request, wid);
    if (!subj.ok) return reply.code(subj.status).send(subj.body);

    try {
      await db.controlSavedMessage.deleteMany({
        where: { subjectId: subj.subjectId, messageId: id },
      });
    } catch {
      // Malformed id → treat as no-op (uniform 200; nothing to delete).
      return reply.code(200).send({ ok: true });
    }

    return reply.code(200).send({ ok: true });
  });

  /**
   * GET /api/v1/workrooms/:wid/saved  (S5)
   *
   * List the caller subject's saved messages in the workroom, newest first.
   * Auth: authorizeControlRead (machine_token OR dev_ctl_; allowlisted + workroom-scoped).
   *
   * Subject resolution:
   *   machine mode → subjectId = machine.id (machine-scoped saves).
   *   dev mode     → NO subject (dev_ctl_ is a debug credential with no actor identity).
   *                  Returns ALL saved rows in the workroom (debug view). DISCLOSED:
   *                  this is intentional — dev_ctl_ has no subject to scope by.
   *
   * Returns { saved: [{ id, message_id }] }.
   */
  app.get('/api/v1/workrooms/:wid/saved', async (request, reply) => {
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { wid } = request.params as { wid: string };

    // machine mode: enforce org/workroom access + scope to machine.id subject.
    // dev mode: no subject — return all saved in the workroom (debug; workroom-scope already
    // enforced by authorizeControlRead's devTokenInWorkroomScope).
    const where: { workroomId: string; subjectId?: string } = { workroomId: wid };
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
      where.subjectId = auth.machine.id;
    }

    const rows = await db.controlSavedMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, messageId: true },
    });

    return {
      saved: rows.map((r) => ({ id: r.id, message_id: r.messageId })),
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write-before-broadcast for message.created.
 *
 * Step 1 (awaited by route): publishControlEvent persists the event row to DB.
 *   This guarantees the event exists BEFORE the HTTP 201 response is returned,
 *   satisfying the write-before-broadcast contract (spec §5, same as actionRoutes.ts:74).
 * Step 2 (fire-and-forget): WS broadcast to subscribers. Non-fatal; clients catch up via GET.
 *
 * SECURITY: preview = redactControlText(content) truncated ≤120 chars (spec §5).
 * No tokens, paths, or credentials appear in the WS payload.
 */
async function writeEventAndBroadcast(msg: {
  id: string;
  seq: bigint;
  created_at: Date;
  workroomId: string;
  channelId: string;
  senderKind: string;
  senderId: string;
  content: string;
}): Promise<void> {
  const preview = redactControlText(msg.content).slice(0, 120);

  // Step 1: write event to DB (awaited — guarantees persistence before route returns 201).
  const event = await publishControlEvent({
    workroomId: msg.workroomId,
    eventId: randomUUID(),
    topic: 'message.created',
    payload: {
      channel_id: msg.channelId,
      message_id: msg.id,
      seq: msg.seq.toString(),
      sender_kind: msg.senderKind,
      sender_id: msg.senderId,
      preview,
    },
  });

  // Step 2: WS broadcast (fire-and-forget; non-fatal).
  if (!event.idempotent) {
    workroomBroadcaster.broadcast(msg.workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
  }
}

/**
 * Write-before-broadcast for thread.reply (S2 §4.4 / §5).
 *
 * Mirrors writeEventAndBroadcast but emits topic 'thread.reply' with the parent_message_id.
 * Skipped entirely on idempotent replay (a duplicate reply key must not emit a 2nd event).
 * preview = redactControlText(content) truncated ≤120 chars (no secrets in the WS payload).
 */
async function writeThreadReplyEventAndBroadcast(input: {
  workroomId: string;
  channelId: string;
  parentMessageId: string;
  messageId: string;
  seq: bigint;
  senderKind: string;
  senderId: string;
  content: string;
  idempotent: boolean;
}): Promise<void> {
  // Idempotent replay → the reply already exists; do not re-publish.
  if (input.idempotent) return;

  const preview = redactControlText(input.content).slice(0, 120);

  const event = await publishControlEvent({
    workroomId: input.workroomId,
    eventId: randomUUID(),
    topic: 'thread.reply',
    payload: {
      channel_id: input.channelId,
      parent_message_id: input.parentMessageId,
      message_id: input.messageId,
      seq: input.seq.toString(),
      sender_kind: input.senderKind,
      sender_id: input.senderId,
      preview,
    },
  });

  if (!event.idempotent) {
    workroomBroadcaster.broadcast(input.workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
  }
}
