/**
 * channelCore — shareable, tx-aware channel cores (Slice 4.2 Chunk A).
 *
 * WHY THIS EXISTS:
 *   The create-channel and add-member logic was inline in channelRoutes.ts. Chunk D's
 *   operator `fulfill` needs to create a channel / add members UNDER THE OPERATOR'S
 *   identity inside a single `db.$transaction`, and roll the whole thing back on failure
 *   WITHOUT having already broadcast a phantom channel.created / member_added over WS.
 *
 *   So the cores here are:
 *     1. TX-AWARE — every DB call (incl. the event ROW via publishControlEvent) runs on
 *        the caller-supplied Prisma client `(client ?? db)`. Pass a tx client to make the
 *        whole core atomic; omit it to run standalone exactly like the old inline code.
 *     2. BROADCAST-FREE — the cores do the DB writes and RETURN the broadcast payload(s).
 *        The caller emits them AFTER commit. This is REQUIRED: broadcasting is irreversible,
 *        so it must never happen inside a transaction that might roll back.
 *
 * WRITE-BEFORE-BROADCAST is preserved end-to-end: the event ROW is persisted by the core;
 * the WS fanout happens only after the caller has committed (or, for the direct routes,
 * immediately after the standalone publish — same as before this extraction).
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import {
  publishControlEvent,
  publishControlEventInTx,
  type ControlEventResult,
} from '@/control/events/publishControlEvent';
import { workroomBroadcaster, type WorkroomEventPayload } from '@/control/ws/workroomBroadcaster';
import { reelectForChannel } from './coreAgentElection';

/**
 * A Prisma client usable for tx-aware writes: either the singleton `db` or a `$transaction`
 * tx client. Excludes the connection/transaction-management methods a tx client lacks.
 */
export type ChannelTxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * The serializable event shape pushed to WS subscribers (mirrors workroomBroadcaster's
 * WorkroomEventPayload + the 6-field shape writeEventAndBroadcast builds).
 */
export type BroadcastPayload = WorkroomEventPayload;

/** Map a persisted ControlEventResult to the 6-field WS broadcast payload. */
function toBroadcastPayload(event: ControlEventResult): BroadcastPayload {
  return {
    event_id: event.eventId,
    workroom_id: event.workroomId,
    seq: event.seq.toString(),
    topic: event.topic,
    payload: event.payloadJson as Record<string, unknown>,
    created_at: event.createdAt.toISOString(),
  };
}

/**
 * Persist a control-plane channel event ROW and RETURN its broadcast payload.
 * Does NOT broadcast — the caller emits the returned payload AFTER commit.
 *
 * tx-aware:
 *   - no client  → publishControlEvent (its own $transaction + workroom FOR UPDATE lock).
 *                  Identical behavior to the pre-extraction inline path.
 *   - client     → publishControlEventInTx on that client. The caller MUST already hold
 *                  the workroom FOR UPDATE lock (Chunk D's fulfill acquires it before
 *                  running a core), per publishControlEvent.ts's contract.
 *
 * Idempotent replays (same event_id already exists) return `null` — matching the original
 * `if (!event.idempotent)` broadcast guard so a replayed event is never re-broadcast.
 * In practice channel events use a fresh randomUUID() each call, so this is the safety net.
 */
export async function publishChannelEvent(
  workroomId: string,
  topic:
    | 'channel.created'
    | 'channel.updated'
    | 'channel.deleted'
    | 'channel.member_added'
    | 'channel.member_removed'
    | 'agents.stop'
    | 'roster.member_added'
    | 'roster.member_removed'
    | 'roster.profile_updated',
  payload: Record<string, unknown>,
  client?: ChannelTxClient,
): Promise<BroadcastPayload | null> {
  const input = { workroomId, eventId: randomUUID(), topic, payload };
  const event = client
    ? await publishControlEventInTx(client, input)
    : await publishControlEvent(input);
  if (event.idempotent) return null;
  return toBroadcastPayload(event);
}

/**
 * Emit the given broadcast payloads to WS subscribers. Call AFTER commit.
 * Skips nulls (idempotent replays). Fanout failure is non-fatal (handled in broadcaster).
 */
export function broadcastChannelEvents(payloads: Array<BroadcastPayload | null>): void {
  for (const p of payloads) {
    if (p) workroomBroadcaster.broadcast(p.workroom_id, p);
  }
}

