/**
 * Search API — control plane (S5)
 *
 * Endpoint:
 *   GET /api/v1/workrooms/:wid/search?q=<query>&scope=<MY_MESSAGES|CHANNEL|ALL>&time=<ANY_TIME|TODAY|THIS_WEEK|THIS_MONTH>
 *     Cross-entity search within a workroom: messages, channels, members.
 *
 * Contract:
 *   { messages: [<full message wire shape + channel_name>], channels: [<channel wire shape>],
 *     members: [<member wire shape>] }
 *
 * Auth: dual-read via authorizeControlRead (machine_token OR dev_control_token).
 *   - machine mode: also enforces org/workroom access via requireMachineAccessToWorkroom.
 *   - dev mode: authorizeControlRead already enforced the GET allowlist + workroom scope.
 *
 * NO SCHEMA CHANGE: all filters are ILIKE / WHERE on existing tables (no migration).
 *
 * KNOWN SIMPLIFICATIONS (S5 protocol limits — disclosed, not silent):
 *   - scope=CHANNEL behaves identically to ALL server-side: the protocol passes no channel
 *     id, so the server cannot restrict to a single channel. Returned as-is.
 *   - scope=MY_MESSAGES for dev_ctl_ tokens behaves as ALL: a dev token has no operator
 *     subject (no sender identity), so "my messages" cannot be resolved → falls back to ALL.
 *     For machine tokens, MY_MESSAGES filters senderId = machine.id.
 *   - time buckets are last-N-days approximations: TODAY=last 24h, THIS_WEEK=last 7d,
 *     THIS_MONTH=last 30d, ANY_TIME=no filter.
 */

import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { visibleChannels } from '@/control/channels/channelVisibility';

const MESSAGE_LIMIT = 50;
const CHANNEL_LIMIT = 20;
const MEMBER_LIMIT = 20;

// Status sort priority for members — 'online' first. Mirrors memberRoutes.ts.
const STATUS_RANK: Record<string, number> = { online: 0, busy: 1, drain: 2, offline: 3 };
const statusRank = (s: string): number => STATUS_RANK[s] ?? 99;

/**
 * Resolve sender display names in a batch (no N+1).
 * Mirrors messageRoutes.resolveSenderDisplayNames (intentional small duplication — house
 * convention: search builds its own enriched message shape; the canonical resolver is not
 * exported). For `agent` senderKind, looks up ControlAgent by id OR machineId (daemon sends).
 */
