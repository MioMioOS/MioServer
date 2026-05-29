/**
 * Message API — control plane (Slice 7 B2-d converted: user_sess_ / machine_token unification).
 *
 * Endpoints (10 routes):
 *   READS  (userOrMachine):
 *     GET    /api/v1/workrooms/:wid/channels/:cid/messages
 *     GET    /api/v1/messages/:id                                   (derived workroom)
 *     GET    /api/v1/workrooms/:wid/threads/:parentId
 *     GET    /api/v1/workrooms/:wid/threads/:parentId/replies
 *     GET    /api/v1/workrooms/:wid/saved
 *     GET    /api/v1/workrooms/:wid/activity
 *
 *   WRITES (user owner OR machine, dev_ctl_/op_sess_ gone):
 *     POST   /api/v1/workrooms/:wid/channels/:cid/messages
 *     POST   /api/v1/workrooms/:wid/threads/:parentId/reply
 *     POST   /api/v1/workrooms/:wid/messages/:id/save
 *     DELETE /api/v1/workrooms/:wid/messages/:id/save
 *     POST   /api/v1/workrooms/:wid/activity/:messageId/handled
 *
 * Auth model (Slice 7 §6.2):
 *   READS  → resolveMessageReadActor — user_sess_ (workroom MEMBER) OR machine_token.
 *            Inline resolution preserves 401/403/404 matrix (mirrors B2-c channelRoutes).
 *   WRITES → authorizeMessageWrite — user_sess_ (workroom OWNER) OR machine_token.
 *            Per-site helper shape (subject = { kind, id }) so each write can mint
 *            the canonical subject id used downstream (senderId / saved.subjectId /
 *            activityState.subjectId). Mirrors authorizeTaskWrite (B2-b) / authorizeChannelWrite (B2-c).
 *
 * Anti-enumeration:
 *   GET /messages/:id: workroom is derived from the loaded message. A user that is not
 *   a member of message.workroomId → uniform 404 (matches the existing
 *   "private channel non-member → 404" semantic for the in-URL workroom case).
 *
 * Privacy fixes vs. previous code:
 *   - GET /saved: the old `dev_ctl_` no-subject "all in workroom" branch is gone — there
 *     is no anonymous read credential post-Slice-7. Saved now scopes by actor's viewerId.
 *   - GET /activity: the old `dev_ctl_` "any non-empty mentions" debug branch is gone.
 *     Activity caller keys: user → [user.id]; machine → [machine.id, ...owned agents].
 *
 * Spec: docs/superpowers/specs/2026-05-26-slock-clone-slice7-user-auth-unification-design.md §6.2
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { visibleChannels } from '@/control/channels/channelVisibility';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { sendMessageTransaction } from './sendMessageTransaction';
import { writeEventAndBroadcast } from './writeEventAndBroadcast';
import { writeThreadReplyEventAndBroadcast } from './writeThreadReplyEventAndBroadcast';
import { resolveSenderDisplayNames, formatMessage, resolveAttachedTasks, resolveAttachmentMetadata } from './messageFormatting';
import { classifyAndMaybeCreateTask } from '@/control/classify/classifyAndMaybeCreateTask';

const MAX_PAGE_SIZE = 100;

// ── Auth resolvers (Slice 7 B2-d) ────────────────────────────────────────────────

/**
 * Read actor for any GET that knows the workroom id up-front (workroom-in-URL routes).
 * Inline so we preserve the route-specific status-code matrix:
 *   no Bearer → 401, invalid session/token → 401, user non-member → 403,
 *   machine cross-org → 403, workroom missing → 404.
 *
 * Mirrors resolveChannelReadActor (B2-c) and resolveTaskReadActor (B2-b).
 */
type MessageReadActor =
  | { kind: 'user'; userId: string }
  | { kind: 'machine'; machineId: string };

type MessageReadResult =
  | { ok: true; viewerId: string; actor: MessageReadActor }
  | { ok: false; status: number; error: { code: string; message: string } };

