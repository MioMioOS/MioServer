/**
 * agentApiProfile — Fastify route plugin for /internal/agent-api/profile endpoints.
 *
 * All endpoints require:
 *   - authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id → real ControlAgent)
 *
 * Endpoints:
 *   GET /internal/agent-api/profile?handle=
 *     - No handle → return the authed agent's own profile.
 *     - With handle → strip leading '@', findMany in same org by name.
 *       0 results  → 404 HANDLE_NOT_FOUND
 *       >1 results → 409 AMBIGUOUS_HANDLE
 *       1 result   → that agent's profile
 *
 *   PATCH /internal/agent-api/profile  { display_name?, description? }
 *     - Updates ONLY the authed agent's own row (where: { id: auth.agent.id }).
 *     - Only display_name (→ displayName) and description are accepted.
 *     - If neither field is provided → 400 INVALID_BODY (nothing to update).
 *     - Returns updated profile (same shape as GET, including avatar).
 *
 * Profile shape: { handle, display_name, description, role, avatar }
 *   - handle       = '@' + name
 *   - display_name = displayName
 *   - avatar       = generateIdenticon(name)  (deterministic data-uri)
 */

import type { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeAgentApi } from '@/control/agentApi/agentApiAuth';
import { generateIdenticon } from './identicon';
import { writeChannelEventAndBroadcast } from '@/control/channels/channelCore';

// ── Types ──────────────────────────────────────────────────────────────────────

type AgentRow = {
  name: string;
  displayName: string;
  description: string;
  role: string;
};

// ── Profile shape builder ──────────────────────────────────────────────────────

function buildProfile(agent: AgentRow) {
  return {
    handle: `@${agent.name}`,
    display_name: agent.displayName,
    description: agent.description,
    role: agent.role,
    avatar: generateIdenticon(agent.name),
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentApiProfile(app: FastifyInstance) {
  /**
   * GET /internal/agent-api/profile?handle=
   *
   * Responses:
   *   200 { handle, display_name, description, role, avatar }
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 HANDLE_NOT_FOUND
   *   409 AMBIGUOUS_HANDLE
   */
  app.get('/internal/agent-api/profile', async (request, reply) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Handle resolution ────────────────────────────────────────────────────
    const query = (request.query as Record<string, unknown>);
    const rawHandle = typeof query.handle === 'string' ? query.handle : undefined;

    if (!rawHandle) {
      // No handle → return self
      return reply.code(200).send(buildProfile(agent));
    }

    // Strip leading '@' if present
    const handle = rawHandle.startsWith('@') ? rawHandle.slice(1) : rawHandle;

    // findMany scoped to the same org
    const matches = await db.controlAgent.findMany({
      where: { orgId: agent.orgId, name: handle },
    });

    if (matches.length === 0) {
      return reply.code(404).send({
        error: { code: 'HANDLE_NOT_FOUND', message: `No agent found with handle @${handle}` },
      });
    }
    if (matches.length > 1) {
      return reply.code(409).send({
        error: { code: 'AMBIGUOUS_HANDLE', message: `Multiple agents found with handle @${handle}` },
      });
    }

    return reply.code(200).send(buildProfile(matches[0]));
  });

  /**
   * PATCH /internal/agent-api/profile
   *
   * Body: { display_name?, description? }
   *
   * Responses:
   *   200 { handle, display_name, description, role, avatar }
   *   400 INVALID_BODY  — neither display_name nor description provided
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   */
  app.patch('/internal/agent-api/profile', async (request, reply) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Parse body ────────────────────────────────────────────────────────────
    const body = request.body as {
      display_name?: unknown;
      description?: unknown;
    } | null;

    const updateData: { displayName?: string; description?: string } = {};

    if (body?.display_name !== undefined) {
      if (typeof body.display_name !== 'string' || body.display_name.trim() === '') {
        return reply.code(400).send({
          error: { code: 'INVALID_BODY', message: 'display_name must be a non-empty string' },
        });
      }
      updateData.displayName = body.display_name;
    }
    if (body?.description !== undefined) {
      if (typeof body.description !== 'string') {
        return reply.code(400).send({
          error: { code: 'INVALID_BODY', message: 'description must be a string' },
        });
      }
      updateData.description = body.description;
    }

    // Neither field provided → nothing to update
    if (Object.keys(updateData).length === 0) {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: 'At least one of display_name or description must be provided' },
      });
    }

    // ── Update ONLY the authed agent's own row ────────────────────────────────
    // The where clause is always auth.agent.id — it is impossible to modify
    // another agent's row through this route (no id/handle accepted from body).
    const updated = await db.controlAgent.update({
      where: { id: agent.id },
      data: updateData,
    });

    // roster.profile_updated (M1): fan out to every workroom in the agent's org.
    // We don't know which workrooms include the agent; broadcasting per workroom
    // in the org is the simplest correct upper bound (daemons filter locally).
    try {
      const workrooms = await db.controlWorkroom.findMany({
        where: { orgId: agent.orgId, archivedAt: null },
        select: { id: true },
      });
      for (const w of workrooms) {
        await writeChannelEventAndBroadcast(w.id, 'roster.profile_updated', {
          entity_id: agent.id,
          kind: 'agent',
        });
      }
    } catch (err) {
      request.log.warn({ err }, 'roster.profile_updated broadcast failed (non-fatal)');
    }

    return reply.code(200).send(buildProfile(updated));
  });
}
