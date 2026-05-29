/**
 * agentApiPreparedActions — Fastify route plugin for /internal/agent-api/actions/* endpoints.
 *
 * Slice 4.2 Chunk C — the AGENT-FACING proposal side of "prepared actions". An agent
 * proposes a privileged action (create a channel / add a member); the proposal is
 * persisted as a ControlPreparedAction(status 'proposed') and surfaced as a 🔧 card
 * (a system message) in the target channel. An OPERATOR later fulfills or dismisses it
 * (those routes are Chunk D — NOT implemented here).
 *
 * All endpoints require:
 *   - authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id → real ControlAgent)
 * prepare additionally requires:
 *   - resolveAgentChannelTarget (#channel-name → channelId + workroomId, enforces membership).
 *     The resolved channel is the CARD SURFACE (where the 🔧 proposal card is posted).
 *
 * CARD-FIRST ordering (so ControlPreparedAction.cardMessageId is NEVER null): we
 * insertSystemMessage → writeEventAndBroadcast (the existing message.created chain,
 * observable to clients) BEFORE creating the prepared-action row, then store card.id.
 *
 * Params are VALIDATED and NORMALIZED at prepare time (member_handle → member_id,
 * channel → channelId) so Chunk D's fulfill receives clean ids.
 *
 * Endpoints:
 *   POST /internal/agent-api/actions/prepare  { target, type, params }
 *     → resolve target → validate type + per-type params → post 🔧 card → create row
 *     → 200 { action }
 *
 *   GET  /internal/agent-api/actions/list?status=&channel=
 *     → author-anchored findMany (optionally filtered by status and resolved channel)
 *     → 200 { actions }
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { authorizeAgentApi } from '@/control/agentApi/agentApiAuth';
import { resolveAgentChannelTarget } from '@/control/agentApi/agentApiTargets';
import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';

// ── Constants ──────────────────────────────────────────────────────────────────

const SUPPORTED_TYPES = ['channel:create', 'channel:add_member'] as const;
type ActionType = (typeof SUPPORTED_TYPES)[number];

/** The lifecycle statuses a prepared action can carry (mirrors ControlPreparedAction.status). */
const VALID_STATUSES = ['proposed', 'fulfilled', 'dismissed'] as const;

// ── Serialization ──────────────────────────────────────────────────────────────

type PreparedActionRow = NonNullable<Awaited<ReturnType<typeof db.controlPreparedAction.findUnique>>>;

/** Serialize a ControlPreparedAction row to the API shape. */
function toApi(r: PreparedActionRow) {
  return {
    id: r.id,
    workroomId: r.workroomId,
    channelId: r.channelId,
    proposerAgentId: r.proposerAgentId,
    type: r.type,
    params: r.params,
    status: r.status,
    cardMessageId: r.cardMessageId,
    fulfilledByOperator: r.fulfilledByOperator,
    fulfilledResultId: r.fulfilledResultId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── Per-type validation + normalization ─────────────────────────────────────────

type ValidateOk = { ok: true; normalizedParams: Prisma.InputJsonObject; cardText: string };
type ValidateErr = { ok: false; code: string; message: string };
type ValidateResult = ValidateOk | ValidateErr;

/**
 * Validate + normalize params for channel:create.
 * Requires params.name (non-empty string). visibility ∈ {public,private}, default 'public'.
 * Normalized params keep the raw name + the resolved visibility for Chunk D's fulfill.
 */
function validateChannelCreate(params: Record<string, unknown>, agentDisplayName: string): ValidateResult {
  const name = params.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, code: 'INVALID_PARAMS', message: 'params.name must be a non-empty string' };
  }
  let visibility: 'public' | 'private' = 'public';
  if (params.visibility !== undefined && params.visibility !== null) {
    if (params.visibility !== 'public' && params.visibility !== 'private') {
      return { ok: false, code: 'INVALID_PARAMS', message: "params.visibility must be 'public' or 'private'" };
    }
    visibility = params.visibility;
  }
  // Strip a leading '#' for the human-readable card; store the name as given.
  const displayName = name.startsWith('#') ? name.slice(1) : name;
  return {
    ok: true,
    normalizedParams: { name, visibility },
    cardText: `🔧 @${agentDisplayName} proposes: create channel "${displayName}"`,
  };
}

