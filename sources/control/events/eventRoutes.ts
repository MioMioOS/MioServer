/**
 * EventLog API — write-before-broadcast + catch-up protocol
 *
 * HARD POINTS:
 *
 * 1. Write-before-broadcast (POST /events)
 *    All events are persisted to DB BEFORE any WS fanout.
 *    Seq allocation uses workroom row lock → MAX(seq)+1 inside a transaction.
 *    UNIQUE(workroom_id, seq) is the DB-level backstop against races.
 *    event_id is a client-provided dedup key (@unique) — idempotent retries
 *    return the existing event as a 200 no-op.
 *
 * 2. Catch-up protocol (GET /events?after_seq=N)
 *    Client reconnects with last_seen_seq → server returns delta events.
 *    If events_behind > MAX_CATCH_UP_EVENTS: returns { seq_expired: true }
 *    → client must reload a full snapshot instead.
 *
 * 3. ClientCursor (PATCH /cursors)
 *    Upsert per (user_id, device_id, scope_type, scope_id, topic_group).
 *    apply_seq: highest seq delivered and applied on device.
 *    read_seq: highest seq the human has visibly read (drives unread badge).
 *
 * Endpoints:
 *   POST  /api/v1/workrooms/:workroomId/events             → publish event (write-before-broadcast)
 *   GET   /api/v1/workrooms/:workroomId/events             → catch-up: ?after_seq=N&limit=N
 *   GET   /api/v1/workrooms/:workroomId/events/head        → current max seq for a workroom
 *   PATCH /api/v1/cursors                                  → upsert client cursor (apply_seq / read_seq)
 *   GET   /api/v1/cursors                                  → get cursor: ?user_id=X&device_id=Y&scope_type=Z&scope_id=W
 */

import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { publishControlEvent } from './publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

/** Max events to return in a single catch-up response before issuing seq_expired. */
const MAX_CATCH_UP_EVENTS = 500;

