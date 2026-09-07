/**
 * Write-before-broadcast for message.created (shared).
 *
 * Step 1 (awaited by route): publishControlEvent persists the event row to DB.
 *   This guarantees the event exists BEFORE the HTTP 201 response is returned,
 *   satisfying the write-before-broadcast contract (spec §5, same as actionRoutes.ts:74).
 * Step 2 (fire-and-forget): WS broadcast to subscribers. Non-fatal; clients catch up via GET.
 *
 * SECURITY: preview = redactControlText(content) truncated ≤120 chars (spec §5).
 * No tokens, paths, or credentials appear in the WS payload.
 *
 * Extracted from messageRoutes.ts so every message-create path (messageRoutes POST,
 * /internal/agent-api/send) can share the exact same post-commit step (DRY).
 */

import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { redactControlText } from '@/control/redaction/redactControlText';

export async function writeEventAndBroadcast(msg: {
  id: string;
  seq: bigint;
  created_at: Date;
  workroomId: string;
  channelId: string;
  senderKind: string;
  senderId: string;
  content: string;
  /** Resolved AGENT mention ids for this message (uuid[]). Drives routing. */
  mentions?: string[];
  /** Resolved HUMAN mention ids (cuid[]). When a human @-mentions ONLY other
   *  humans (no agent named), we do NOT wake any AI — it's a person-to-person
   *  ping, the mentioned human just gets a notification. */
  userMentions?: string[];
  /** Explicit wake set (content-routed agent for an @-nobody human message).
   *  When provided it REPLACES the mentions/core derivation below. */
  wakeAgentIds?: string[];
}): Promise<void> {
  const preview = redactControlText(msg.content).slice(0, 120);

  // Per-channel core agent (answers @-nobody messages). Cheap PK lookup; the
  // daemon reads routing off the event without an extra fetch. Non-fatal if it
  // fails — routing then treats the channel as having no core.
  let coreAgentId: string | null = null;
  try {
    const ch = await db.controlChannel.findUnique({
      where: { id: msg.channelId },
      select: { coreAgentId: true },
    });
    coreAgentId = ch?.coreAgentId ?? null;
  } catch { /* leave null */ }

  // Routing decision (single source of truth): a message that @-mentions
  // specific agents wakes exactly those; a message that names nobody wakes only
  // the channel's core agent. The daemon wakes iff selfAgentId ∈ wake_agent_ids.
  //
  // IMPORTANT: only stamp wake_agent_ids when routing is KNOWN — i.e. there are
  // mentions, or a core agent is elected. When a message names nobody AND the
  // channel has no elected core yet (freshly-created channel, a DM before its
  // first election, election still in flight), leave it UNSET so the daemon
  // falls back to its legacy delivery instead of waking nobody.
  const mentions = msg.mentions ?? [];
  let wakeAgentIds: string[] | undefined;
  if (msg.wakeAgentIds) {
    // Caller already decided the wake set (content routing). Trust it.
    wakeAgentIds = [...new Set(msg.wakeAgentIds)];
  } else if (mentions.length > 0) {
    // Named specific agents → wake exactly those.
    wakeAgentIds = [...new Set(mentions)];
  } else if (msg.senderKind === 'user' && (msg.userMentions?.length ?? 0) > 0) {
    // 真人 @ 真人(点名了人类、没点名任何 agent)→ 不唤醒任何 AI。这是人对人
    // 的招呼,被 @ 的人收到手机通知即可(notifyMentionedUsers 另行处理)。
    // 空数组(非 unset)= 权威「不唤醒」,daemon 不走 legacy 兜底。
    wakeAgentIds = [];
  } else if (msg.senderKind === 'user' && coreAgentId) {
    // A HUMAN addressed nobody → the channel's core agent fields it.
    wakeAgentIds = [coreAgentId];
  } else if (msg.senderKind !== 'user' && coreAgentId) {
    // An AGENT posted without naming anyone (a status line, a reply). Wake
    // NOBODY — routing to the core here would make every agent utterance
    // cascade into a coordinator turn. If an agent wants a teammate to act it
    // @-mentions them (which takes the mentions branch above). Empty (not unset)
    // so the daemon treats this as an authoritative "no wake", not a fallback.
    wakeAgentIds = [];
  }
  // else: no core elected yet → leave UNSET so the daemon uses legacy delivery.

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
      core_agent_id: coreAgentId,
      // JSON.stringify drops undefined → field absent → daemon uses legacy path.
      ...(wakeAgentIds ? { wake_agent_ids: wakeAgentIds } : {}),
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
    console.info(
      `[writeEventAndBroadcast] message.created workroom=${msg.workroomId.slice(0, 8)} channel=${msg.channelId.slice(0, 8)} message_id=${msg.id.slice(0, 8)} seq=${msg.seq.toString()} sender_kind=${msg.senderKind} sender_id=${msg.senderId.slice(0, 8)}`,
    );
  } else {
    console.info(
      `[writeEventAndBroadcast] skip idempotent workroom=${msg.workroomId.slice(0, 8)} message_id=${msg.id.slice(0, 8)}`,
    );
  }
}