async function resolveMessageReadActor(
  req: FastifyRequest,
  workroomId: string,
): Promise<MessageReadResult> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const token = authHeader.slice(7);

  // ── Path 1: user_sess_ ──
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return { ok: false, status: 401, error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } };
    }
    // Workroom missing → 404 (anti-enumeration, mirrors memberRoutes / channelRoutes).
    const wr = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { id: true } });
    if (!wr) {
      return { ok: false, status: 404, error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } };
    }
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId } },
    });
    if (!mem) {
      return { ok: false, status: 403, error: { code: 'FORBIDDEN', message: 'Forbidden' } };
    }
    return { ok: true, viewerId: session.userId, actor: { kind: 'user', userId: session.userId } };
  }

  // ── Path 2: machine_token ──
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, viewerId: machine.id, actor: { kind: 'machine', machineId: machine.id } };
}

/**
 * Write subject for message writes (send, reply, save/unsave, mark-handled).
 *   - user_sess_ → must be a workroom OWNER (Slice 7 §6.2). Non-owner → 403; non-member → 403.
 *   - machine_token → must have org access to the workroom.
 *   - missing / invalid → 401.
 *
 * Per-site helper shape: returns the canonical `subjectId` that becomes:
 *   - senderId for messages       (user.id / machine.id — agent_id may override on machine path)
 *   - subjectId for ControlSavedMessage rows
 *   - subjectId for ControlActivityState rows
 *
 * `command` is reserved for future audit; user/machine path does not gate by it
 * (granular per-command grants died with Slice 7 — mirrors authorizeTaskWrite / authorizeChannelWrite).
 */
type MessageWriteSubject =
  | { kind: 'user'; userId: string; subjectId: string }
  | { kind: 'machine'; machineId: string; subjectId: string };

type MessageWriteResult =
  | { ok: true; subject: MessageWriteSubject }
  | { ok: false; status: number; body: { error: { code: string; message: string } } };

async function authorizeMessageWrite(
  req: FastifyRequest,
  opts: { workroomId: string; command: 'send_message' | 'save_message' | 'mark_reviewed' },
): Promise<MessageWriteResult> {
  void opts.command; // reserved for future audit; user/machine path does not gate by command
  const authHeader = req.headers.authorization;
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
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId: opts.workroomId } },
    });
    if (!mem) {
      return { ok: false, status: 403, body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } } };
    }
    if (mem.role !== 'owner') {
      return { ok: false, status: 403, body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } } };
    }
    return {
      ok: true,
      subject: { kind: 'user', userId: session.userId, subjectId: session.userId },
    };
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
  const access = await requireMachineAccessToWorkroom(machine, opts.workroomId);
  if (!access.ok) {
    return { ok: false, status: access.status, body: { error: access.error } };
  }
  return { ok: true, subject: { kind: 'machine', machineId: machine.id, subjectId: machine.id } };
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
  const names = await resolveSenderDisplayNames([{ senderId: row.senderId, senderKind: row.senderKind }]);
  const attached = await resolveAttachedTasks([row.id]);
  const attachmentMetadata = await resolveAttachmentMetadata(row.attachmentIds);
  return formatMessage(row, names, {
    attachedTask: attached.get(row.id) ?? null,
    attachmentMetadata,
  });
}

