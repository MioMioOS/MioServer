/**
 * publishControlEvent — SINGLE write path for all EventLog inserts.
 *
 * ALL code that emits control plane events MUST call this function.
 * Direct `db.controlEventLog.create()` calls are forbidden (bypass the seq gate).
 *
 * Guarantees:
 * 1. Seq allocation is atomic: FOR UPDATE on workroom row serializes concurrent
 *    publishes; COALESCE(MAX(seq),0)+1 computed inside the same transaction.
 * 2. UNIQUE(workroom_id, seq) is a DB-level backstop against any race.
 * 3. event_id @unique enables idempotent retries (same event_id → no-op, returns existing).
 * 4. Write-before-broadcast: the event is persisted before this function returns.
 *    WS fanout is the caller's responsibility (post-commit).
 *
 * Usage inside a Prisma transaction (pass the tx client):
 *   const event = await publishControlEvent(tx, workroomId, eventId, topic, payload);
 *
 * Usage outside a transaction (creates its own):
 *   const event = await publishControlEvent(db, workroomId, eventId, topic, payload);
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

/**
 * Publish a single event inside an existing Prisma transaction.
 * Use this when you need to emit an event as part of a larger atomic operation
 * (e.g., action fire also emits action.fired event).
 *
 * The caller MUST be inside a $transaction that has already locked the workroom row:
 *   await tx.$queryRaw`SELECT id FROM control_workrooms WHERE id = ${wid}::uuid FOR UPDATE`
 *
 * If you cannot guarantee the lock is held, use publishControlEventStandalone instead.
 */
export async function publishControlEventInTx(
  tx: TxClient,
  input: ControlEventInput,
): Promise<ControlEventResult> {
  const { workroomId, eventId, topic, payload } = input;

  // Check idempotency first (before computing seq)
  const existing = await tx.controlEventLog.findFirst({ where: { eventId } });
  if (existing) {
    return {
      id: existing.id,
      eventId: existing.eventId,
      workroomId: existing.workroomId,
      seq: existing.seq.toString(),
      topic: existing.topic,
      payloadJson: existing.payloadJson,
      createdAt: existing.createdAt,
      idempotent: true,
    };
  }

  // Compute next seq (caller must hold FOR UPDATE on workroom row)
  const seqResult = await tx.$queryRaw<[{ next_seq: bigint }]>`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
    FROM control_event_logs
    WHERE workroom_id = ${workroomId}::uuid
  `;
  const nextSeq = seqResult[0].next_seq;

  const created = await tx.controlEventLog.create({
    data: {
      workroomId,
      seq: nextSeq,
      eventId,
      topic,
      payloadJson: payload as Prisma.InputJsonObject,
    },
  });

  return {
    id: created.id,
    eventId: created.eventId,
    workroomId: created.workroomId,
    seq: created.seq.toString(),
    topic: created.topic,
    payloadJson: created.payloadJson,
    createdAt: created.createdAt,
    idempotent: false,
  };
}

/**
 * Publish a single event with its own transaction + workroom row lock.
 * Use this for standalone event publishing (HTTP endpoint, background jobs).
 *
 * Handles idempotency via event_id @unique:
 * If a P2002 (unique violation) occurs on either seq or event_id, the existing
 * event is fetched and returned with idempotent=true.
 */
export async function publishControlEvent(input: ControlEventInput): Promise<ControlEventResult> {
  const { workroomId, eventId, topic, payload } = input;

  try {
    const result = await db.$transaction(async (tx) => {
      // Lock workroom row to serialize seq allocation for this workroom
      await tx.$queryRaw`
        SELECT id FROM control_workrooms
        WHERE id = ${workroomId}::uuid
        FOR UPDATE
      `;
      return publishControlEventInTx(tx, { workroomId, eventId, topic, payload });
    });
    return result;
  } catch (err) {
    // P2002: event_id or (workroom_id, seq) unique violation — return existing
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await db.controlEventLog.findFirst({ where: { eventId } });
      if (existing) {
        return {
          id: existing.id,
          eventId: existing.eventId,
          workroomId: existing.workroomId,
          seq: existing.seq.toString(),
          topic: existing.topic,
          payloadJson: existing.payloadJson,
          createdAt: existing.createdAt,
          idempotent: true,
        };
      }
    }
    throw err;
  }
}
