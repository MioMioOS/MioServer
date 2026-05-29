/**
 * agentApiTyping — POST /internal/agent-api/typing
 *
 * Ephemeral "agent is typing" indicator. Broadcasts an `agent.typing` event to
 * all WS subscribers of the workroom containing the given channel, WITHOUT
 * persisting to control_event_logs (typing is transient — clients that miss it
 * just don't show the indicator; no catch-up needed).
 *
 * Auth: same as the other /internal/agent-api/* routes (Bearer machineToken
 * + X-Mio-Agent-Id), via authorizeAgentApi. The agent must be a member of
 * the channel (membership check via ControlChannelMember).
 *
 * Body (JSON):
 *   agent_id   — string, MUST match X-Mio-Agent-Id (sanity check).
 *   channel_id — string (UUID).
 *   state      — 'started' | 'stopped'.
 *
 * Responses:
 *   202 { ok: true }              — broadcast attempted (fire-and-forget downstream).
 *   400 INVALID_BODY              — bad shape / unknown state.
 *   401 MACHINE_TOKEN_INVALID
 *   403 AGENT_NOT_OWNED           — auth helper.
 *   403 NOT_A_MEMBER              — agent is not a member of the channel.
 *   404 CHANNEL_NOT_FOUND
 *
 * Design: emit directly via workroomBroadcaster.broadcast — does NOT call
 * publishControlEvent. The synthetic payload uses event_id=randomUUID() and
 * seq="0" so iOS treats it as a non-persistent event (no lastSeenSeq advance).
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { authorizeAgentApi } from './agentApiAuth';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { db } from '@/storage/db';

export async function agentApiTyping(app: FastifyInstance) {
  app.post('/internal/agent-api/typing', async (request, reply) => {
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

    if (!body || typeof body.channel_id !== 'string' || typeof body.state !== 'string') {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: 'channel_id and state are required' },
      });
    }
    if (body.state !== 'started' && body.state !== 'stopped') {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: "state must be 'started' or 'stopped'" },
      });
    }
    // Sanity check: if agent_id provided, it must match the auth header agent.
    if (typeof body.agent_id === 'string' && body.agent_id !== agent.id) {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: 'agent_id mismatch with X-Mio-Agent-Id' },
      });
    }

    const channelId = body.channel_id;
    const state = body.state;

    // Look up workroom from channel + verify membership.
    const channel = await db.controlChannel.findUnique({
      where: { id: channelId },
      select: { id: true, workroomId: true, visibility: true },
    });
    if (!channel) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    // For private/dm channels, require explicit membership. Public channels are
    // visible to all workroom members so we skip the member lookup.
    if (channel.visibility !== 'public') {
      const member = await db.controlChannelMember.findUnique({
        where: {
          channelId_memberId: {
            channelId,
            memberId: agent.id,
          },
        },
        select: { memberId: true },
      });
      if (!member) {
        return reply.code(403).send({ error: { code: 'NOT_A_MEMBER', message: 'Not a member' } });
      }
    }

    // Broadcast directly — DO NOT persist (ephemeral, spec §typing).
    workroomBroadcaster.broadcast(channel.workroomId, {
      event_id: randomUUID(),
      workroom_id: channel.workroomId,
      seq: '0', // synthetic; iOS must NOT advance lastSeenSeq on this topic
      topic: 'agent.typing',
      payload: {
        agent_id: agent.id,
        channel_id: channelId,
        workroom_id: channel.workroomId,
        state,
      },
      created_at: new Date().toISOString(),
    });

    return reply.code(202).send({ ok: true });
  });
}
