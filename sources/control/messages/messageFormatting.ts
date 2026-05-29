/**
 * messageFormatting — shared helpers for shaping ControlMessage rows into wire format.
 *
 * Extracted from messageRoutes.ts so that other route files (e.g. agentApiRoutes.ts)
 * can reuse the same canonical wire shape without duplicating the logic.
 *
 * Exports:
 *   resolveSenderDisplayNames(senders) → Map<senderId, displayName>
 *   formatMessage(msg, senderNames)    → wire-shape object (§4.2)
 */

import { db } from '@/storage/db';
import { serverToSlockStatus } from '@/control/tasks/slockTaskStatus';

// ── resolveSenderDisplayNames ────────────────────────────────────────────────

/**
 * Resolve sender display names in a batch (no N+1).
 * For `agent` senderKind: look up ControlAgent.displayName / name.
 * For `user` or `system` senderKind: no agent row; return null (client renders kind as label).
 *
 * Returns a map from senderId → display name string.
 * Missing or unresolvable senders → absent from map (caller converts to null).
 */
export async function resolveSenderDisplayNames(
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
  //
  // MULTIPLE AGENTS PER MACHINE: the (org, machine) unique was dropped, so a machine.id
  // can map to MANY ControlAgent rows. A daemon message uses senderId = machine.id and is
  // therefore AMBIGUOUS — there is no single "the" agent for that machine. We pick the
  // FIRST agent by createdAt (oldest = the default agent created at bind-org) deterministically.
  // We order ascending and only set the machineId key once (do not overwrite), so the
  // oldest agent's name always wins regardless of row return order.
  const agents = await db.controlAgent.findMany({
    where: { OR: [{ id: { in: agentIds } }, { machineId: { in: agentIds } }] },
    select: { id: true, machineId: true, displayName: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const a of agents) {
    const label = a.displayName?.trim() || a.name?.trim();
    if (!label) continue;
    result.set(a.id, label);                          // agent-id senders (S1): exact, unambiguous
    // machine-id senders (daemon): first (oldest) agent for the machine wins — deterministic.
    if (a.machineId && !result.has(a.machineId)) result.set(a.machineId, label);
  }
  return result;
}

// ── formatMessage ────────────────────────────────────────────────────────────

/** Message row shape accepted by formatMessage. */
export type MessageRow = {
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
};

/** Bug-2 Thread feature: shape of the task chip attached to a parent message. */
export type AttachedTaskWire = {
  task_id: string;
  task_number: number | null;
  title: string;
  assignee_handle: string | null;
  status: string; // Slock vocab (TODO | IN_PROGRESS | …)
};

/**
 * Wire-shape attachment metadata (S7 attachment-preview pipeline).
 * Surfaced inline on every formatted message so iOS can render previews without
 * a per-id metadata round-trip. Bytes themselves still come from
 * GET /api/v1/workrooms/:wid/attachments/:id/blob.
 */
export type AttachmentWire = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

/**
 * Batch-load attachment metadata for a set of attachment ids in one query (no N+1).
 * Returned map is keyed by attachment.id; missing ids are simply absent (caller
 * still emits the id in attachment_ids for back-compat).
 */
export async function resolveAttachmentMetadata(
  ids: string[],
): Promise<Map<string, AttachmentWire>> {
  const result = new Map<string, AttachmentWire>();
  if (ids.length === 0) return result;
  // Dedupe and uuid-shape filter — non-uuid ids would crash the @db.Uuid query.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uniq = [...new Set(ids.filter((i) => uuidRe.test(i)))];
  if (uniq.length === 0) return result;
  const rows = await db.controlAttachment.findMany({
    where: { id: { in: uniq } },
    select: { id: true, filename: true, mimeType: true, sizeBytes: true },
  });
  for (const r of rows) {
    result.set(r.id, {
      id: r.id,
      filename: r.filename,
      mime_type: r.mimeType,
      size_bytes: Number(r.sizeBytes),
    });
  }
  return result;
}

/**
 * Format a ControlMessage row as the wire shape (§4.2).
 * sender_display_name: resolved for agents; null for user/system.
 *
 * Bug-2 Thread feature additions:
 *   - reply_count: same value as thread_reply_count, surfaced under the name the
 *     iOS client expects on the message wire shape. (thread_reply_count is kept
 *     as an alias for back-compat.)
 *   - attached_task: the ControlTask whose parent_message_id == this message
 *     (or null). Supplied by the caller via a batch lookup to avoid N+1.
 */
export function formatMessage(
  msg: MessageRow,
  senderNames: Map<string, string>,
  extras?: {
    attachedTask?: AttachedTaskWire | null;
    attachmentMetadata?: Map<string, AttachmentWire>;
  },
) {
  // S7 attachment-preview: build the inline metadata array in the same order
  // as attachment_ids (preserving authorial order). Ids without metadata in the
  // map (deleted / cross-workroom / non-uuid) are skipped from `attachments`
  // but kept in `attachment_ids` for back-compat.
  const metaMap = extras?.attachmentMetadata;
  const attachments: AttachmentWire[] = [];
  if (metaMap) {
    for (const aid of msg.attachmentIds) {
      const m = metaMap.get(aid);
      if (m) attachments.push(m);
    }
  }
  return {
    id: msg.id,
    seq: msg.seq.toString(),
    sender_kind: msg.senderKind,
    sender_id: msg.senderId,
    sender_display_name: senderNames.get(msg.senderId) ?? null,
    content: msg.content,
    mentions: msg.mentions,
    attachment_ids: msg.attachmentIds,
    attachments,
    embedded_card_type: msg.embeddedCardType,
    embedded_card_id: msg.embeddedCardId,
    thread_reply_count: msg.threadReplyCount,
    reply_count: msg.threadReplyCount,
    parent_message_id: msg.parentMessageId ?? null,
    attached_task: extras?.attachedTask ?? null,
    created_at: msg.createdAt.toISOString(),
  };
}

// ── attached_task batch lookup (Bug-2 Thread) ────────────────────────────────

/**
 * Resolve the "task attached to each message" in a single SQL — no N+1.
 *
 * For each input messageId, returns the OLDEST ControlTask whose
 * parent_message_id == messageId (deterministic "first wins" under v1's
 * no-uniqueness contract). Missing rows are absent from the map; the caller
 * formats them as null.
 *
 * assignee_handle is resolved via the same ControlAgent.displayName / name
 * fallback used for sender display names, in a batched second query.
 */
export async function resolveAttachedTasks(
  messageIds: string[],
): Promise<Map<string, AttachedTaskWire>> {
  const result = new Map<string, AttachedTaskWire>();
  if (messageIds.length === 0) return result;

  // Step 1: load all candidate tasks. Sorted by createdAt ASC so when we walk
  // the result and `set` per messageId, the OLDEST wins (first-set wins because
  // we guard with .has() below).
  const tasks = await db.controlTask.findMany({
    where: { parentMessageId: { in: messageIds } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      ownerInstanceId: true,
      parentMessageId: true,
    },
  });

  // Step 2: resolve assignee display names in one batch.
  const ownerIds = [
    ...new Set(tasks.map((t) => t.ownerInstanceId).filter((x): x is string => !!x)),
  ];
  const ownerNameById = new Map<string, string>();
  if (ownerIds.length > 0) {
    const agents = await db.controlAgent.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, displayName: true, name: true },
    });
    for (const a of agents) {
      const label = a.displayName?.trim() || a.name?.trim();
      if (label) ownerNameById.set(a.id, label);
    }
  }

  // Step 3: pick oldest task per parent (first-wins via .has guard).
  for (const t of tasks) {
    const pid = t.parentMessageId;
    if (!pid || result.has(pid)) continue;
    result.set(pid, {
      task_id: t.id,
      task_number: t.number,
      title: t.title,
      assignee_handle: t.ownerInstanceId ? (ownerNameById.get(t.ownerInstanceId) ?? null) : null,
      status: serverToSlockStatus(t.status),
    });
  }

  return result;
}
