/**
 * publishControlEvent — SINGLE write path for all EventLog inserts.
 *
 * ALL code that emits control plane events MUST call this function.
 * Direct `db.controlEventLog.create()` calls are forbidden (bypass the seq gate).
 *
 * Guarantees:
 * 1. Seq allocation is atomic AND ordered with commit visibility: the allocation
 *    UPDATE takes the workroom row lock, which is then held until the enclosing
 *    transaction commits — so commit order == seq order and a catch-up reader's
 *    `seq > cursor` can never skip an event that commits late. (This ordering is
 *    load-bearing; a free-running sequence would reintroduce the missed-event race.)
 * 2. Allocation is `UPDATE control_workrooms SET event_seq = event_seq + 1` —
 *    a single-row indexed update. The previous design ran SELECT MAX(seq) over
 *    control_event_logs INSIDE the lock, so the critical section grew with event
 *    volume and convoyed every publisher in the workroom, each waiter pinning a
 *    pool connection (2026-06-12 pool-stability work).
 * 3. UNIQUE(workroom_id, seq) is a DB-level backstop against any race.
 * 4. event_id @unique enables idempotent retries (same event_id → no-op, returns existing).
 * 5. Write-before-broadcast: the event is persisted before this function returns.
 *    WS fanout is the caller's responsibility (post-commit).
 *
 * Usage inside a Prisma transaction (pass the tx client):
 *   const event = await publishControlEventInTx(tx, { workroomId, eventId, topic, payload });
 *
 * Usage outside a transaction (creates its own):
 *   const event = await publishControlEvent({ workroomId, eventId, topic, payload });
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { db } from '@/storage/db';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

export interface ControlEventInput {
  workroomId: string;
  eventId: string;      // stable dedup key — same across retries
  topic: string;
  payload: Record<string, unknown>;
}

export interface ControlEventResult {
  id: string;
  eventId: string;
  workroomId: string;
  seq: string;           // BigInt as string (JSON-safe)
  topic: string;
  payloadJson: Prisma.JsonValue;
  createdAt: Date;
  idempotent: boolean;   // true if event_id already existed
}

function toResult(row: {
  id: string; eventId: string; workroomId: string; seq: bigint;
  topic: string; payloadJson: Prisma.JsonValue; createdAt: Date;
}, idempotent: boolean): ControlEventResult {
  return {
    id: row.id,
    eventId: row.eventId,
    workroomId: row.workroomId,
    seq: row.seq.toString(),
    topic: row.topic,
    payloadJson: row.payloadJson,
    createdAt: row.createdAt,
    idempotent,
  };
}

/**
 * Allocate the next event seq for a workroom: one self-healing UPDATE that takes
 * the workroom row lock (held until the enclosing tx commits — the ordering
 * guarantee) and clamps the counter to MAX(seq) of existing rows (index-only
 * O(log n)) so out-of-band inserts can never cause a collision.
 */
async function allocateEventSeq(tx: TxClient, workroomId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<[{ event_seq: bigint }] | []>`
    UPDATE control_workrooms w
    SET event_seq = GREATEST(
          w.event_seq,
          COALESCE((SELECT MAX(e.seq) FROM control_event_logs e WHERE e.workroom_id = w.id), 0)
        ) + 1
    WHERE w.id = ${workroomId}::uuid
    RETURNING event_seq
  `;
  if (!rows.length) {
    throw new Error(`publishControlEvent: workroom ${workroomId} not found`);
  }
  return rows[0].event_seq;
}

/**
 * Publish a single event inside an existing Prisma transaction.
 * Use this when you need to emit an event as part of a larger atomic operation
 * (e.g., a message write that also emits message.created).
 *
 * The allocation UPDATE itself takes the workroom row lock (held until the
 * caller's transaction commits) — callers no longer need a separate
 * `SELECT ... FOR UPDATE` first, though issuing one remains harmless.
 */
export async function publishControlEventInTx(
  tx: TxClient,
  input: ControlEventInput,
): Promise<ControlEventResult> {
  const { workroomId, eventId, topic, payload } = input;

  // Check idempotency first (before allocating a seq — a replayed event must
  // not burn a counter slot or take the workroom lock for nothing).
  const existing = await tx.controlEventLog.findFirst({ where: { eventId } });
  if (existing) return toResult(existing, true);

  // Allocate: single-row UPDATE; row lock is held from here to caller commit,
  // which is exactly the ordering guarantee catch-up readers rely on.
  // Self-healing: clamped to MAX(seq) so out-of-band event inserts (fixtures,
  // backfills) can never make the counter hand out a colliding seq.
  const nextSeq = await allocateEventSeq(tx, workroomId);

  const created = await tx.controlEventLog.create({
    data: {
      workroomId,
      seq: nextSeq,
      eventId,
      topic,
      payloadJson: payload as Prisma.InputJsonObject,
    },
  });

  return toResult(created, false);
}

/**
 * Publish a single event with its own (minimal) transaction.
 * Use this for standalone event publishing (HTTP endpoint, background jobs).
 *
 * The idempotency pre-check runs OUTSIDE the transaction so the workroom row
 * lock window is just allocation + insert (two fast indexed statements).
 *
 * Handles idempotency via event_id @unique:
 * If a P2002 (unique violation) occurs on either seq or event_id, the existing
 * event is fetched and returned with idempotent=true.
 */
export async function publishControlEvent(input: ControlEventInput): Promise<ControlEventResult> {
  const { workroomId, eventId, topic, payload } = input;

  // Idempotency fast-path before touching the lock at all.
  const existing = await db.controlEventLog.findFirst({ where: { eventId } });
  if (existing) return toResult(existing, true);

  try {
    const result = await db.$transaction(async (tx) => {
      const nextSeq = await allocateEventSeq(tx, workroomId);
      const created = await tx.controlEventLog.create({
        data: {
          workroomId,
          seq: nextSeq,
          eventId,
          topic,
          payloadJson: payload as Prisma.InputJsonObject,
        },
      });
      return toResult(created, false);
    });
    return result;
  } catch (err) {
    // P2002: event_id unique violation — a concurrent publish of the SAME
    // event_id won the race between our pre-check and the insert. Return it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const raced = await db.controlEventLog.findFirst({ where: { eventId } });
      if (raced) return toResult(raced, true);
    }
    throw err;
  }
}