/**
 * Validate + normalize params for channel:add_member.
 * Requires params.channel (a #name resolvable in the workroom, membership-anchored) +
 * (params.member_id OR params.member_handle) identifying an existing member to add.
 *
 * Normalizes channel → channelId and member_handle → member_id so fulfill gets clean ids.
 * The member is resolved against ControlAgent (the addressable, handle-bearing actors) in
 * the proposing agent's org; member_handle matches ControlAgent.name.
 */
async function validateChannelAddMember(
  params: Record<string, unknown>,
  agentId: string,
  agentOrgId: string,
  agentDisplayName: string,
): Promise<ValidateResult> {
  // ── channel (required, resolvable, membership-anchored) ──
  const channel = params.channel;
  if (typeof channel !== 'string' || channel.trim() === '') {
    return { ok: false, code: 'INVALID_PARAMS', message: 'params.channel must be a #channel-name' };
  }
  const resolvedChannel = await resolveAgentChannelTarget(channel, agentId);
  if (!resolvedChannel.ok) {
    // A channel that doesn't resolve (not a member / unsupported / ambiguous) is bad params here.
    return { ok: false, code: 'INVALID_PARAMS', message: `params.channel could not be resolved: ${resolvedChannel.message}` };
  }
  const channelId = resolvedChannel.channelId;

  // ── member (member_id OR member_handle, exactly one resolution path) ──
  const memberId = params.member_id;
  const memberHandle = params.member_handle;
  const hasId = typeof memberId === 'string' && memberId.trim() !== '';
  const hasHandle = typeof memberHandle === 'string' && memberHandle.trim() !== '';
  if (!hasId && !hasHandle) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'params.member_id or params.member_handle is required' };
  }

  let resolvedMemberId: string;
  let memberDisplayName: string;
  if (hasId) {
    const member = await db.controlAgent.findFirst({
      where: { id: memberId as string, orgId: agentOrgId },
      select: { id: true, displayName: true },
    });
    if (!member) {
      return { ok: false, code: 'INVALID_PARAMS', message: 'params.member_id does not match a member in this org' };
    }
    resolvedMemberId = member.id;
    memberDisplayName = member.displayName;
  } else {
    const member = await db.controlAgent.findFirst({
      where: { name: memberHandle as string, orgId: agentOrgId },
      select: { id: true, displayName: true },
    });
    if (!member) {
      return { ok: false, code: 'INVALID_PARAMS', message: 'params.member_handle does not match a member in this org' };
    }
    resolvedMemberId = member.id;
    memberDisplayName = member.displayName;
  }

  return {
    ok: true,
    // Normalized: resolved channelId + member_id so fulfill needs no further lookup.
    normalizedParams: { channel, channelId, member_id: resolvedMemberId },
    cardText: `🔧 @${agentDisplayName} proposes: add ${memberDisplayName} to ${channel}`,
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentApiPreparedActions(app: FastifyInstance) {
  /**
   * POST /internal/agent-api/actions/prepare  { target, type, params }
   *
   * Proposes a privileged action. The target channel is the card surface (membership-
   * anchored). Validates + normalizes per-type params, posts the 🔧 card FIRST (so
   * cardMessageId is never null), then persists ControlPreparedAction(status 'proposed').
   *
   * Responses:
   *   200 { action }
   *   400 INVALID_ACTION_TYPE   — type not in {channel:create, channel:add_member}
   *   400 INVALID_PARAMS        — per-type param validation/normalization failed
   *   400 TARGET_UNSUPPORTED    — bad target format
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER
   *   409 AMBIGUOUS_CHANNEL
   */
  app.post('/internal/agent-api/actions/prepare', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as { target?: unknown; type?: unknown; params?: unknown } | null;
    if (!body?.target || typeof body.target !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'target is required' } });
    }
    if (!body.type || typeof body.type !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'type is required' } });
    }
    const params: Record<string, unknown> =
      body.params && typeof body.params === 'object' && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};

    // ── Step 3: validate type ─────────────────────────────────────────────────
    if (!SUPPORTED_TYPES.includes(body.type as ActionType)) {
      return reply.code(400).send({
        error: { code: 'INVALID_ACTION_TYPE', message: `type must be one of: ${SUPPORTED_TYPES.join(', ')}` },
      });
    }
    const type = body.type as ActionType;

    // ── Step 4: resolve target (the card SURFACE; membership-anchored) ─────────
    const resolved = await resolveAgentChannelTarget(body.target, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    // ── Step 5: validate + normalize per-type params ──────────────────────────
    let validated: ValidateResult;
    if (type === 'channel:create') {
      validated = validateChannelCreate(params, agent.displayName);
    } else {
      validated = await validateChannelAddMember(params, agent.id, agent.orgId, agent.displayName);
    }
    if (!validated.ok) {
      return reply.code(400).send({ error: { code: validated.code, message: validated.message } });
    }

    // ── Step 6: CARD FIRST, then ROW (cardMessageId is never null) ─────────────
    // Post the 🔧 proposal card via the EXISTING message.created chain so clients see it.
    // INTENTIONALLY NON-TRANSACTIONAL: the card is inserted + broadcast BEFORE the row
    // create, with no wrapping tx. This is the chosen design — card-first guarantees
    // cardMessageId is never null. The tradeoff: if the row create below throws, the card
    // is a phantom (an orphan ack with no backing action). That is harmless by spec — a
    // card without a row is just a stray "proposed" ack, never an executable action — and
    // is preferred over a tx (which would risk a broadcast inside a rollback).
    const card = await insertSystemMessage({ workroomId, channelId, content: validated.cardText });
    await writeEventAndBroadcast(card);

    const action = await db.controlPreparedAction.create({
      data: {
        workroomId,
        channelId,
        proposerAgentId: agent.id,
        type,
        params: validated.normalizedParams,
        status: 'proposed',
        cardMessageId: card.id,
      },
    });

    return reply.code(200).send({ action: toApi(action) });
  });

  /**
   * GET /internal/agent-api/actions/list?status=&channel=
   *
   * Author-anchored: returns only prepared actions proposed by the calling agent.
   * Optional filters:
   *   status  — exact status match (proposed | fulfilled | dismissed)
   *   channel — `#channel-name`; restricts to that channel (membership-enforced)
   *
   * Responses:
   *   200 { actions }
   *   400 TARGET_UNSUPPORTED   (bad channel format)
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER
   *   409 AMBIGUOUS_CHANNEL
   */
  app.get('/internal/agent-api/actions/list', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const query = request.query as { status?: string; channel?: string };

    // Reject an unknown status up front (else Prisma silently returns []). A missing/blank
    // status is fine (no filter); a present-but-invalid one is a 400 INVALID_PARAMS.
    if (query.status && !VALID_STATUSES.includes(query.status as (typeof VALID_STATUSES)[number])) {
      return reply.code(400).send({
        error: { code: 'INVALID_PARAMS', message: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      });
    }

    // If a channel filter is supplied, resolve + enforce membership.
    let channelId: string | undefined;
    if (query.channel && typeof query.channel === 'string') {
      const resolved = await resolveAgentChannelTarget(query.channel, agent.id);
      if (!resolved.ok) {
        return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
      }
      channelId = resolved.channelId;
    }

    const actions = await db.controlPreparedAction.findMany({
      where: {
        proposerAgentId: agent.id,
        ...(query.status ? { status: query.status } : {}),
        ...(channelId ? { channelId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return reply.code(200).send({ actions: actions.map(toApi) });
  });
}
