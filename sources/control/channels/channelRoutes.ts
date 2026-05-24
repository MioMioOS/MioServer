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

import { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { visibleChannels } from '@/control/channels/channelVisibility';
import { authorizeOperatorWrite } from '@/control/operatorSessions/operatorSessionAuth';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

/**
 * Resolved actor for a channel WRITE: who is doing the write, and the workroom
 * confirmed in-scope. dev_ctl_ is hard-rejected (403) by callers before this runs.
 */
type WriteActor =
  | { ok: true; actorId: string }
  | { ok: false; status: number; body: { error: { code: string; message: string } } };

/**
 * Authorize a channel WRITE request: op_sess_(command) OR machine_token. dev_ctl_ → 403.
 *
 * Mirrors messageRoutes.ts ordering:
 *   1. dev_ctl_ prefix → hard 403 (defense-in-depth; op-auth also rejects it).
 *   2. op_sess_ with the required command + workroom scope → actorId = operatorSubjectId.
 *   3. op_sess_ valid-but-wrong-scope (403) → hard reject (do NOT fall through to machine).
 *   4. machine_token + requireMachineAccessToWorkroom → actorId = machine.id.
 *   5. neither → 401.
 */
async function authorizeChannelWrite(
  request: FastifyRequest,
  command: 'create_channel' | 'manage_members',
  workroomId: string,
): Promise<WriteActor> {
  const authHeader = request.headers.authorization;

  // 1. dev_ctl_ → hard 403.
  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (rawToken.startsWith('dev_ctl_')) {
    return { ok: false, status: 403, body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } } };
  }

  // 2/3. op_sess_ path.
  const opAuth = await authorizeOperatorWrite(request, { command, workroomId });
  if (opAuth.ok) {
    return { ok: true, actorId: opAuth.session.operatorSubjectId };
  }
  // valid op_sess_ token, wrong command/workroom → hard 403 (do not fall through).
  if (opAuth.status === 403) {
    return { ok: false, status: 403, body: { error: { code: opAuth.code, message: opAuth.message } } };
  }

  // 4. machine_token path.
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } } };
  }
  const access = await requireMachineAccessToWorkroom(machine, workroomId);
  if (!access.ok) {
    return { ok: false, status: access.status, body: { error: access.error } };
  }
  return { ok: true, actorId: machine.id };
}

/** member_count for a single channel (used to mirror the GET-channels item shape). */
async function channelMemberCount(channelId: string): Promise<number> {
  return db.controlChannelMember.count({ where: { channelId } });
}

/**
 * Persist + broadcast a control-plane channel event (write-before-broadcast).
 * Step 1 (awaited): publishControlEvent writes the event row.
 * Step 2 (fire-and-forget): WS broadcast. Non-fatal; clients catch up via GET /events.
 */
