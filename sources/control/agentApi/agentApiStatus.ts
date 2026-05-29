/**
 * agentApiStatus — POST /internal/agent-api/status
 *
 * Slock-style per-agent realtime presence broadcast. Ephemeral — broadcasts an
 * `agent.status` event to all WS subscribers of every workroom in the agent's
 * org, WITHOUT persisting to control_event_logs.
 *
 * Lifecycle (daemon side):
 *   - `starting` — spawn started, session-id not yet captured.
 *   - `thinking` — claude is mid-turn generating output / running tools.
 *   - `typing`   — (reserved; daemon currently collapses into `thinking`).
 *   - `idle`     — session is ready OR a turn just finished.
 *   - `offline`  — implicit (clients mark agents offline after ~30s without
 *                  a broadcast); daemon never sends this.
 *
 * Auth: same as /typing — authorizeAgentApi (Bearer machineToken +
 * X-Mio-Agent-Id).
 *
 * Body (JSON):
 *   agent_id    — string, MUST match X-Mio-Agent-Id (sanity check).
 *   channel_id? — optional string (UUID). Some states (starting/idle) aren't
 *                 channel-scoped; pass-through to the client when present.
 *   state       — 'starting' | 'thinking' | 'typing' | 'idle'.
 *
 * Workroom resolution:
 *   - If channel_id is provided, resolve workroom from the channel and verify
 *     channel membership for private/dm channels (mirrors agentApiTyping).
 *   - If channel_id is absent, broadcast to EVERY workroom in the agent's org
 *     (same pattern as roster.profile_updated in agentApiProfile.ts). The
 *     daemon-side iOS subscribes to its own workroom, so cross-workroom
 *     leakage is bounded by the WS subscription.
 *
 * Responses:
 *   202 { ok: true }
 *   400 INVALID_BODY
 *   401 MACHINE_TOKEN_INVALID
 *   403 AGENT_NOT_OWNED / NOT_A_MEMBER
 *   404 CHANNEL_NOT_FOUND
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { authorizeAgentApi } from './agentApiAuth';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { db } from '@/storage/db';

const VALID_STATES = new Set(['starting', 'thinking', 'typing', 'idle']);

export async function agentApiStatus(app: FastifyInstance) {
  app.post('/internal/agent-api/status', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const body = request.body as {
      agent_id?: unknown;
      channel_id?: unknown;
      state?: unknown;
    } | null;

    if (!body || typeof body.state !== 'string' || !VALID_STATES.has(body.state)) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_BODY',
          message: "state must be one of 'starting' | 'thinking' | 'typing' | 'idle'",
        },
      });
    }
    if (typeof body.agent_id === 'string' && body.agent_id !== agent.id) {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: 'agent_id mismatch with X-Mio-Agent-Id' },
      });
    }
    if (body.channel_id !== undefined && typeof body.channel_id !== 'string') {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: 'channel_id must be a string when present' },
      });
    }

    const state = body.state as 'starting' | 'thinking' | 'typing' | 'idle';
    const channelId = typeof body.channel_id === 'string' ? body.channel_id : undefined;
    const nowIso = new Date().toISOString();

    // ── Resolve workroom(s) ───────────────────────────────────────────────────
    let workroomIds: string[];
    if (channelId) {
      const channel = await db.controlChannel.findUnique({
        where: { id: channelId },
        select: { id: true, workroomId: true, visibility: true },
      });
      if (!channel) {
        return reply.code(404).send({
          error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' },
        });
      }
      if (channel.visibility !== 'public') {
        const member = await db.controlChannelMember.findUnique({
          where: { channelId_memberId: { channelId, memberId: agent.id } },
          select: { memberId: true },
        });
        if (!member) {
          return reply.code(403).send({ error: { code: 'NOT_A_MEMBER', message: 'Not a member' } });
        }
      }
      workroomIds = [channel.workroomId];
    } else {
      // No channel scope — fan out to every workroom in the agent's org so
      // every subscribed iOS client sees the presence dot update. Daemons /
      // clients filter by their own WS subscription (one workroom per app).
      const workrooms = await db.controlWorkroom.findMany({
        where: { orgId: agent.orgId, archivedAt: null },
        select: { id: true },
      });
      workroomIds = workrooms.map((w) => w.id);
    }

    // ── Broadcast (ephemeral; NOT persisted) ──────────────────────────────────
    const payload: Record<string, unknown> = {
      agent_id: agent.id,
      state,
      ts: nowIso,
    };
    if (channelId) payload.channel_id = channelId;

    for (const wid of workroomIds) {
      payload.workroom_id = wid;
      workroomBroadcaster.broadcast(wid, {
        event_id: randomUUID(),
        workroom_id: wid,
        seq: '0', // synthetic — clients MUST NOT advance lastSeenSeq on this topic
        topic: 'agent.status',
        payload: { ...payload },
        created_at: nowIso,
      });
    }

    console.info(
      `[agentApiStatus] received agent=${agent.id.slice(0, 8)} state=${state} channel=${channelId ? channelId.slice(0, 8) : 'none'} workrooms=${workroomIds.length}`,
    );

    return reply.code(202).send({ ok: true });
  });
}
