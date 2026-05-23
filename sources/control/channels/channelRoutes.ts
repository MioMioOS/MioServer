/**
 * Channel API — control plane (S1 Chunk 2)
 *
 * Endpoints:
 *   GET /api/v1/workrooms/:wid/channels
 *     Returns the real ControlChannel list for a workroom, replacing the synthetic
 *     'main' placeholder in workroomRoutes.ts.
 *
 * Contract (§4.1 spec):
 *   { workroom_id, channels: [{ id, name, type, visibility, last_activity_at,
 *                                unread_count, attention_count, member_count }] }
 *
 * Visibility: public channels are visible to all; private/dm only to members.
 * unread_count: always 0 in S1 (real read-cursor arrives in S5).
 * attention_count: needs_human actions + pending approvals, scoped to workroom
 *   (per-channel is fine since only main exists in S1; channel-level scoping is wired
 *    correctly here so S6 multi-channel work needs only a WHERE clause change).
 * member_count: count of ControlChannelMember rows for the channel.
 *
 * Auth: dual-read via authorizeControlRead (machine_token OR dev_control_token).
 *       machine mode: also enforces org/workroom access via requireMachineAccessToWorkroom.
 *       dev mode: authorizeControlRead already enforced allowlist + workroom scope.
 */

import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { visibleChannels } from '@/control/channels/channelVisibility';

export async function channelRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/workrooms/:wid/channels
   *
   * Returns all non-archived channels visible to the caller for the given workroom.
   * Per-channel derived fields: last_activity_at, unread_count (0), attention_count,
   * member_count.
   *
   * #192 replacement: the synthetic 'main' channel handler is REMOVED from workroomRoutes.ts
   * and this handler takes over.
   */
  app.get('/api/v1/workrooms/:wid/channels', async (request, reply) => {
    // Dual-auth: machine_token (full) OR dev_control_token (read-only, allowlist + workroom-scope).
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { wid } = request.params as { wid: string };

    // machine mode: enforce org/workroom access.
    // dev mode: path was already scoped by authorizeControlRead (workroom_id in token = :wid).
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, wid);
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    // Verify the workroom exists and is not archived.
    const workroom = await db.controlWorkroom.findUnique({
      where: { id: wid },
      select: { id: true, archivedAt: true },
    });
    if (!workroom || workroom.archivedAt !== null) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    // Fetch channels visible to this viewer.
    const channels = await visibleChannels(auth, wid);

    if (channels.length === 0) {
      return { workroom_id: wid, channels: [] };
    }

    const channelIds = channels.map((c) => c.id);

    // Compute attention_count and member_count for each channel in batch.
    // attention_count = needs_human actions + pending approvals (per channel's workroom scope).
    // In S1 only the main channel exists, so all workroom-level counts map to channel_id=main.
    // For correctness we scope by workroomId (all channels in the workroom share the same
    // workroom-level actions/approvals in S1); per-message/per-channel scoping is S3+.
    const [needsHumanActions, pendingApprovals, memberCounts] = await Promise.all([
      db.controlAction.count({ where: { workroomId: wid, status: 'needs_human' } }),
      db.controlApproval.count({ where: { workroomId: wid, status: 'pending' } }),
      db.controlChannelMember.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds } },
        _count: { channelId: true },
      }),
    ]);

    // Build a lookup from channelId → member_count.
    const memberCountMap = new Map<string, number>(
      memberCounts.map((row) => [row.channelId, row._count.channelId]),
    );

    // Build a lookup from channelId → attention_count.
    // S1: all attention comes from workroom level; attribute it all to whichever channel
    // the attention items logically belong to. Since only main exists in S1 this is fine.
    // For multi-channel (S3+) this will be replaced with per-channel queries.
    const totalAttention = needsHumanActions + pendingApprovals;

    const responseChannels = channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      visibility: ch.visibility,
      last_activity_at: ch.lastActivityAt?.toISOString() ?? null,
      unread_count: 0,
      attention_count: totalAttention,
      member_count: memberCountMap.get(ch.id) ?? 0,
    }));

    return {
      workroom_id: wid,
      channels: responseChannels,
    };
  });
}