export async function eventRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/workrooms/:workroomId/events
   *
   * *** HARD POINT: Write-before-broadcast ***
   *
   * Seq allocation algorithm (inside Prisma $transaction):
   *   1. SELECT ... FOR UPDATE on workroom row → serialize seq allocation
   *   2. SELECT COALESCE(MAX(seq), 0) + 1 as next_seq from event_logs WHERE workroom_id = X
   *   3. INSERT event_log with next_seq
   *
   * The UNIQUE(workroom_id, seq) constraint is the backstop: if two transactions
   * somehow compute the same seq (extremely unlikely with row lock), one INSERT
   * fails with P2002 and the caller retries with a new event_id.
   *
   * Idempotency: event_id is @unique. Retried publishes with the same event_id
   * return the existing event as 200 { idempotent: true }.
   *
   * WS fanout: TODO — implement after WS gateway. Write-before-broadcast
   * contract is satisfied: DB write commits before this handler returns.
   * Fanout can happen here (post-commit) or via a DB trigger/polling loop.
   *
   * Body: { event_id, topic, payload, publisher_session_id? }
   */
  app.post('/api/v1/workrooms/:workroomId/events', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
    const body = request.body as {
      event_id: string;     // client dedup key — stable across retries
      topic: string;
      payload: Record<string, unknown>;
      publisher_session_id?: string;
    };

    if (!body.event_id || !body.topic || !body.payload) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'event_id, topic, payload are required' } });
    }

    // Delegate to the single enforced publish path (FOR UPDATE + seq alloc + INSERT).
    // All event writes in the codebase MUST go through publishControlEvent().
    // Direct db.controlEventLog.create() calls break the seq guarantee.
    const event = await publishControlEvent({
      workroomId,
      eventId: body.event_id,
      topic: body.topic,
      payload: body.payload,
    });

    // WS fanout — broadcast to all workroom subscribers AFTER DB commit.
    // Write-before-broadcast contract: event is already in DB before we reach here.
    // Fanout failure is non-fatal (logged, not thrown). Clients catch up via GET /events?after_seq=N.
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

    return reply.code(event.idempotent ? 200 : 201).send({
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq,
      topic: event.topic,
      created_at: event.createdAt.toISOString(),
      ...(event.idempotent ? { idempotent: true } : {}),
    });
  });

  /**
   * GET /api/v1/workrooms/:workroomId/events
   *
   * *** HARD POINT: Catch-up protocol ***
   *
   * Client sends last_seen_seq after reconnect.
   * Server returns delta events with seq > last_seen_seq, ordered ASC.
   *
   * If events_behind > MAX_CATCH_UP_EVENTS (500):
   *   → { seq_expired: true, current_max_seq: N }
   *   → Client must reload a full snapshot (workroom summary + current pointers)
   *
   * seq_expired is true when:
   *   (a) events_behind > MAX_CATCH_UP_EVENTS (too many missed — volume), OR
   *   (b) after_seq + 1 < min_retained_seq (prune gap — events between after_seq and
   *       min_retained_seq were deleted by the retention policy, causing a silent hole)
   *
   * Both conditions must be checked. Condition (a) alone allows silent data loss when
   * after_seq is in a pruned range but events_behind happens to be ≤ 500.
   *
   * Query params:
   *   after_seq  — exclusive lower bound (last seq client has applied). 0 = start of time.
   *   limit      — max events to return (capped at MAX_CATCH_UP_EVENTS)
   *   topic      — optional filter by topic prefix
   */
  app.get('/api/v1/workrooms/:workroomId/events', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
    const query = request.query as {
      after_seq?: string;
      limit?: string;
      topic?: string;
    };

    // Safe BigInt parsing — reject non-integer strings before BigInt() throws
    const afterSeqRaw = query.after_seq ?? '0';
    if (!/^\d+$/.test(afterSeqRaw)) {
      return reply.code(400).send({ error: { code: 'INVALID_AFTER_SEQ', message: 'after_seq must be a non-negative integer' } });
    }
    const afterSeq = BigInt(afterSeqRaw);
    const requestedLimit = query.limit ? Math.min(parseInt(query.limit, 10), MAX_CATCH_UP_EVENTS) : MAX_CATCH_UP_EVENTS;

    // Fetch min_retained_seq, max_seq, and events_behind in one query.
    // This avoids loading event bodies just to decide whether to expire.
    const [bounds] = await db.$queryRaw<[{
      min_seq: bigint | null;
      max_seq: bigint | null;
      events_behind: bigint;
    }]>`
      SELECT
        MIN(seq)                                        AS min_seq,
        MAX(seq)                                        AS max_seq,
        COUNT(*) FILTER (WHERE seq > ${afterSeq})       AS events_behind
      FROM control_event_logs
      WHERE workroom_id = ${workroomId}::uuid
    `;

    const minRetained = bounds.min_seq;
    const maxSeq = bounds.max_seq;
    const eventsBehind = Number(bounds.events_behind);

    // ── seq_expired condition (a): too many events behind (volume) ──
    const tooManyBehind = eventsBehind > MAX_CATCH_UP_EVENTS;

    // ── seq_expired condition (b): prune gap ──
    // If after_seq + 1 < min_retained_seq, there are pruned events between the
    // client's position and the earliest event we still have. The client would
    // silently miss those events if we returned a delta from min_retained onward.
    // after_seq = 0: client has seen nothing → no prune gap expectation.
    const prunedGap = afterSeq > 0n && minRetained !== null && (afterSeq + 1n < minRetained);

    if (tooManyBehind || prunedGap) {
      return reply.code(200).send({
        seq_expired: true,
        events_behind: eventsBehind,
        current_max_seq: maxSeq?.toString() ?? '0',
        min_retained_seq: minRetained?.toString() ?? null,
        reason: prunedGap ? 'prune_gap' : 'too_many_behind',
        message: prunedGap
          ? `Prune gap detected: after_seq=${afterSeq} is before min_retained_seq=${minRetained}. Reload snapshot.`
          : `Too many events missed (${eventsBehind} > ${MAX_CATCH_UP_EVENTS}). Reload snapshot.`,
      });
    }

    // Safe: no prune gap, events_behind ≤ 500 → return delta
    const events = await db.controlEventLog.findMany({
      where: {
        workroomId,
        seq: { gt: afterSeq },
        ...(query.topic ? { topic: { startsWith: query.topic } } : {}),
      },
      orderBy: { seq: 'asc' },
      take: requestedLimit,
    });

    return {
      seq_expired: false,
      events_behind: eventsBehind,
      min_retained_seq: minRetained?.toString() ?? null,
      events: events.map((e) => ({
        event_id: e.eventId,
        workroom_id: e.workroomId,
        seq: e.seq.toString(),
        topic: e.topic,
        payload: e.payloadJson,
        created_at: e.createdAt.toISOString(),
      })),
      last_seq: events.length > 0 ? events[events.length - 1].seq.toString() : afterSeq.toString(),
    };
  });

  /**
   * GET /api/v1/workrooms/:workroomId/events/head
   * Returns current max seq for a workroom without fetching event bodies.
   * Used by client on initial connect to establish baseline.
   */
  app.get('/api/v1/workrooms/:workroomId/events/head', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };

    const [{ max_seq }] = await db.$queryRaw<[{ max_seq: bigint | null }]>`
      SELECT MAX(seq) AS max_seq
      FROM control_event_logs
      WHERE workroom_id = ${workroomId}::uuid
    `;

    return {
      workroom_id: workroomId,
      max_seq: max_seq?.toString() ?? '0',
    };
  });

  /**
   * PATCH /api/v1/cursors
   * Upsert a client cursor — update apply_seq and/or read_seq.
   * Enforces monotonicity: apply_seq and read_seq can only move forward.
   * One row per (user_id, device_id, scope_type, scope_id, topic_group).
   */
  app.patch('/api/v1/cursors', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const body = request.body as {
      user_id: string;
      device_id: string;
      scope_type: string;
      scope_id: string;
      topic_group?: string;
      apply_seq?: string;  // BigInt as string (JSON safe)
      read_seq?: string;
    };

    if (!body.user_id || !body.device_id || !body.scope_type || !body.scope_id) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'user_id, device_id, scope_type, scope_id required' } });
    }

    const topicGroup = body.topic_group ?? 'all';

    // Safe BigInt parsing — reject non-integer strings
    if (body.apply_seq !== undefined && !/^\d+$/.test(body.apply_seq)) {
      return reply.code(400).send({ error: { code: 'INVALID_SEQ', message: 'apply_seq must be a non-negative integer' } });
    }
    if (body.read_seq !== undefined && !/^\d+$/.test(body.read_seq)) {
      return reply.code(400).send({ error: { code: 'INVALID_SEQ', message: 'read_seq must be a non-negative integer' } });
    }
    const newApplySeq = body.apply_seq !== undefined ? BigInt(body.apply_seq) : undefined;
    const newReadSeq = body.read_seq !== undefined ? BigInt(body.read_seq) : undefined;

    // Upsert with monotonic enforcement:
    // Only update if the new seq is GREATER than the stored one.
    // Raw SQL ensures atomicity — no read-then-write.
    if (newApplySeq !== undefined || newReadSeq !== undefined) {
      await db.$queryRaw`
        INSERT INTO control_client_cursors
          (id, user_id, device_id, scope_type, scope_id, topic_group, apply_seq, read_seq, updated_at)
        VALUES
          (gen_random_uuid(), ${body.user_id}, ${body.device_id}, ${body.scope_type}, ${body.scope_id},
           ${topicGroup},
           ${newApplySeq ?? 0n},
           ${newReadSeq ?? 0n},
           NOW())
        ON CONFLICT (user_id, device_id, scope_type, scope_id, topic_group)
        DO UPDATE SET
          apply_seq = GREATEST(control_client_cursors.apply_seq, EXCLUDED.apply_seq),
          read_seq  = GREATEST(control_client_cursors.read_seq,  EXCLUDED.read_seq),
          updated_at = NOW()
      `;
    }

    const cursor = await db.controlClientCursor.findUnique({
      where: {
        userId_deviceId_scopeType_scopeId_topicGroup: {
          userId: body.user_id,
          deviceId: body.device_id,
          scopeType: body.scope_type,
          scopeId: body.scope_id,
          topicGroup,
        },
      },
    });

    return {
      user_id: body.user_id,
      device_id: body.device_id,
      scope_type: body.scope_type,
      scope_id: body.scope_id,
      topic_group: topicGroup,
      apply_seq: cursor?.applySeq.toString() ?? '0',
      read_seq: cursor?.readSeq.toString() ?? '0',
      updated_at: cursor?.updatedAt.toISOString(),
    };
  });

  /**
   * GET /api/v1/cursors
   * Fetch a client cursor state.
   */
  app.get('/api/v1/cursors', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const query = request.query as {
      user_id: string;
      device_id: string;
      scope_type: string;
      scope_id: string;
      topic_group?: string;
    };

    if (!query.user_id || !query.device_id || !query.scope_type || !query.scope_id) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'user_id, device_id, scope_type, scope_id required' } });
    }

    const cursor = await db.controlClientCursor.findUnique({
      where: {
        userId_deviceId_scopeType_scopeId_topicGroup: {
          userId: query.user_id,
          deviceId: query.device_id,
          scopeType: query.scope_type,
          scopeId: query.scope_id,
          topicGroup: query.topic_group ?? 'all',
        },
      },
    });

    if (!cursor) {
      return reply.code(404).send({ error: { code: 'CURSOR_NOT_FOUND', message: 'No cursor found for these coordinates' } });
    }

    return {
      user_id: cursor.userId,
      device_id: cursor.deviceId,
      scope_type: cursor.scopeType,
      scope_id: cursor.scopeId,
      topic_group: cursor.topicGroup,
      apply_seq: cursor.applySeq.toString(),
      read_seq: cursor.readSeq.toString(),
      updated_at: cursor.updatedAt.toISOString(),
    };
  });
}