async function writeChannelEventAndBroadcast(
  workroomId: string,
  topic: 'channel.created' | 'channel.member_added' | 'channel.member_removed',
  payload: Record<string, unknown>,
): Promise<void> {
  const event = await publishControlEvent({ workroomId, eventId: randomUUID(), topic, payload });
  if (!event.idempotent) {
    workroomBroadcaster.broadcast(workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
  }
}

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

  /**
   * POST /api/v1/workrooms/:wid/channels  (S6)
   *
   * Create a 'standard' channel. Auth: op_sess_('create_channel') OR machine_token; dev_ctl_ → 403.
   *
   * Body: { name: string, description?: string, visibility: 'public'|'private', member_ids?: string[] }
   *   name        — required, non-empty (trimmed). Empty → 400.
   *   description — optional, default ''.
   *   visibility  — 'public' | 'private' (anything else → 400).
   *   member_ids  — optional extra members; the creator is ALWAYS added too.
   *
   * Members: createdBy (op subject or machine id) + each member_id, deduped. Dupes are
   * skipped via the @@unique([channelId, memberId]) (createMany skipDuplicates).
   *
   * Publishes 'channel.created'. Returns the SAME wire shape as a GET /channels item
   * (id, name, type, visibility, last_activity_at, unread_count, attention_count, member_count).
   */
  app.post('/api/v1/workrooms/:wid/channels', async (request, reply) => {
    const { wid } = request.params as { wid: string };

    const actor = await authorizeChannelWrite(request, 'create_channel', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const body = request.body as {
      name?: unknown;
      description?: unknown;
      visibility?: unknown;
      member_ids?: unknown;
    } | null;

    // Validate name (non-empty after trim).
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return reply.code(400).send({ error: { code: 'INVALID_NAME', message: 'name is required' } });
    }

    // Validate visibility.
    const visibility = body?.visibility;
    if (visibility !== 'public' && visibility !== 'private') {
      return reply.code(400).send({ error: { code: 'INVALID_VISIBILITY', message: "visibility must be 'public' or 'private'" } });
    }

    const description = typeof body?.description === 'string' ? body.description : '';

    // Build the deduped member set: creator + provided member_ids.
    const memberIds = Array.isArray(body?.member_ids)
      ? (body!.member_ids as unknown[]).filter((m): m is string => typeof m === 'string' && m.length > 0)
      : [];
    const memberSet = new Set<string>([actor.actorId, ...memberIds]);

    const now = new Date();
    const channel = await db.controlChannel.create({
      data: {
        workroomId: wid,
        name,
        type: 'standard',
        visibility,
        description,
        createdBy: actor.actorId,
        lastActivityAt: now,
      },
    });

    // Add member rows. skipDuplicates guards the @@unique (defensive; the Set already deduped).
    await db.controlChannelMember.createMany({
      data: [...memberSet].map((memberId) => ({ channelId: channel.id, memberId })),
      skipDuplicates: true,
    });

    const memberCount = await channelMemberCount(channel.id);

    await writeChannelEventAndBroadcast(wid, 'channel.created', {
      channel_id: channel.id,
      name: channel.name,
      type: channel.type,
      visibility: channel.visibility,
      created_by: actor.actorId,
      member_count: memberCount,
    });

    // Mirror the GET /channels item wire shape.
    return reply.code(201).send({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      visibility: channel.visibility,
      last_activity_at: channel.lastActivityAt?.toISOString() ?? null,
      unread_count: 0,
      attention_count: 0,
      member_count: memberCount,
    });
  });

  /**
   * POST /api/v1/workrooms/:wid/channels/:cid/members  (S6)
   *
   * Add a member (idempotent). Auth: op_sess_('manage_members') OR machine; dev_ctl_ → 403.
   * Validates the channel belongs to :wid (404 otherwise — covers cross-workroom + missing).
   * If the member row already exists → 200 no-op (no duplicate event).
   * Publishes 'channel.member_added' on a real insert. Returns { ok: true }.
   */
  app.post('/api/v1/workrooms/:wid/channels/:cid/members', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };

    const actor = await authorizeChannelWrite(request, 'manage_members', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    const body = request.body as { member_id?: unknown } | null;
    const memberId = typeof body?.member_id === 'string' ? body.member_id.trim() : '';
    if (!memberId) {
      return reply.code(400).send({ error: { code: 'INVALID_MEMBER_ID', message: 'member_id is required' } });
    }

    // Validate channel ∈ workroom (404 covers both missing channel and cross-workroom).
    const channel = await db.controlChannel.findUnique({ where: { id: cid }, select: { workroomId: true } });
    if (!channel || channel.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    // Idempotent insert: P2002 (unique) → already a member → no-op, no event.
    try {
      await db.controlChannelMember.create({ data: { channelId: cid, memberId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.send({ ok: true });
      }
      throw err;
    }

    await writeChannelEventAndBroadcast(wid, 'channel.member_added', {
      channel_id: cid,
      member_id: memberId,
      added_by: actor.actorId,
    });

    return reply.send({ ok: true });
  });

  /**
   * DELETE /api/v1/workrooms/:wid/channels/:cid/members/:memberId  (S6)
   *
   * Remove a member (idempotent). Auth: op_sess_('manage_members') OR machine; dev_ctl_ → 403.
   * Validates the channel belongs to :wid (404 otherwise).
   * Missing member row → 200 no-op (no event). Publishes 'channel.member_removed' on a real delete.
   * Returns { ok: true }.
   */
  app.delete('/api/v1/workrooms/:wid/channels/:cid/members/:memberId', async (request, reply) => {
    const { wid, cid, memberId } = request.params as { wid: string; cid: string; memberId: string };

    const actor = await authorizeChannelWrite(request, 'manage_members', wid);
    if (!actor.ok) return reply.code(actor.status).send(actor.body);

    // Validate channel ∈ workroom (404 covers both missing channel and cross-workroom).
    const channel = await db.controlChannel.findUnique({ where: { id: cid }, select: { workroomId: true } });
    if (!channel || channel.workroomId !== wid) {
      return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    }

    // Idempotent delete: deleteMany returns count 0 when the row is absent → no-op, no event.
    const result = await db.controlChannelMember.deleteMany({ where: { channelId: cid, memberId } });
    if (result.count === 0) {
      return reply.send({ ok: true });
    }

    await writeChannelEventAndBroadcast(wid, 'channel.member_removed', {
      channel_id: cid,
      member_id: memberId,
      removed_by: actor.actorId,
    });

    return reply.send({ ok: true });
  });
}