/**
 * Thin write-before-broadcast wrapper preserving the OLD positional signature.
 * Used by the call-sites that don't need tx-awareness (dms-create, member-remove,
 * stop-agents): publish the event row (own tx) then broadcast — behavior identical to
 * the pre-extraction writeChannelEventAndBroadcast.
 */
export async function writeChannelEventAndBroadcast(
  workroomId: string,
  topic:
    | 'channel.created'
    | 'channel.updated'
    | 'channel.deleted'
    | 'channel.member_added'
    | 'channel.member_removed'
    | 'agents.stop'
    | 'roster.member_added'
    | 'roster.member_removed'
    | 'roster.profile_updated',
  payload: Record<string, unknown>,
): Promise<void> {
  broadcastChannelEvents([await publishChannelEvent(workroomId, topic, payload)]);
}

/**
 * Look up the kind ('user'|'agent') for an opaque member id. The id space is
 * disjoint: agents are uuid PKs in control_agents; humans are cuid PKs in users.
 * If absent from both, returns null (caller decides whether to log/skip).
 */
export async function lookupMemberKind(
  memberId: string,
  client?: ChannelTxClient,
): Promise<'user' | 'agent' | null> {
  const c = client ?? db;
  // Agent ids are uuid (@db.Uuid); a non-uuid id queried against the column
  // throws P2023. Shape-check first so we route the lookup to the right table.
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (UUID_RE.test(memberId)) {
    const agent = await c.controlAgent.findUnique({ where: { id: memberId }, select: { id: true } });
    if (agent) return 'agent';
  }
  const user = await c.user.findUnique({ where: { id: memberId }, select: { id: true } });
  if (user) return 'user';
  return null;
}

/** member_count for a single channel (mirrors the GET-channels item shape). tx-aware. */
export async function channelMemberCount(
  channelId: string,
  client?: ChannelTxClient,
): Promise<number> {
  return (client ?? db).controlChannelMember.count({ where: { channelId } });
}

// ── createChannelCore ──────────────────────────────────────────────────────────

export interface CreateChannelCoreInput {
  /** Optional tx client; omit → standalone on the singleton db. */
  db?: ChannelTxClient;
  workroomId: string;
  /** Who creates the channel (op subject id or machine id). Always added as a member. */
  actorId: string;
  /** Validated, non-empty channel name (validation stays in the route). */
  name: string;
  /** 频道类型:standard(默认)| client(客户频道,顾问协议+任务桥)。 */
  channelType?: string;
  /** 客户频道关联的内部开发频道 id(派发目标)。 */
  linkedChannelId?: string | null;
  /** Validated 'public' | 'private' (validation stays in the route). */
  visibility: 'public' | 'private';
  /** Optional description; defaults to ''. */
  description?: string;
  /** Optional extra members; the actor is always added too. */
  memberIds?: string[];
}

export interface CreateChannelCoreResult {
  channel: { id: string; name: string; type: string; visibility: string; lastActivityAt: Date | null };
  memberCount: number;
  /** Broadcast payloads for the caller to emit AFTER commit. NOT broadcast here. */
  events: Array<BroadcastPayload | null>;
}

/**
 * Create a 'standard' channel + member rows + the channel.created event ROW.
 *
 * Assumes inputs are already validated by the caller (route keeps name/visibility checks).
 * Does ALL writes on `(client ?? db)` so a caller can wrap it in a $transaction; does NOT
 * broadcast — returns the event payload(s) for the caller to emit after commit.
 */
