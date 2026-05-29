/**
 * preparedActionOperatorRoutes — Slice 4.2 Chunk D — OPERATOR fulfill / dismiss.
 *
 * The HUMAN operator (op_sess_) approves or dismisses an agent's PROPOSED privileged
 * action (a ControlPreparedAction created by Chunk C). The agent can NEVER reach these:
 * they are /api/v1 OPERATOR routes gated by authorizeChannelWrite (op_sess_ + command),
 * NOT /internal/agent-api. The action is executed UNDER THE OPERATOR'S identity
 * (createdBy / added_by = the human operator subject id).
 *
 *   POST /api/v1/workrooms/:wid/actions/:id/fulfill
 *   POST /api/v1/workrooms/:wid/actions/:id/dismiss
 *
 * CORRECTNESS — atomic fulfill (the whole point of this chunk):
 *   The CAS (proposed→fulfilled) + the channel core (create / add_member) run inside ONE
 *   `db.$transaction`. The first thing the tx does is FOR-UPDATE-lock the workroom row,
 *   because the cores' publishChannelEvent → publishControlEventInTx ASSUMES the caller
 *   holds that lock (Chunk A's contract; mirrors publishControlEvent.ts's no-tx lock SQL).
 *   On ANY error inside the tx the WHOLE thing rolls back → the CAS is undone → status
 *   atomically returns to 'proposed' (there is NO 'failed' enum, no revert race).
 *
 *   The WS broadcast (channel.created / channel.member_added) and the ✅ result card are
 *   emitted ONLY AFTER the tx commits — never inside it — so a rollback can never emit a
 *   phantom channel event or a misleading ✅ card.
 */

import type { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeChannelWrite } from '@/control/channels/channelRoutes';
import {
  createChannelCore,
  addMemberCore,
  broadcastChannelEvents,
  type BroadcastPayload,
} from '@/control/channels/channelCore';
import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';

// ── Typed error to propagate controlled failures out of the $transaction ─────────

type FulfillErrorCode = 'ACTION_ALREADY_RESOLVED' | 'CHANNEL_NOT_FOUND';

class FulfillError extends Error {
  constructor(public readonly httpStatus: number, public readonly code: FulfillErrorCode) {
    super(code);
    this.name = 'FulfillError';
  }
}

// ── Serialization (mirrors agentApiPreparedActions.toApi) ────────────────────────