export async function messageRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/channels/:cid/messages
   *
   * Seq-ascending paginated messages for a channel.
   *
   * Auth: userOrMachine — user_sess_ workroom member OR machine_token org-scoped.
   *
   * Query params:
   *   after_seq  — exclusive lower bound (seq > after_seq). Absent → most recent `limit` rows.
   *   limit      — max rows to return, capped at MAX_PAGE_SIZE (100). Default MAX_PAGE_SIZE.
   *
   * Private channel non-member: 404 (uniform — does not reveal existence).
   * Channel not in workroom: 404.
   */
  app.get('/api/v1/workrooms/:wid/channels/:cid/messages', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const guard = await resolveMessageReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

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
    // 404 for both missing and private-non-member (uniform, anti-enumeration).
    const visible = await visibleChannels({ viewerId: guard.viewerId, viewerKind: guard.actor.kind }, wid);
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
      const rows = await db.controlMessage.findMany({
        where: { channelId: cid, parentMessageId: null },
        orderBy: { seq: 'desc' },
        take: requestedLimit + 1,
      });
      hasMore = rows.length > requestedLimit;
      const pageDesc = rows.slice(0, requestedLimit);
      pageDesc.reverse();
      page = pageDesc;
    }

    const senderNames = await resolveSenderDisplayNames(
      page.map((m) => ({ senderId: m.senderId, senderKind: m.senderKind })),
    );
    // Bug-2 Thread feature: batch-load attached_task per message (no N+1).
    const attachedByMsg = await resolveAttachedTasks(page.map((m) => m.id));
    // S7 attachment-preview: batch-load attachment metadata for inline previews.
    const attachmentMetadata = await resolveAttachmentMetadata(
      page.flatMap((m) => m.attachmentIds),
    );

    return {
      channel_id: cid,
      messages: page.map((m) =>
        formatMessage(m, senderNames, {
          attachedTask: attachedByMsg.get(m.id) ?? null,
          attachmentMetadata,
        }),
      ),
      has_more: hasMore,
    };
  });

  /**
   * GET /api/v1/messages/:id
   *
   * Fetch a single message by id. Used for thread parent / deep links (§4.4).
   * Auth: userOrMachine. Workroom is DERIVED from the loaded message (not in URL).
   *
   * Anti-enumeration:
   *   - missing message → 404
   *   - user-actor not a member of message.workroomId → 404 (NOT 403)
   *   - machine-actor cross-org → 404 (NOT 403; mirrors the missing-message shape)
   *   - private channel non-member → 404
   */
  app.get('/api/v1/messages/:id', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
    }
    const token = authHeader.slice(7);

    const { id } = request.params as { id: string };

    // Fetch the message first so we know the workroom to authorize against.
    let msg: Awaited<ReturnType<typeof db.controlMessage.findUnique>> = null;
    try {
      msg = await db.controlMessage.findUnique({ where: { id } });
    } catch {
      // Malformed uuid → P2023 → uniform 404.
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }
    if (!msg) {
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    let viewerId: string;
    let viewerKind: 'user' | 'machine';
    // ── Resolve actor for THIS message's workroom (derived) ──
    if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
      const session = await resolveUserSession(authHeader);
      if (!session) {
        return reply.code(401).send({ error: { code: 'INVALID_SESSION', message: 'Invalid or expired session' } });
      }
      // Anti-enumeration: non-member → 404 (NOT 403). This is the uniform-404 semantic
      // for derived-workroom routes that must not reveal whether the message exists.
      const mem = await db.userWorkroomMembership.findUnique({
        where: { userId_workroomId: { userId: session.userId, workroomId: msg.workroomId } },
      });
      if (!mem) {
        return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
      }
      viewerId = session.userId;
      viewerKind = 'user';
    } else {
      const machine = await verifyMachineToken(authHeader);
      if (!machine) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }
      const access = await requireMachineAccessToWorkroom(machine, msg.workroomId);
      if (!access.ok) {
        // Anti-enumeration: machine cross-org → 404 (not 403). Same uniform 404 as above.
        return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
      }
      viewerId = machine.id;
      viewerKind = 'machine';
    }

    // Channel visibility check: verify the viewer can see this channel.
    // 404 uniform for non-member private channels (anti-enumeration).
    const visible = await visibleChannels({ viewerId, viewerKind }, msg.workroomId);
    const isVisible = visible.some((ch) => ch.id === msg.channelId);
    if (!isVisible) {
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    const senderNames = await resolveSenderDisplayNames([{ senderId: msg.senderId, senderKind: msg.senderKind }]);
    const attachedByMsg = await resolveAttachedTasks([msg.id]);
    const attachmentMetadata = await resolveAttachmentMetadata(msg.attachmentIds);

    return {
      ...formatMessage(msg, senderNames, {
        attachedTask: attachedByMsg.get(msg.id) ?? null,
        attachmentMetadata,
      }),
      channel_id: msg.channelId,
    };
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/messages
   *
   * Send a message to a channel.
   * Auth (Slice 7): user_sess_ (workroom OWNER) OR machine_token, via authorizeMessageWrite.
   *
   * Idempotency:
   *   user path:    client_idempotency_key REQUIRED (absent → 400).
   *   machine path: client_idempotency_key optional (null → no collision; two machine sends
   *                 → two distinct messages per spec §4.3 / schema @@unique NULL semantics).
   *
   * Membership of the target channel: private/dm non-member → 403 (via sendMessageTransaction).
   *
   * Post-commit: publishAndBroadcast('message.created') with redacted+truncated preview.
   * Broadcast failure is non-fatal (client catches up via GET).
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/messages', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const auth = await authorizeMessageWrite(request, { workroomId: wid, command: 'send_message' });
    if (!auth.ok) return reply.code(auth.status).send(auth.body);

    const body = request.body as {
      content?: unknown;
      mentions?: unknown;
      embedded_card_type?: unknown;
      embedded_card_id?: unknown;
      client_idempotency_key?: unknown;
      agent_id?: unknown;
    } | null;

    if (!body?.content || typeof body.content !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
    }

    // Per-actor idempotency policy + sender attribution.
    let senderKind: string;
    let senderId: string;
    let clientIdempotencyKey: string | null;

    if (auth.subject.kind === 'user') {
      // User path: idempotency key REQUIRED.
      if (!body.client_idempotency_key || typeof body.client_idempotency_key !== 'string') {
        return reply.code(400).send({
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'client_idempotency_key is required for user sends' },
        });
      }
      senderKind = 'user';
      senderId = auth.subject.userId;
      clientIdempotencyKey = body.client_idempotency_key;
    } else {
      // Machine path: idempotency key optional. agent_id may override senderId.
      const machineSender = await resolveMachineSenderId(auth.subject.machineId, body.agent_id);
      if (!machineSender.ok) {
        return reply.code(403).send({ error: { code: machineSender.code, message: machineSender.message } });
      }
      senderKind = 'agent';
      senderId = machineSender.senderId;
      clientIdempotencyKey = typeof body.client_idempotency_key === 'string' ? body.client_idempotency_key : null;
    }

    const result = await sendMessageTransaction({
      channelId: cid,
      workroomId: wid,
      senderKind,
      senderId,
      content: body.content,
      mentions: Array.isArray(body.mentions) ? (body.mentions as string[]) : [],
      embeddedCardType: typeof body.embedded_card_type === 'string' ? body.embedded_card_type : null,
      embeddedCardId: typeof body.embedded_card_id === 'string' ? body.embedded_card_id : null,
      clientIdempotencyKey,
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

    // Classifier hook: top-level user/agent messages may auto-promote to a task.
    // Thread replies are excluded (this route is the top-level send path, but the
    // hook also self-gates on parentMessageId === null defensively). Skipped on
    // idempotent replay so a retried POST does not create duplicate tasks.
    //
    // Run BEFORE writeEventAndBroadcast: the classifier may create a task and
    // insert a system message, and downstream auto-route logic in the agent-api
    // depends on the task already existing when the daemon receives the WS push.
    // Adds ~1.5s to the POST latency — accepted per product spec.
    if (!result.idempotent) {
      await classifyAndMaybeCreateTask({
        workroomId: wid,
        channelId: cid,
        messageId: result.id,
        parentMessageId: null,
        senderKind,
        senderId,
        content: body.content,
      });
    }

    // Post-commit write-before-broadcast (runs AFTER classifier so the task +
    // system message are persisted before the daemon sees the original message).
    await writeEventAndBroadcast(result);

    // S2 §2-C: return the FULL message wire shape (re-fetched) + idempotent flag.
    return reply.code(201).send({
      ...(await fetchFormattedMessage(result.id))!,
      idempotent: result.idempotent,
    });
  });

  // ── S2 Threads ─────────────────────────────────────────────────────────────

  /**
   * Resolve a thread parent for a read request: load the parent message, enforce
   * userOrMachine workroom scope (via resolveMessageReadActor), and verify the
   * parent's channel is visible to the viewer. 404 (uniform) for missing parent,
   * parent-in-other-workroom, or invisible channel.
   */
  async function loadVisibleParent(
    request: FastifyRequest,
    wid: string,
    parentId: string,
  ): Promise<
    | { ok: true; viewerId: string; parent: { id: string; channelId: string; workroomId: string } }
    | { ok: false; status: number; body: { error: { code: string; message: string } } }
  > {
    const guard = await resolveMessageReadActor(request, wid);
    if (!guard.ok) return { ok: false, status: guard.status, body: { error: guard.error } };

    const parent = await db.controlMessage.findUnique({
      where: { id: parentId },
      select: { id: true, channelId: true, workroomId: true },
    });
    if (!parent || parent.workroomId !== wid) {
      return { ok: false, status: 404, body: { error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } } };
    }

    // Channel visibility: 404 uniform if the parent's channel is not visible (anti-enumeration).
    const visible = await visibleChannels({ viewerId: guard.viewerId, viewerKind: guard.actor.kind }, wid);
    if (!visible.some((ch) => ch.id === parent.channelId)) {
      return { ok: false, status: 404, body: { error: { code: 'THREAD_NOT_FOUND', message: 'Thread not found' } } };
    }

    return { ok: true, viewerId: guard.viewerId, parent };
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

    // Bug-2 Thread feature: surface attached task_id on thread meta so iOS can
    // jump straight to the task chip from the thread header.
    const attached = await db.controlTask.findFirst({
      where: { parentMessageId: parentId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    return {
      id: parentId,
      parent_message_id: parentId,
      reply_count: thread?.replyCount ?? 0,
      last_reply_at: thread?.lastReplyAt ? thread.lastReplyAt.toISOString() : null,
      task_id: attached?.id ?? null,
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
        mentions: true, attachmentIds: true, embeddedCardType: true, embeddedCardId: true,
        threadReplyCount: true, createdAt: true, channelId: true, parentMessageId: true,
      },
    });
    const hasMore = rows.length > requestedLimit;
    const page = rows.slice(0, requestedLimit);

    const senderNames = await resolveSenderDisplayNames(
      page.map((m) => ({ senderId: m.senderId, senderKind: m.senderKind })),
    );
    // Bug-2 Thread feature: include attached_task on replies as well (nearly
    // always null in practice, but symmetric with timeline GET).
    const attachedByMsg = await resolveAttachedTasks(page.map((m) => m.id));
    // S7 attachment-preview: batch-load attachment metadata for inline previews.
    const attachmentMetadata = await resolveAttachmentMetadata(
      page.flatMap((m) => m.attachmentIds),
    );

    return {
      parent_message_id: parentId,
      messages: page.map((m) =>
        formatMessage(m, senderNames, {
          attachedTask: attachedByMsg.get(m.id) ?? null,
          attachmentMetadata,
        }),
      ),
      has_more: hasMore,
    };
  });

  /**
   * POST /api/v1/workrooms/:wid/threads/:parentId/reply  (S2 §4.4)
   *
   * Auth (Slice 7): user_sess_ (workroom OWNER) OR machine_token, via authorizeMessageWrite.
   * The reply routes through the extended sendMessageTransaction (parentMessageId set),
   * which does the thread bookkeeping in the same $transaction. Post-commit, publishes a
   * thread.reply event (write-before-broadcast; skipped on idempotent replay).
   */
  app.post('/api/v1/workrooms/:wid/threads/:parentId/reply', async (request, reply) => {
    const { wid, parentId } = request.params as { wid: string; parentId: string };

    const auth = await authorizeMessageWrite(request, { workroomId: wid, command: 'send_message' });
    if (!auth.ok) return reply.code(auth.status).send(auth.body);

    const body = request.body as {
      content?: unknown;
      mentions?: unknown;
      client_idempotency_key?: unknown;
      agent_id?: unknown;
    } | null;

    if (!body?.content || typeof body.content !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
    }

    let senderKind: string;
    let senderId: string;
    let clientIdempotencyKey: string | null;

    if (auth.subject.kind === 'user') {
      if (!body.client_idempotency_key || typeof body.client_idempotency_key !== 'string') {
        return reply.code(400).send({
          error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'client_idempotency_key is required for user sends' },
        });
      }
      senderKind = 'user';
      senderId = auth.subject.userId;
      clientIdempotencyKey = body.client_idempotency_key;
    } else {
      const machineSender = await resolveMachineSenderId(auth.subject.machineId, body.agent_id);
      if (!machineSender.ok) {
        return reply.code(403).send({ error: { code: machineSender.code, message: machineSender.message } });
      }
      senderKind = 'agent';
      senderId = machineSender.senderId;
      clientIdempotencyKey = typeof body.client_idempotency_key === 'string' ? body.client_idempotency_key : null;
    }

    const content = body.content;
    const mentions = Array.isArray(body.mentions) ? (body.mentions as string[]) : [];

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

    return reply.code(201).send({
      ...(await fetchFormattedMessage(result.id))!,
      idempotent: result.idempotent,
    });
  });

  // ── S5 Saved messages ────────────────────────────────────────────────────────

  /**
   * POST /api/v1/workrooms/:wid/messages/:id/save  (S5)
   *
   * Save (bookmark) a message for the caller subject.
   * Auth (Slice 7): user_sess_ (workroom OWNER) OR machine_token.
   * subjectId: user.id for user actor, machine.id for machine actor.
   * Validates the message exists in :wid (404 otherwise — anti-enumeration uniform 404).
   * Idempotent: a second save (P2002 on (subjectId, messageId)) → 200 no-op.
   * Returns { ok: true }.
   */
  app.post('/api/v1/workrooms/:wid/messages/:id/save', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    const auth = await authorizeMessageWrite(request, { workroomId: wid, command: 'save_message' });
    if (!auth.ok) return reply.code(auth.status).send(auth.body);

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
        data: { workroomId: wid, subjectId: auth.subject.subjectId, messageId: id },
      });
    } catch (err) {
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
   * Auth (Slice 7): user_sess_ (workroom OWNER) OR machine_token.
   * Idempotent: missing save → 200 no-op (deleteMany returns count 0).
   * Returns { ok: true }.
   */
  app.delete('/api/v1/workrooms/:wid/messages/:id/save', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    const auth = await authorizeMessageWrite(request, { workroomId: wid, command: 'save_message' });
    if (!auth.ok) return reply.code(auth.status).send(auth.body);

    try {
      await db.controlSavedMessage.deleteMany({
        where: { subjectId: auth.subject.subjectId, messageId: id },
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
   * List the caller's saved messages in the workroom, newest first.
   * Auth (Slice 7): userOrMachine — user_sess_ (member) OR machine_token.
   *
   * Subject resolution:
   *   user actor    → subjectId = user.id
   *   machine actor → subjectId = machine.id
   *
   * The previous "dev_ctl_ no-subject → return ALL workroom saves (debug)" branch is GONE.
   * Anonymous read tokens no longer exist post-Slice-7; leaving the branch would have been a
   * privacy regression. The viewer's own subject is always non-null now.
   *
   * Returns { saved: [{ id, message_id }] }.
   */
  app.get('/api/v1/workrooms/:wid/saved', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const guard = await resolveMessageReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

    const rows = await db.controlSavedMessage.findMany({
      where: { workroomId: wid, subjectId: guard.viewerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, messageId: true },
    });

    return {
      saved: rows.map((r) => ({ id: r.id, message_id: r.messageId })),
    };
  });

  // ── S5 Activity feed ──────────────────────────────────────────────────────────

  /**
   * Resolve the caller's subject keys for the activity (mention) match.
   *   user actor    → [user.id]  (Slice 7: messages with mentions of the user.id surface here.
   *                   Until messages start carrying user.id mentions there will be no rows —
   *                   semantically vacuous, never crashes. The activity-feed @user mention
   *                   semantics are deferred per controller decision 5.)
   *   machine actor → [machine.id, ...machine's ControlAgent.id]  (a mention may target the
   *                   daemon's machine.id OR any agent id bound to that machine).
   */
  async function resolveActivityCallerKeys(actor: MessageReadActor): Promise<string[]> {
    if (actor.kind === 'user') {
      return [actor.userId];
    }
    const keys = [actor.machineId];
    const agents = await db.controlAgent.findMany({
      where: { machineId: actor.machineId },
      select: { id: true },
    });
    for (const a of agents) keys.push(a.id);
    return keys;
  }

  /**
   * GET /api/v1/workrooms/:wid/activity?filter=all|unread|mentions  (S5)
   *
   * The caller's activity feed: top-level messages (parentMessageId IS NULL) in visible
   * channels of :wid whose `mentions` array contains one of the caller's subject keys,
   * newest first, limit 50. Joined with ControlActivityState (subjectId=callerKey,
   * messageId) for the per-message `handled` flag (missing row → handled=false).
   *
   * Auth (Slice 7): userOrMachine — user_sess_ (member) OR machine_token.
   *
   * Caller keys:
   *   user    → [user.id]                                 (vacuous this slice — see note above)
   *   machine → [machine.id, ...machine's ControlAgent.id]
   *
   * The previous "dev_ctl_ no-subject → debug ANY non-empty mentions" branch is GONE
   * (no anonymous read tokens post-Slice-7 — leaving it would have been a privacy regression).
   *
   * filter:
   *   all / mentions → the full mention set (all == mentions for MVP).
   *   unread         → only handled=false ("unread" ≈ "unhandled"; no per-message
   *                    read-cursor this MVP).
   *
   * Returns { activity: [{ id: "act_<messageId>", message_id, handled }] }.
   */
  app.get('/api/v1/workrooms/:wid/activity', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const guard = await resolveMessageReadActor(request, wid);
    if (!guard.ok) return reply.code(guard.status).send({ error: guard.error });

    const { filter: rawFilter } = request.query as { filter?: string };
    const filter = rawFilter === 'unread' ? 'unread' : 'all'; // all == mentions for MVP

    // Restrict to channels the viewer can see (anti-enumeration consistent with the timeline).
    const visible = await visibleChannels({ viewerId: guard.viewerId, viewerKind: guard.actor.kind }, wid);
    const visibleChannelIds = visible.map((ch) => ch.id);
    if (visibleChannelIds.length === 0) {
      return { activity: [] };
    }

    const callerKeys = await resolveActivityCallerKeys(guard.actor);

    // The DB column `mentions` is UUID[]; non-uuid keys (e.g. user.id is a cuid this slice)
    // would crash the query. Filter to uuid-shape only — for user actors with a cuid id this
    // collapses to an empty filter and the feed is vacuous (per Slice 7 spec; user-mention
    // semantics for activity are deferred per controller decision 5).
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uuidCallerKeys = callerKeys.filter((k) => uuidRe.test(k));
    if (uuidCallerKeys.length === 0) {
      return { activity: [] };
    }

    const rows = await db.controlMessage.findMany({
      where: {
        workroomId: wid,
        channelId: { in: visibleChannelIds },
        parentMessageId: null,
        mentions: { hasSome: uuidCallerKeys },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true },
    });

    // Join ControlActivityState for the `handled` flag. subjectId is the actor's primary id
    // (user.id for users; machine.id for machines — agent-id-only matches share the same
    // machine subject for handled state, per the POST /handled write).
    const handledByMessage = new Map<string, boolean>();
    if (rows.length > 0) {
      const states = await db.controlActivityState.findMany({
        where: {
          subjectId: guard.viewerId,
          messageId: { in: rows.map((r) => r.id) },
        },
        select: { messageId: true, handled: true },
      });
      for (const s of states) handledByMessage.set(s.messageId, s.handled);
    }

    let activity = rows.map((r) => ({
      id: `act_${r.id}`,
      message_id: r.id,
      handled: handledByMessage.get(r.id) ?? false,
    }));

    if (filter === 'unread') {
      activity = activity.filter((a) => !a.handled);
    }

    return { activity };
  });

  /**
   * POST /api/v1/workrooms/:wid/activity/:messageId/handled  body { handled: boolean }  (S5)
   *
   * Upsert the caller subject's handled-state for an activity (mention) item.
   * Auth (Slice 7): user_sess_ (workroom OWNER) OR machine_token, via authorizeMessageWrite.
   * subjectId: user.id for user actor, machine.id for machine actor.
   * Validates the message exists in :wid (404 otherwise — anti-enumeration uniform 404).
   * Idempotent upsert on (subjectId, messageId). Returns { ok: true }.
   */
  app.post('/api/v1/workrooms/:wid/activity/:messageId/handled', async (request, reply) => {
    const { wid, messageId } = request.params as { wid: string; messageId: string };

    const auth = await authorizeMessageWrite(request, { workroomId: wid, command: 'mark_reviewed' });
    if (!auth.ok) return reply.code(auth.status).send(auth.body);

    const body = request.body as { handled?: unknown } | null;
    if (typeof body?.handled !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'handled (boolean) is required' } });
    }
    const handled = body.handled;

    // Validate the message exists in this workroom (404 uniform for missing / other-workroom).
    let msg: { id: string } | null = null;
    try {
      msg = await db.controlMessage.findFirst({
        where: { id: messageId, workroomId: wid },
        select: { id: true },
      });
    } catch {
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }
    if (!msg) {
      return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
    }

    await db.controlActivityState.upsert({
      where: { subjectId_messageId: { subjectId: auth.subject.subjectId, messageId } },
      create: { subjectId: auth.subject.subjectId, messageId, handled },
      update: { handled },
    });

    return reply.code(200).send({ ok: true });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve the senderId for a machine-token send/reply, supporting multi-agent attribution.
 *
 *   - agent_id absent (or not a string): legacy default → senderId = machine.id.
 *   - agent_id provided: the agent must EXIST and be OWNED by this machine
 *     (ControlAgent.machineId === machine.id). On success → senderId = agent.id.
 *     If the agent does not exist, or is owned by a different machine → AGENT_NOT_OWNED (403).
 *
 * A non-uuid agent_id can never match a real row, and querying the uuid column with it would
 * throw P2023; we catch that and treat it as "not owned" (403) — a malformed agent_id is
 * never silently downgraded to the machine default.
 */
async function resolveMachineSenderId(
  machineId: string,
  agentId: unknown,
): Promise<
  | { ok: true; senderId: string }
  | { ok: false; code: 'AGENT_NOT_OWNED'; message: string }
> {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return { ok: true, senderId: machineId };
  }

  let agent: { id: string; machineId: string | null } | null = null;
  try {
    agent = await db.controlAgent.findUnique({
      where: { id: agentId },
      select: { id: true, machineId: true },
    });
  } catch {
    return { ok: false, code: 'AGENT_NOT_OWNED', message: 'Agent not found or not owned by this machine' };
  }

  if (!agent || agent.machineId !== machineId) {
    return { ok: false, code: 'AGENT_NOT_OWNED', message: 'Agent not found or not owned by this machine' };
  }

  return { ok: true, senderId: agent.id };
}