export async function createChannelCore(input: CreateChannelCoreInput): Promise<CreateChannelCoreResult> {
  const { db: client, workroomId, actorId, name, visibility, channelType, linkedChannelId } = input;
  const description = input.description ?? '';
  const c = client ?? db;

  // Deduped member set: actor (creator) + provided member_ids.
  const memberSet = new Set<string>([actorId, ...(input.memberIds ?? [])]);

  const now = new Date();
  const channel = await c.controlChannel.create({
    data: {
      workroomId,
      name,
      type: channelType ?? 'standard',
      visibility,
      ...(linkedChannelId ? { linkedChannelId } : {}),
      description,
      createdBy: actorId,
      lastActivityAt: now,
    },
  });

  // skipDuplicates guards the @@unique([channelId, memberId]) (defensive; Set already deduped).
  await c.controlChannelMember.createMany({
    data: [...memberSet].map((memberId) => ({ channelId: channel.id, memberId })),
    skipDuplicates: true,
  });

  const memberCount = await channelMemberCount(channel.id, client);

  const events: Array<BroadcastPayload | null> = [
    await publishChannelEvent(
      workroomId,
      'channel.created',
      {
        channel_id: channel.id,
        name: channel.name,
        type: channel.type,
        visibility: channel.visibility,
        created_by: actorId,
        member_count: memberCount,
      },
      client,
    ),
  ];

  // roster.* per initial member (M1) so daemons watching the workroom can
  // populate their companion graph without a /roster round-trip.
  for (const mid of memberSet) {
    const kind = await lookupMemberKind(mid, client);
    events.push(
      await publishChannelEvent(
        workroomId,
        'roster.member_added',
        { channel_id: channel.id, member_id: mid, member_kind: kind },
        client,
      ),
    );
  }

  return {
    channel: {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      visibility: channel.visibility,
      lastActivityAt: channel.lastActivityAt,
    },
    memberCount,
    events,
  };
}

// ── addMemberCore ────────────────────────────────────────────────────────────

export interface AddMemberCoreInput {
  /** Optional tx client; omit → standalone on the singleton db. */
  db?: ChannelTxClient;
  workroomId: string;
  channelId: string;
  memberId: string;
  /** Who is adding the member (op subject id or machine id). */
  actorId: string;
}

export interface AddMemberCoreResult {
  added: boolean;
  /** true when the channel was missing or cross-workroom → caller maps to 404. */
  notFound?: boolean;
  /** Broadcast payloads for the caller to emit AFTER commit. Empty on no-op / not-found. */
  events: Array<BroadcastPayload | null>;
}

/**
 * Add a member to a channel (idempotent). Validates channel ∈ workroom (notFound otherwise).
 *
 * Does ALL writes on `(client ?? db)`; does NOT broadcast — returns the event payload(s).
 *   - channel missing / cross-workroom → { added:false, notFound:true, events:[] }
 *   - already a member (P2002)         → { added:false, events:[] }  (no event)
 *   - real insert                      → { added:true, events:[channel.member_added] }
 */
export async function addMemberCore(input: AddMemberCoreInput): Promise<AddMemberCoreResult> {
  const { db: client, workroomId, channelId, memberId, actorId } = input;
  const c = client ?? db;

  // Validate channel ∈ workroom (covers both missing channel and cross-workroom).
  const channel = await c.controlChannel.findUnique({ where: { id: channelId }, select: { workroomId: true } });
  if (!channel || channel.workroomId !== workroomId) {
    return { added: false, notFound: true, events: [] };
  }

  // Idempotent insert: P2002 (unique) → already a member → no-op, no event.
  try {
    await c.controlChannelMember.create({ data: { channelId, memberId } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { added: false, events: [] };
    }
    throw err;
  }

  const memberKind = await lookupMemberKind(memberId, client);

  // Adding a HUMAN to a channel grants them workroom membership (member role) so
  // they can actually ACCESS the workspace and see the channel. Without this an
  // invited person gets a channel-member row but every workroom read 403s and
  // they see nothing. Never clobber an existing role (e.g. owner stays owner).
  if (memberKind === 'user') {
    await c.userWorkroomMembership.upsert({
      where: { userId_workroomId: { userId: memberId, workroomId } },
      create: { userId: memberId, workroomId, role: 'member' },
      update: {},
    });
  }

  const events = [
    await publishChannelEvent(
      workroomId,
      'channel.member_added',
      {
        channel_id: channelId,
        member_id: memberId,
        added_by: actorId,
      },
      client,
    ),
    // roster.* mirror event (M1): same channel/member, but carries member_kind so
    // daemon companion graphs can index without an extra lookup.
    await publishChannelEvent(
      workroomId,
      'roster.member_added',
      {
        channel_id: channelId,
        member_id: memberId,
        member_kind: memberKind,
      },
      client,
    ),
  ];

  // Roster changed → re-elect the channel's core agent (off-path, never blocks).
  if (memberKind === 'agent') reelectForChannel(channelId);

  return { added: true, events };
}