type PreparedActionRow = NonNullable<Awaited<ReturnType<typeof db.controlPreparedAction.findUnique>>>;

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

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Best-effort summary of a prepared action for the dismiss card. No secrets. */
function summarizeAction(type: string, params: unknown): string {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  if (type === 'channel:create') {
    const name = typeof p.name === 'string' ? p.name.replace(/^#/, '') : 'channel';
    return `create channel "#${name}"`;
  }
  if (type === 'channel:add_member') {
    const channel = typeof p.channel === 'string' ? p.channel : (typeof p.channelId === 'string' ? p.channelId : 'channel');
    const member = typeof p.member_id === 'string' ? p.member_id : 'member';
    return `add ${member} to ${channel}`;
  }
  return type;
}

export async function preparedActionOperatorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/workrooms/:wid/actions/:id/fulfill
   *
   * The operator APPROVES a proposed action. Atomically (one $transaction):
   *   workroom FOR UPDATE lock → CAS proposed→fulfilled → run the core (create/add_member)
   *   on the tx client under the OPERATOR'S identity → write result fields.
   * After commit ONLY: broadcast the channel event(s) + post the ✅ result card.
   *
   * Responses:
   *   200 { ok, action }
   *   401 / 403   — op auth (authorizeChannelWrite per the action's type)
   *   404 ACTION_NOT_FOUND        — action not in :wid (or missing)
   *   404 CHANNEL_NOT_FOUND       — add_member's stored channel no longer exists (rolled back)
   *   409 ACTION_ALREADY_RESOLVED — not in 'proposed' state (already fulfilled/dismissed)
   */
  app.post('/api/v1/workrooms/:wid/actions/:id/fulfill', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    // 1. Load the action (must be in :wid). Its `type` selects the command authority.
    let action: PreparedActionRow | null;
    try {
      action = await db.controlPreparedAction.findUnique({ where: { id } });
    } catch {
      action = null; // malformed id → uniform 404
    }
    if (!action || action.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
    }
    const actionType = action.type;

    // 2. OPERATOR auth — command authority depends on the action type.
    const command = actionType === 'channel:create' ? 'create_channel' : 'manage_members';
    const actor = await authorizeChannelWrite(request, command, wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const operatorId = actor.actorId;

    // 3. ATOMIC fulfill: lock → CAS → core → result. Broadcast payloads are returned for
    //    post-commit emission. Any throw rolls back the CAS → status stays 'proposed'.
    let events: Array<BroadcastPayload | null> = [];
    let resultId: string | null = null;
    let cardText = '';
    try {
      const out = await db.$transaction(async (tx) => {
        // 3a. FOR UPDATE lock the workroom row FIRST — the cores' publishControlEventInTx
        //     ASSUMES the caller holds this lock (Chunk A contract; mirrors the no-tx path
        //     in publishControlEvent.ts).
        await tx.$queryRaw`
          SELECT id FROM control_workrooms
          WHERE id = ${wid}::uuid
          FOR UPDATE
        `;

        // 3b. CAS proposed→fulfilled. count 0 → already resolved (409).
        const cas = await tx.controlPreparedAction.updateMany({
          where: { id, workroomId: wid, status: 'proposed' },
          data: { status: 'fulfilled' },
        });
        if (cas.count === 0) {
          throw new FulfillError(409, 'ACTION_ALREADY_RESOLVED');
        }

        // 3c. Execute the core ON THE TX CLIENT under the OPERATOR'S identity.
        const params = (action!.params ?? {}) as Record<string, unknown>;
        let txEvents: Array<BroadcastPayload | null>;
        let txResultId: string | null;
        let txCardText: string;

        if (actionType === 'channel:create') {
          const name = String(params.name ?? '');
          const visibility = params.visibility === 'private' ? 'private' : 'public';
          const created = await createChannelCore({
            db: tx,
            workroomId: wid,
            actorId: operatorId,
            name,
            visibility,
          });
          txEvents = created.events;
          txResultId = created.channel.id;
          txCardText = `✅ approved: created channel "#${created.channel.name.replace(/^#/, '')}"`;
        } else {
          const channelId = String(params.channelId ?? '');
          const memberId = String(params.member_id ?? '');
          const added = await addMemberCore({
            db: tx,
            workroomId: wid,
            channelId,
            memberId,
            actorId: operatorId,
          });
          if (added.notFound) {
            // Channel vanished after prepare → 404; rolls back the CAS (status → proposed).
            throw new FulfillError(404, 'CHANNEL_NOT_FOUND');
          }
          txEvents = added.events;
          txResultId = channelId;
          const channelLabel = typeof params.channel === 'string' ? params.channel : `#${channelId}`;
          txCardText = `✅ approved: added ${memberId} to ${channelLabel}`;
        }

        // 3d. Persist the result fields on the prepared-action row.
        await tx.controlPreparedAction.update({
          where: { id },
          data: { fulfilledByOperator: operatorId, fulfilledResultId: txResultId },
        });

        return { events: txEvents, resultId: txResultId, cardText: txCardText };
      });
      events = out.events;
      resultId = out.resultId;
      cardText = out.cardText;
    } catch (err) {
      if (err instanceof FulfillError) {
        const code = err.code === 'CHANNEL_NOT_FOUND' ? 'CHANNEL_NOT_FOUND' : 'ACTION_ALREADY_RESOLVED';
        const message = err.code === 'CHANNEL_NOT_FOUND' ? 'Channel not found' : 'Action already resolved';
        return reply.code(err.httpStatus).send({ error: { code, message } });
      }
      throw err; // unexpected → 500 (tx already rolled back; status stays 'proposed')
    }

    // 4. AFTER COMMIT ONLY: broadcast the channel event(s) + post the ✅ result card.
    //    Never inside the tx — a rollback must never emit a phantom event/card.
    broadcastChannelEvents(events);

    const card = await insertSystemMessage({ workroomId: wid, channelId: action.channelId, content: cardText });
    await writeEventAndBroadcast(card);

    const updated = await db.controlPreparedAction.findUnique({ where: { id } });
    return reply.code(200).send({ ok: true, action: updated ? toApi(updated) : null, resultId });
  });

  /**
   * POST /api/v1/workrooms/:wid/actions/:id/dismiss
   *
   * The operator DISMISSES a proposed action (a lighter, non-destructive op — it executes
   * nothing). Gated by the same op_sess_ operator auth via the 'create_channel' command
   * (an operator who can approve channel actions can certainly dismiss a proposal).
   * CAS proposed→dismissed; count 0 → 409. Posts a 🚫 dismiss card.
   *
   * Responses:
   *   200 { ok }
   *   401 / 403                   — op auth
   *   404 ACTION_NOT_FOUND        — action not in :wid
   *   409 ACTION_ALREADY_RESOLVED — not in 'proposed' state
   */
  app.post('/api/v1/workrooms/:wid/actions/:id/dismiss', async (request, reply) => {
    const { wid, id } = request.params as { wid: string; id: string };

    // 1. Load the action (must be in :wid).
    let action: PreparedActionRow | null;
    try {
      action = await db.controlPreparedAction.findUnique({ where: { id } });
    } catch {
      action = null;
    }
    if (!action || action.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
    }

    // 2. OPERATOR auth — dismissing is non-destructive; reuse 'create_channel' (an operator
    //    who holds channel-write authority is entitled to dismiss a proposal).
    const actor = await authorizeChannelWrite(request, 'create_channel', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    // 3. CAS proposed→dismissed. count 0 → already resolved (409). No core, no broadcast.
    const cas = await db.controlPreparedAction.updateMany({
      where: { id, workroomId: wid, status: 'proposed' },
      data: { status: 'dismissed' },
    });
    if (cas.count === 0) {
      return reply.code(409).send({ error: { code: 'ACTION_ALREADY_RESOLVED', message: 'Action already resolved' } });
    }

    // 4. Post a 🚫 dismiss card in the card's channel (message.created chain).
    const summary = summarizeAction(action.type, action.params);
    const card = await insertSystemMessage({
      workroomId: wid,
      channelId: action.channelId,
      content: `🚫 dismissed: ${summary}`,
    });
    await writeEventAndBroadcast(card);

    return reply.code(200).send({ ok: true });
  });
}
