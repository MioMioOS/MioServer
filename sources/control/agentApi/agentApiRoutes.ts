/**
 * agentApiRoutes — Fastify route plugin for /internal/agent-api/* endpoints.
 *
 * Slice 1: POST /internal/agent-api/send
 *   An AI agent (acting through a local proxy) posts a message to a channel.
 *
 * Slice 1 (Task 1.3): GET /internal/agent-api/history
 *   An AI agent reads recent messages from a channel it belongs to.
 *
 * Auth: authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id header).
 *   On failure: 401 MACHINE_TOKEN_INVALID or 403 AGENT_NOT_OWNED.
 *
 * Target resolution: resolveAgentChannelTarget(target, agent.id).
 *   Only `#channel-name` targets are supported (slice 1).
 *   The resolver is membership-anchored: a successful resolve already proves
 *   the agent is a member, so there is no separate membership gate here.
 *   Public-channel non-member sends → 404 NOT_A_MEMBER (the resolver enforces
 *   its own membership check regardless of channel visibility).
 *
 * POST /send returns: 201 { id, seq } on success (seq as string).
 * GET /history returns: 200 { channel_id, messages: [...], has_more? }
 */

import type { FastifyInstance } from 'fastify';
import { authorizeAgentApi } from './agentApiAuth';
import { resolveAgentChannelTarget } from './agentApiTargets';
import { sendMessageTransaction } from '@/control/messages/sendMessageTransaction';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';
import { resolveContentMentions } from '@/control/messages/messageRoutes';
import { notifyMentionedUsers } from '@/control/notifications/notify';
import { writeThreadReplyEventAndBroadcast } from '@/control/messages/writeThreadReplyEventAndBroadcast';
import { classifyAndMaybeCreateTask } from '@/control/classify/classifyAndMaybeCreateTask';
import { db } from '@/storage/db';
import { resolveSenderDisplayNames, formatMessage, resolveAttachedTasks } from '@/control/messages/messageFormatting';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function contentMentionsOtherAgent(
  channelId: string,
  senderAgentId: string,
  content: string,
): Promise<boolean> {
  if (!content.includes('@')) return false;

  const members = await db.controlChannelMember.findMany({
    where: { channelId },
    select: { memberId: true },
  });
  // Resolve agent members by BOTH ControlAgent.id AND ControlAgent.machineId,
  // mirroring resolveSenderHandle() in classifyAndMaybeCreateTask.ts. The
  // ControlChannelMember.memberId can be either an agent's primary id OR its
  // machineId (daemon-keyed membership), so a UUID_RE-only filter against `id`
  // silently dropped machineId-keyed agents — their @-mentions were never
  // detected and cross-agent handoffs leaked through as non-handoffs.
  const candidateIds = members
    .map((m) => m.memberId)
    .filter((id) => id !== senderAgentId && UUID_RE.test(id));
  if (candidateIds.length === 0) return false;

  const agents = await db.controlAgent.findMany({
    where: {
      OR: [{ id: { in: candidateIds } }, { machineId: { in: candidateIds } }],
    },
    select: { id: true, machineId: true, name: true },
  });
  // Exclude the sender even when they are keyed by machineId in this scan.
  const otherAgents = agents.filter(
    (a) => a.id !== senderAgentId && a.machineId !== senderAgentId,
  );
  if (otherAgents.length === 0) return false;

  // Unicode-safe handoff detection:
  //  - `(?![\p{L}\p{N}_])` is a Unicode non-name lookahead replacing the ASCII
  //    `\b`, which never matched after a CJK name (`@设计师\b` fails before
  //    `，`/space/EOL). This makes `@设计师，`, `@设计师 `, `@设计师`(EOL) match
  //    while `@设计师abc` (longer name) does NOT falsely hit member "设计师".
  //  - `u` flag enables the Unicode property escapes.
  //  - `i` flag makes detection case-insensitive (matches the case-insensitive
  //    assignee resolver in classifyAndMaybeCreateTask.ts), so `@backend` hits
  //    member "Backend".
  return otherAgents.some((a) =>
    new RegExp(`@${escapeRegExp(a.name)}(?![\\p{L}\\p{N}_])`, 'ui').test(content),
  );
}

