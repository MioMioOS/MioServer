/**
 * agentApiChannels — Fastify route plugin for /internal/agent-api/channels.
 *
 * The endpoint requires:
 *   - authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id → real ControlAgent)
 *
 * Endpoint:
 *   GET /internal/agent-api/channels
 *     → ALL channels the authenticated agent is a ControlChannelMember of
 *       { channels: [{ id, name }] }
 *
 * Why this exists:
 *   The daemon's per-agent delivery filter needs "which channels is THIS agent a
 *   member of." The machine-scoped GET /api/v1/workrooms/:wid/channels returns all
 *   PUBLIC channels and cannot answer per-agent membership. This agent-api read is
 *   anchored to auth.agent.id, so PUBLIC ≠ auto-member: only channels with an
 *   explicit ControlChannelMember row are returned.
 *
 * No workroom scoping — returns the agent's member channels across all workrooms
 * (deliberate; the daemon coordinator scopes by its single subscribed workroom's
 * WS events; matches agentApiTargets's membership-anchored design).
 */

import type { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeAgentApi } from './agentApiAuth';

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentApiChannels(app: FastifyInstance) {
  /**
   * GET /internal/agent-api/channels
   *
   * Returns every channel the authenticated agent is a member of.
   *
   * Responses:
   *   200 { channels: [{ id, name }] }   (empty array if zero memberships)
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED                 (missing/blank X-Mio-Agent-Id or not owned)
   */
  app.get('/internal/agent-api/channels', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    // ── Step 2: fetch the agent's member channels ─────────────────────────────
    const rows = await db.controlChannelMember.findMany({
      where: { memberId: auth.agent.id },
      select: { channel: { select: { id: true, name: true } } },
    });

    return reply.send({ channels: rows.map((r) => r.channel) });
  });
}
