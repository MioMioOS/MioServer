/**
 * agentApiReactions — Fastify route plugin for /internal/agent-api/messages/react endpoint.
 *
 * All endpoints require:
 *   - authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id → real ControlAgent)
 *   - resolveAgentChannelTarget (#channel-name → channelId + workroomId, enforces membership)
 *
 * Endpoints:
 *   POST /internal/agent-api/messages/react  { target, message_id, emoji, op: 'add' | 'remove' }
 *     → authorizeAgentApi → resolveAgentChannelTarget(target, agent.id) → {channelId, workroomId}
 *     → verify message belongs to that channel (load ControlMessage by message_id, check channelId)
 *     → op 'add':    controlMessageReaction.create; CATCH P2002 (duplicate) → idempotent success
 *     → op 'remove': controlMessageReaction.deleteMany (no-op when row absent)
 *     → emit reaction.added / reaction.removed via writeReactionEventAndBroadcast
 *     → 200 { ok: true }
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { authorizeAgentApi } from './agentApiAuth';
import { resolveAgentChannelTarget } from './agentApiTargets';
import { writeReactionEventAndBroadcast } from '@/control/reactions/writeReactionEventAndBroadcast';

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentApiReactions(app: FastifyInstance) {
  /**
   * POST /internal/agent-api/messages/react
   *
   * Body: { target, message_id, emoji, op: 'add' | 'remove' }
   *
   * Responses:
   *   200 { ok: true }
   *   400 INVALID_BODY        — missing/invalid required fields
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER        — resolveAgentChannelTarget: agent not a member
   *   404 MESSAGE_NOT_IN_CHANNEL — message_id exists but belongs to a different channel
   *   409 AMBIGUOUS_CHANNEL
   */
  app.post('/internal/agent-api/messages/react', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as {
      target?: unknown;
      message_id?: unknown;
      emoji?: unknown;
      op?: unknown;
    } | null;

    if (!body?.target || typeof body.target !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'target is required' } });
    }
    if (!body.message_id || typeof body.message_id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'message_id is required' } });
    }
    if (!body.emoji || typeof body.emoji !== 'string' || body.emoji.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'emoji must be a non-empty string' } });
    }
    if (body.op !== 'add' && body.op !== 'remove') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'op must be "add" or "remove"' } });
    }

    const messageId = body.message_id;
    const emoji = body.emoji;
    const op = body.op;

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(body.target, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    // ── Step 4: verify message belongs to the resolved channel ────────────────
    const message = await db.controlMessage.findUnique({ where: { id: messageId } });
    if (!message || message.channelId !== channelId) {
      return reply.code(404).send({
        error: { code: 'MESSAGE_NOT_IN_CHANNEL', message: 'Message not found in the specified channel' },
      });
    }

    // ── Step 5: apply reaction mutation ───────────────────────────────────────
    if (op === 'add') {
      try {
        await db.controlMessageReaction.create({
          data: {
            messageId,
            workroomId,
            reactorKind: 'agent',
            reactorId: agent.id,
            emoji,
          },
        });
      } catch (err) {
        // P2002 = unique constraint violation (duplicate reaction) → idempotent success
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Idempotent: row already exists, treat as success but do NOT emit a second event
          return reply.code(200).send({ ok: true });
        }
        throw err;
      }

      // Emit reaction.added event
      await writeReactionEventAndBroadcast({
        workroomId,
        topic: 'reaction.added',
        payload: {
          message_id: messageId,
          emoji,
          reactor_id: agent.id,
          reactor_kind: 'agent',
        },
      });
    } else {
      // op === 'remove'
      const { count } = await db.controlMessageReaction.deleteMany({
        where: {
          messageId,
          reactorId: agent.id,
          emoji,
        },
      });

      // Only emit reaction.removed when a row was actually removed. A remove of a
      // non-existent reaction is a successful API no-op (still returns ok), but it
      // must NOT broadcast — otherwise every client decrements a reaction that was
      // never there → UI drift. Mirrors how 'add' skips the event on P2002.
      if (count > 0) {
        await writeReactionEventAndBroadcast({
          workroomId,
          topic: 'reaction.removed',
          payload: {
            message_id: messageId,
            emoji,
            reactor_id: agent.id,
            reactor_kind: 'agent',
          },
        });
      }
    }

    return reply.code(200).send({ ok: true });
  });
}