async function resolveSenderDisplayNames(
  senders: Array<{ senderId: string; senderKind: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // ControlAgent.id is @db.Uuid; senderId is opaque text. Filter to uuid-shaped ids before
  // querying, else Prisma throws P2023 on the uuid column.
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

  // MULTIPLE AGENTS PER MACHINE: machine.id can now map to MANY agents (the unique was
  // dropped). A daemon senderId = machine.id is ambiguous; pick the oldest agent
  // deterministically (order asc, first machineId match wins). Mirrors messageRoutes.
  const agents = await db.controlAgent.findMany({
    where: { OR: [{ id: { in: agentIds } }, { machineId: { in: agentIds } }] },
    select: { id: true, machineId: true, displayName: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  for (const a of agents) {
    const label = a.displayName?.trim() || a.name?.trim();
    if (!label) continue;
    result.set(a.id, label);
    if (a.machineId && !result.has(a.machineId)) result.set(a.machineId, label);
  }
  return result;
}

/** Full message wire shape (mirrors messageRoutes.formatMessage), plus channel_name. */
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
  channelName: string,
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
    channel_id: msg.channelId,
    channel_name: channelName,
  };
}

/**
 * Compute the lower bound (createdAt >=) for a time bucket. Last-N-days approximations:
 *   TODAY=24h, THIS_WEEK=7d, THIS_MONTH=30d, ANY_TIME / unknown → undefined (no filter).
 */
function timeLowerBound(time: string | undefined, now: Date): Date | undefined {
  const day = 24 * 3600_000;
  switch (time) {
    case 'TODAY':
      return new Date(now.getTime() - day);
    case 'THIS_WEEK':
      return new Date(now.getTime() - 7 * day);
    case 'THIS_MONTH':
      return new Date(now.getTime() - 30 * day);
    case 'ANY_TIME':
    default:
      return undefined;
  }
}

export async function searchRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/search
   *
   * Empty/blank q → { messages: [], channels: [], members: [] } (no DB work).
   */
  app.get('/api/v1/workrooms/:wid/search', async (request, reply) => {
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { wid } = request.params as { wid: string };

    // machine mode: enforce org/workroom access. dev mode: already workroom-scoped by auth.
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    const query = request.query as { q?: string; scope?: string; time?: string };
    const q = (query.q ?? '').trim();

    // Empty / blank query → empty result set (no DB work).
    if (q.length === 0) {
      return { messages: [], channels: [], members: [] };
    }

    const scope = query.scope; // MY_MESSAGES | CHANNEL | ALL (anything else → ALL behaviour)
    const since = timeLowerBound(query.time, new Date());

    // Channels visible to the caller — used to (a) restrict message hits and (b) build the
    // channel result list. Both must respect visibility (no leaking private channels).
    const visible = await visibleChannels(auth, wid);
    const visibleIds = visible.map((c) => c.id);
    const visibleNameById = new Map(visible.map((c) => [c.id, c.name] as const));

    // ── Messages ──────────────────────────────────────────────────────────────
    // content ILIKE %q%, top-level only (parentMessageId IS NULL), within visible channels,
    // optional time filter, optional MY_MESSAGES sender filter (machine only). Limit 50.
    //
    // MY_MESSAGES: only machine tokens have a sender identity (machine.id). dev tokens have
    // no subject → treat MY_MESSAGES as ALL (disclosed).
    const senderFilter =
      scope === 'MY_MESSAGES' && auth.mode === 'machine' ? { senderId: auth.machine.id } : {};

    let messages: ReturnType<typeof formatMessage>[] = [];
    if (visibleIds.length > 0) {
      const rows = await db.controlMessage.findMany({
        where: {
          workroomId: wid,
          channelId: { in: visibleIds },
          parentMessageId: null,
          content: { contains: q, mode: 'insensitive' },
          ...(since ? { createdAt: { gte: since } } : {}),
          ...senderFilter,
        },
        orderBy: { createdAt: 'desc' },
        take: MESSAGE_LIMIT,
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

      const senderNames = await resolveSenderDisplayNames(
        rows.map((m) => ({ senderId: m.senderId, senderKind: m.senderKind })),
      );

      messages = rows.map((m) =>
        formatMessage(m, senderNames, visibleNameById.get(m.channelId) ?? ''),
      );
    }

    // ── Channels ──────────────────────────────────────────────────────────────
    // name ILIKE %q%, visible, not archived. Limit 20. Mirror the GET /channels item shape
    // (unread_count/attention_count omitted here — search returns the lightweight channel
    // shape: id, name, type, visibility, last_activity_at, member_count).
    const channelMatches = visible
      .filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, CHANNEL_LIMIT);

    let channels: Array<{
      id: string;
      name: string;
      type: string;
      visibility: string;
      last_activity_at: string | null;
      member_count: number;
    }> = [];
    if (channelMatches.length > 0) {
      const memberCounts = await db.controlChannelMember.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelMatches.map((c) => c.id) } },
        _count: { channelId: true },
      });
      const memberCountMap = new Map<string, number>(
        memberCounts.map((row) => [row.channelId, row._count.channelId]),
      );
      channels = channelMatches.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        visibility: c.visibility,
        last_activity_at: c.lastActivityAt?.toISOString() ?? null,
        member_count: memberCountMap.get(c.id) ?? 0,
      }));
    }

    // ── Members ───────────────────────────────────────────────────────────────
    // ControlAgent in the workroom's org where displayName ILIKE OR name ILIKE. Limit 20.
    // Member wire shape mirrors memberRoutes.ts.
    const wr = await db.controlWorkroom.findUnique({ where: { id: wid }, select: { orgId: true } });
    let members: Array<{
      id: string;
      kind: 'agent';
      display_name: string;
      role: string;
      status: string;
      machine_id: string | null;
    }> = [];
    if (wr) {
      const agents = await db.controlAgent.findMany({
        where: {
          orgId: wr.orgId,
          OR: [
            { displayName: { contains: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, displayName: true, name: true, role: true, status: true, machineId: true },
        take: MEMBER_LIMIT,
      });

      // Sort online-first, then by name (mirrors memberRoutes.ts; Prisma can't express it).
      agents.sort((a, b) => {
        const r = statusRank(a.status) - statusRank(b.status);
        if (r !== 0) return r;
        return (a.displayName || a.name).localeCompare(b.displayName || b.name);
      });

      members = agents.map((a) => ({
        id: a.id,
        kind: 'agent' as const,
        display_name: a.displayName?.trim() || a.name?.trim() || '',
        role: a.role,
        status: a.status,
        machine_id: a.machineId,
      }));
    }

    return { messages, channels, members };
  });
}