export async function agentApiRoutes(app: FastifyInstance) {
  /**
   * POST /internal/agent-api/send
   *
   * Body (JSON):
   *   target                  — `#channel-name` (required)
   *   content                 — message text (required)
   *   clientIdempotencyKey?   — optional; null → no unique collision
   *
   * Headers:
   *   Authorization: Bearer <machineToken>
   *   X-Mio-Agent-Id: <agentId>
   *
   * Responses:
   *   201 { id, seq }                — message created
   *   400 TARGET_UNSUPPORTED         — unsupported target syntax
   *   400 INVALID_BODY               — missing target or content
   *   401 MACHINE_TOKEN_INVALID      — bad / missing machine token
   *   403 AGENT_NOT_OWNED            — agent not owned by this machine
   *   404 NOT_A_MEMBER               — agent not a member of any channel by that name
   *   409 AMBIGUOUS_CHANNEL          — agent is a member of >1 channel with that name
   *
   *   On 201: a message.created event is persisted AND broadcast (write-before-broadcast,
   *   spec §5.7) so the socket.io gateway delivers it to the daemon in real time.
   */
  app.post('/internal/agent-api/send', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { agent } = auth;

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as {
      target?: unknown;
      content?: unknown;
      clientIdempotencyKey?: unknown;
      attachment_ids?: unknown;
      parent_message_id?: unknown;
      context_message_id?: unknown;
    } | null;

    if (!body?.target || typeof body.target !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'target is required' } });
    }

    if (!body.content || typeof body.content !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'content is required' } });
    }

    const target = body.target;
    const content = body.content;
    const clientIdempotencyKey =
      typeof body.clientIdempotencyKey === 'string' ? body.clientIdempotencyKey : null;

    // attachment_ids: optional array of strings. Absent → undefined (no attachments).
    // If PRESENT but malformed (not an array, or any element is not a string), fail loud
    // with 400 rather than silently dropping the attachment intent — a coerce-to-undefined
    // would send the message with no attachments and still return 201, leaving the agent
    // believing it attached files when it didn't (silent failure). Mirrors the reminders
    // route, which rejects malformed optional fields with 400 INVALID_BODY.
    let attachmentIds: string[] | undefined;
    if (body.attachment_ids !== undefined) {
      if (
        !Array.isArray(body.attachment_ids) ||
        !(body.attachment_ids as unknown[]).every((x) => typeof x === 'string')
      ) {
        return reply.code(400).send({
          error: { code: 'INVALID_BODY', message: 'attachment_ids must be an array of strings' },
        });
      }
      attachmentIds = body.attachment_ids as string[];
    }

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(target, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }

    const { channelId, workroomId } = resolved;

    // ── Step 3.5: auto-route into the agent's active-task thread ──────────────
    // Server-side enforcement: an agent assigned to an in-flight task should
    // never end up posting on the main channel timeline. The agent's prompt
    // discipline is unreliable, so we silently redirect a top-level send into
    // the active task's thread (i.e. set parent_message_id to the task's
    // parentMessageId) before insert.
    //
    // Respect explicit intent: if the caller already passed parent_message_id,
    // skip auto-route (the agent has explicitly chosen a parent — e.g. a real
    // thread reply or a different task).
    //
    // Only assignees in mid-task are routed — agents with no active task in
    // this channel (e.g. a PM doing coordination) still post on main.
    let parentMessageId: string | null =
      typeof body.parent_message_id === 'string' ? body.parent_message_id : null;
    let autoRoutedTaskNumber: number | null = null;
    // Lifted out of the auto-route block so the classify step (Step 5) can bias
    // an explicit cross-agent @-mention into a task even if the probabilistic
    // gate declines. Stays false when the caller passed an explicit parent.
    let isHandoffMention = false;

    if (!parentMessageId) {
      isHandoffMention = await contentMentionsOtherAgent(channelId, agent.id, content);
      // Context-aware auto-route: route by the conversation the agent is
      // ACTUALLY responding to, not by "any active task this agent owns in
      // this channel". The daemon stamps `context_message_id` onto each
      // outbound `send`; it's the id of the most-recent inbound message that
      // woke this agent.
      //
      // - context message was a thread reply (parent_message_id non-null) and
      //   in the SAME channel → silently route the send into that thread.
      // - context message was a main-channel post (no parent) → do NOT route;
      //   the agent's reply goes to main, matching the conversation.
      // - wrong channel, missing context, or unknown message id → do NOT
      //   route. Safer default than the old "any-active-task" heuristic,
      //   which routed unrelated chit-chat into stale task threads.
      const ctxId = typeof body.context_message_id === 'string' ? body.context_message_id : null;
      if (isHandoffMention) {
        console.info(
          `[agentApi] no_context_route agent=${agent.id.slice(0, 8)} reason=handoff_mention ctx=${ctxId ? ctxId.slice(0, 8) : 'none'}`,
        );
      } else if (ctxId) {
        const ctx = await db.controlMessage.findUnique({
          where: { id: ctxId },
          select: { parentMessageId: true, channelId: true },
        });
        if (!ctx) {
          console.info(
            `[agentApi] no_context_route agent=${agent.id.slice(0, 8)} reason=ctx_not_found ctx=${ctxId.slice(0, 8)}`,
          );
        } else if (ctx.channelId !== channelId) {
          console.info(
            `[agentApi] no_context_route agent=${agent.id.slice(0, 8)} reason=wrong_channel ctx=${ctxId.slice(0, 8)} ctx_channel=${ctx.channelId.slice(0, 8)} send_channel=${channelId.slice(0, 8)}`,
          );
        }
        if (ctx?.parentMessageId && ctx.channelId === channelId) {
          // Case A: context message is itself a thread reply → route to the
          // same thread (continuing the existing conversation).
          parentMessageId = ctx.parentMessageId;
          const task = await db.controlTask.findFirst({
            where: { parentMessageId: ctx.parentMessageId, channelId, ownerInstanceId: agent.id },
            select: { number: true },
          });
          autoRoutedTaskNumber = task?.number ?? null;
          const shortAgent = agent.id.slice(0, 8);
          const shortParent = ctx.parentMessageId.slice(0, 8);
          console.info(
            `[agentApi] context-routed agent=${shortAgent} send to thread parent=${shortParent} task=#${autoRoutedTaskNumber ?? '?'} ctx=${ctxId.slice(0, 8)} reason=A-thread-continuation`,
          );
        } else if (ctx && ctx.parentMessageId === null && ctx.channelId === channelId) {
          // Case B: context message is a TOP-LEVEL main-channel message AND
          // owns an active task assigned to THIS agent → route into that task's
          // thread (the user's @-mention started a task; the agent's first
          // reply belongs IN that task's thread, not on main).
          //
          // This handles the task.assigned wake path: the daemon stamps
          // context_message_id with the triggering message id (the user's
          // top-level @-mention), and we surface it as the thread parent.
          const task = await db.controlTask.findFirst({
            where: {
              parentMessageId: ctxId,
              channelId,
              ownerInstanceId: agent.id,
              status: { in: ['todo', 'in_progress'] },
            },
            select: { number: true },
          });
          if (task) {
            parentMessageId = ctxId;
            autoRoutedTaskNumber = task.number ?? null;
            const shortAgent = agent.id.slice(0, 8);
            const shortParent = ctxId.slice(0, 8);
            console.info(
              `[agentApi] context-routed agent=${shortAgent} send to thread parent=${shortParent} task=#${autoRoutedTaskNumber ?? '?'} ctx=${ctxId.slice(0, 8)} reason=B-task-trigger`,
            );
          } else {
            console.info(
              `[agentApi] no_context_route agent=${agent.id.slice(0, 8)} reason=no_active_task ctx=${ctxId.slice(0, 8)}`,
            );
          }
          // No task on this top-level ctx → genuine main-channel chat (e.g.
          // "@pm hi"); leave parentMessageId null so the reply goes to main.
        }
        // ctx in a different channel or unresolvable ctx id → leave
        // parentMessageId null.
      } else {
        console.info(
          `[agentApi] no_context_route agent=${agent.id.slice(0, 8)} reason=no_ctx`,
        );
      }
      // No context_message_id at all (e.g. agent self-initiated send with no
      // recent inbound) → leave parentMessageId null. Safer default.
    }

    // Resolve @-mentions from the content (agents + HUMANS) the same way the
    // user send path does — otherwise an agent's "@Kris" is never recorded, so
    // the human gets no mention activity and no push. (Was: agent sends passed
    // no mentions at all → user_mentions always empty.)
    const agentMentions = await resolveContentMentions(channelId, content);

    // ── Step 4: send message ──────────────────────────────────────────────────
    const result = await sendMessageTransaction({
      channelId,
      workroomId,
      senderKind: 'agent',
      senderId: agent.id,
      content,
      mentions: agentMentions.agentIds,
      userMentions: agentMentions.userIds,
      clientIdempotencyKey,
      attachmentIds,
      parentMessageId,
    });

    if (!result.ok) {
      // sendMessageTransaction can return CHANNEL_NOT_FOUND (race: channel deleted between
      // resolve and write) or CHANNEL_FORBIDDEN (sendMessageTransaction's own membership guard,
      // which enforces private/dm membership). The resolver's membership anchor already covers
      // public channels, so CHANNEL_FORBIDDEN here means a private/dm channel was found via
      // membership but the sendMessageTransaction guard disagreed — surface as 403.
      if (result.code === 'CHANNEL_NOT_FOUND') {
        return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
      }
      if (result.code === 'CHANNEL_FORBIDDEN') {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    }

    // ── Race #2 fix: idempotent replay must use the PERSISTED parent ───────────
    // On idempotent replay sendMessageTransaction does NOT re-insert — it returns
    // the ORIGINAL stored row. But Step 3.5 recomputed `parentMessageId` fresh
    // from context_message_id, and that recomputation can disagree with what was
    // stored the first time (e.g. the trigger task now exists where it didn't, or
    // ctx state changed between the original POST and the retry). If we broadcast
    // off the recomputed value, a retried POST can emit a DIFFERENT topic
    // (thread.reply vs message.created) — or the same topic under the WRONG
    // parent — than the row actually has on disk. Authoritatively re-derive the
    // routing from the persisted row so the replay's broadcast + response match
    // the stored truth. (Non-idempotent inserts already stored exactly the
    // computed `parentMessageId`, so they need no correction.)
    if (result.idempotent) {
      const persisted = await db.controlMessage.findUnique({
        where: { id: result.id },
        select: { parentMessageId: true },
      });
      const storedParent = persisted?.parentMessageId ?? null;
      if (storedParent !== parentMessageId) {
        console.info(
          `[agentApi] idempotent_replay reconcile message_id=${result.id.slice(0, 8)} computed_parent=${parentMessageId ? parentMessageId.slice(0, 8) : 'null'} stored_parent=${storedParent ? storedParent.slice(0, 8) : 'null'} (using stored)`,
        );
        parentMessageId = storedParent;
        // Re-derive the task number from the persisted parent so the response's
        // routed_to/task_number reflect the stored thread, not the recomputed one.
        if (storedParent) {
          const task = await db.controlTask.findFirst({
            where: { parentMessageId: storedParent, channelId, ownerInstanceId: agent.id },
            select: { number: true },
          });
          autoRoutedTaskNumber = task?.number ?? null;
        } else {
          autoRoutedTaskNumber = null;
        }
      }
    }

    // ── Step 5: classify BEFORE broadcast ─────────────────────────────────────
    // The classifier may create a task + insert a system message. We run it
    // BEFORE writeEventAndBroadcast so by the time the daemon receives the WS
    // push for this message, the task already exists in the DB — eliminating
    // the race where the daemon's auto-route lookup would miss it.
    //
    // Only top-level posts (no parentMessageId) pass through the classifier;
    // auto-routed thread replies skip it (mirrors the user thread-reply path).
    // Skipped on idempotent replay so a retried POST does not create duplicate tasks.
    if (!result.idempotent && !parentMessageId) {
      await classifyAndMaybeCreateTask({
        workroomId,
        channelId,
        messageId: result.id,
        parentMessageId: null,
        senderKind: 'agent',
        senderId: agent.id,
        content,
        // Fix 5 (handoff-task policy): an explicit cross-agent @-mention that
        // was deliberately NOT auto-routed (kept on main as a delegation) must
        // reliably become a task. When isHandoffMention is true we pass
        // forceTaskOnHandoff so the classifier treats a passing heuristic gate
        // as sufficient even if the probabilistic LLM gate returns
        // is_task=false. The heuristic gate (length/greeting/@-mention checks)
        // is NOT bypassed, so "@UI hi" still does not become a task.
        forceTaskOnHandoff: isHandoffMention,
      });
    }

    // ── Step 6: post-commit write-before-broadcast ────────────────────────────
    // Persist the event AND broadcast it so the socket.io gateway delivers it
    // to the daemon in real time (spec §5.7). Awaited so the event row exists
    // before we return 201 (same contract as every messageRoutes POST path).
    // When the send was auto-routed into a thread (parentMessageId set), we
    // emit the thread.reply topic instead of message.created — same shape as
    // the user thread-reply path.
    if (parentMessageId) {
      await writeThreadReplyEventAndBroadcast({
        workroomId,
        channelId,
        parentMessageId,
        messageId: result.id,
        seq: result.seq,
        senderKind: 'agent',
        senderId: agent.id,
        content,
        idempotent: result.idempotent,
      });
    } else {
      // Pass agent mentions so an agent's @-delegation (e.g. a hand-off
      // "@Backend do X") wakes the named teammate via the wake-set routing.
      await writeEventAndBroadcast({ ...result, mentions: agentMentions.agentIds });
    }

    // Push mentioned HUMANS (agent uuid mentions ride the wake set above; humans
    // need APNs + the mention shows in their activity via user_mentions). Skipped
    // on idempotent replay so a retried send doesn't double-notify. Fire-and-forget.
    if (!result.idempotent && agentMentions.userIds.length > 0) {
      notifyMentionedUsers({
        mentionedUserIds: agentMentions.userIds,
        senderUserId: null,
        target: { workroomId, channelId, messageId: result.id, threadId: parentMessageId },
        title: 'You were mentioned',
        body: content.slice(0, 200),
      }).catch((err) => console.error('[agentApi] mention push failed', err));
    }

    // ── Step 7: return { id, seq, routed_to? } ───────────────────────────────
    // When auto-route fires, surface the routing decision so the CLI can tell
    // the agent its message landed in a thread, not on main. Without this
    // signal the agent's narration ("I sent it to main") doesn't match reality
    // ("the message is in task thread"), confusing humans reading the channel.
    const responseBody: Record<string, unknown> = {
      id: result.id,
      seq: result.seq.toString(),
    };
    if (autoRoutedTaskNumber !== null && parentMessageId) {
      responseBody.routed_to = 'thread';
      responseBody.parent_message_id = parentMessageId;
      responseBody.task_number = autoRoutedTaskNumber;
    }
    console.info(
      `[agentApi] send_handled agent=${agent.id.slice(0, 8)} channel=${channelId.slice(0, 8)} message_id=${result.id.slice(0, 8)} seq=${result.seq.toString()} parent=${parentMessageId ? parentMessageId.slice(0, 8) : 'null'} routed_to=${parentMessageId ? 'thread' : 'main'} task_number=${autoRoutedTaskNumber ?? 'null'} idempotent=${result.idempotent}`,
    );
    return reply.code(201).send(responseBody);
  });

  /**
   * GET /internal/agent-api/history
   *
   * Query params:
   *   channel      — `#channel-name` (required)
   *   after_seq    — exclusive lower bound: returns messages with seq > after_seq, ascending.
   *   around       — 8-char message short id: returns a centered window of messages.
   *   limit        — max rows (default 20, clamped to 100).
   *
   * Mode precedence (mutually exclusive, pick the first present):
   *   1. after_seq  → forward page: seq > after_seq, ascending.
   *   2. around     → resolve short id → centered window (floor(limit/2) before + floor(limit/2) after).
   *   3. (neither)  → most recent DEFAULT_PAGE_SIZE, returned seq-ascending.
   *
   * Auth: authorizeAgentApi (same as /send).
   * Channel resolution: resolveAgentChannelTarget (membership-anchored, same as /send).
   *
   * Responses:
   *   200 { channel_id, messages: [...], has_more }
   *   400 INVALID_QUERY        — missing channel param
   *   400 TARGET_UNSUPPORTED   — non-`#name` channel
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER         — agent not a member of any channel by that name
   *   404 MESSAGE_NOT_FOUND    — around short id does not resolve
   *   409 AMBIGUOUS_CHANNEL    — agent is a member of >1 channel with that name
   */
  app.get('/internal/agent-api/history', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { agent } = auth;

    // ── Step 2: parse query params ────────────────────────────────────────────
    const query = request.query as {
      channel?: string;
      after_seq?: string;
      around?: string;
      limit?: string;
    };

    if (!query.channel || typeof query.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'channel is required' } });
    }

    const limitRaw = query.limit !== undefined
      ? Math.min(Math.max(1, parseInt(query.limit, 10) || 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(query.channel, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }

    const { channelId } = resolved;

    // ── Step 4: fetch messages based on mode ──────────────────────────────────

    let page: Array<{
      id: string;
      seq: bigint;
      senderKind: string;
      senderId: string;
      content: string;
      mentions: string[];
      attachmentIds: string[];
      embeddedCardType: string | null;
      embeddedCardId: string | null;
      threadReplyCount: number;
      createdAt: Date;
      channelId: string;
      parentMessageId: string | null;
    }>;
    let hasMore = false;

    const MESSAGE_SELECT = {
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
    } as const;

    if (query.after_seq !== undefined) {
      // ── Mode 1: after_seq — forward page ──────────────────────────────────
      if (!/^\d+$/.test(query.after_seq)) {
        return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'after_seq must be a non-negative integer' } });
      }
      const afterSeq = BigInt(query.after_seq);

      const rows = await db.controlMessage.findMany({
        where: { channelId, seq: { gt: afterSeq }, parentMessageId: null },
        orderBy: { seq: 'asc' },
        take: limitRaw + 1,
        select: MESSAGE_SELECT,
      });
      hasMore = rows.length > limitRaw;
      page = rows.slice(0, limitRaw);

    } else if (query.around !== undefined) {
      // ── Mode 2: around — centered window ──────────────────────────────────
      const shortId = query.around;

      // Resolve the 8-char short id: find a message in this channel whose id (as text) starts
      // with shortId. ControlMessage.id is @db.Uuid so Prisma exposes UuidFilter (no startsWith).
      // We use a raw query with ::text cast to do the prefix match.
      const pivotRows = await db.$queryRaw<Array<{ seq: bigint }>>`
        SELECT seq FROM control_messages
        WHERE channel_id = ${channelId}::uuid
          AND id::text LIKE ${shortId + '%'}
          AND parent_message_id IS NULL
        LIMIT 1
      `;
      const pivot = pivotRows[0] ?? null;
      if (!pivot) {
        return reply.code(404).send({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } });
      }

      const pivotSeq = pivot.seq;
      // windowSize = N messages before the pivot AND N after. Math.max(1, …) keeps small limits
      // monotonic and predictable: limit=1 → 1 before + 1 after, limit=2 → 1 before + 1 after,
      // limit=20 → 10 before + 10 after. (Previously limit=1 silently returned up to AROUND_HALF.)
      const windowSize = Math.max(1, Math.floor(limitRaw / 2));

      // Fetch the pivot + windowSize messages before it: seq <= pivotSeq, descending, take windowSize+1
      // (the +1 captures windowSize true "before" rows in addition to the pivot itself).
      const before = await db.controlMessage.findMany({
        where: { channelId, seq: { lte: pivotSeq }, parentMessageId: null },
        orderBy: { seq: 'desc' },
        take: windowSize + 1,
        select: MESSAGE_SELECT,
      });
      before.reverse(); // seq-ascending

      // Fetch messages after the pivot: seq > pivotSeq, ascending, take windowSize
      const after = await db.controlMessage.findMany({
        where: { channelId, seq: { gt: pivotSeq }, parentMessageId: null },
        orderBy: { seq: 'asc' },
        take: windowSize,
        select: MESSAGE_SELECT,
      });

      // has_more stays false for around mode: a centered window is not a paginated cursor
      // (the agent re-queries with after_seq/no-anchor to page; there is no "next page" here).
      page = [...before, ...after];

    } else {
      // ── Mode 3: no anchor — most recent limitRaw rows ──────────────────────
      const rows = await db.controlMessage.findMany({
        where: { channelId, parentMessageId: null },
        orderBy: { seq: 'desc' },
        take: limitRaw + 1,
        select: MESSAGE_SELECT,
      });
      hasMore = rows.length > limitRaw;
      const pageDesc = rows.slice(0, limitRaw);
      pageDesc.reverse(); // seq-ascending
      page = pageDesc;
    }

    // ── Step 5: resolve sender display names (batch, no N+1) ─────────────────
    const senderNames = await resolveSenderDisplayNames(
      page.map((m) => ({ senderId: m.senderId, senderKind: m.senderKind })),
    );
    // Bug-2 Thread feature: batch-load attached_task per message (no N+1).
    const attachedByMsg = await resolveAttachedTasks(page.map((m) => m.id));

    // ── Step 6: return response ───────────────────────────────────────────────
    return reply.code(200).send({
      channel_id: channelId,
      messages: page.map((m) =>
        formatMessage(m, senderNames, { attachedTask: attachedByMsg.get(m.id) ?? null }),
      ),
      has_more: hasMore,
    });
  });
}
