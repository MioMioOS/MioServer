/**
 * #88 Operator Write — Command Transaction Helper
 *
 * Executes an operator write command as a single atomic DB transaction:
 *   1. State mutation on control_actions (operatorAcknowledgedAt / operatorReviewedAt)
 *   2. INSERT to control_operator_audit_logs
 *
 * If either step fails the whole transaction rolls back — no orphan mutations,
 * no orphan audit rows.
 *
 * AUTH: accepts a VerifiedOperatorSession (output of verifyOperatorSession from #96).
 * This module does NOT perform bearer-token verification — that is #96's responsibility.
 * Decoupling ensures #88 can be tested and reviewed independently of auth complexity.
 *
 * V1 commands: acknowledge_needs_human, mark_reviewed
 * V2 commands: approve, retry (rejected until #97 write endpoints are ready)
 *
 * Security invariants (no-leak):
 *   - Audit row only contains controlled enums + opaque IDs.
 *   - NEVER written to audit row: raw token, secret, storage_ref, evidence bytes, stack traces.
 *   - clientIdempotencyKey UNIQUE constraint is the backstop against duplicate submission.
 *   - dev_ctl_ tokens MUST NOT reach this helper — enforced by the calling route (#97).
 */

import { db } from '@/storage/db';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { publishControlEvent } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * An already-verified operator session context.
 * Produced by verifyOperatorSession() (#96) — NOT produced here.
 * Passing pre-verified session decouples this module from the auth layer.
 */
export interface VerifiedOperatorSession {
  sessionId: string;
  workroomId: string;
  operatorSubjectId: string;
  allowedCommands: string[];
}

/** All operator command keys (V1 + V2 declared together for forward-compatibility). */
export type OperatorCommandKey = 'acknowledge_needs_human' | 'mark_reviewed' | 'approve' | 'retry';

export interface OperatorCommandInput {
  session: VerifiedOperatorSession;
  actionId: string;
  commandKey: OperatorCommandKey;
  /**
   * Caller-supplied UUID — prevents double-submission.
   * UNIQUE constraint on control_operator_audit_logs.client_idempotency_key is the
   * DB-level backstop if concurrent requests race past the application check.
   */
  clientIdempotencyKey: string;
}

export type OperatorCommandResult =
  | { ok: true }
  | { ok: false; code: 'COMMAND_NOT_IN_V1'; httpStatus: 422 }
  | { ok: false; code: 'COMMAND_NOT_ALLOWED'; httpStatus: 403 }
  | { ok: false; code: 'ACTION_NOT_FOUND'; httpStatus: 404 }
  | { ok: false; code: 'ACTION_TERMINAL'; httpStatus: 409; currentStatus: string }
  | { ok: false; code: 'ACTION_WRONG_STATUS'; httpStatus: 409; currentStatus: string }
  | { ok: false; code: 'DUPLICATE_IDEMPOTENCY_KEY'; httpStatus: 409 };

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * V1 allow-list. approve/retry are V2 — mirroring the ControlOperatorSession default
 * in #86 (acknowledge_needs_human + mark_reviewed only).
 */
const V1_COMMANDS: ReadonlySet<string> = new Set(['acknowledge_needs_human', 'mark_reviewed']);

/**
 * Valid action statuses for each command.
 * acknowledge_needs_human: action must be in needs_human state.
 * mark_reviewed: operator can review regardless of outcome (needs_human | succeeded | failed).
 */
const VALID_STATUSES_FOR_COMMAND: Readonly<Record<OperatorCommandKey, readonly string[]>> = {
  acknowledge_needs_human: ['needs_human'],
  mark_reviewed:           ['needs_human', 'succeeded', 'failed'],
  approve:                 ['proposed'],                     // V2 — not reachable in V1
  retry:                   ['needs_human', 'failed'],        // V2 — not reachable in V1
};

/** Statuses that are hard terminal — no further operator commands allowed. */
const HARD_TERMINAL_STATUSES = new Set(['canceled', 'transmission_complete']);

// ─── Internal typed error for propagating failures out of a $transaction ─────

class OperatorCmdError extends Error {
  constructor(public readonly result: Exclude<OperatorCommandResult, { ok: true }>) {
    super(result.code);
    this.name = 'OperatorCmdError';
  }
}

// ─── Main helper ──────────────────────────────────────────────────────────────

/**
 * Execute a V1 operator write command atomically.
 *
 * Security invariants (#88 Research blockers fixed):
 *   - action.workroomId is verified against session.workroomId INSIDE the transaction
 *     (fails as ACTION_NOT_FOUND — no workroom membership leak).
 *   - Mutation uses CAS (updateMany WHERE id + workroomId + status IN validStatuses):
 *     a concurrent status change between the in-tx read and the write yields count=0 →
 *     transaction aborts, no mutation committed, no audit row written.
 *   - Pre-check (step 3) provides early terminal/wrong-status UX; CAS (step 4) is the
 *     authoritative atomicity guard that closes the READ COMMITTED window.
 *
 * Returns a typed result; callers map the result to HTTP status codes.
 */
export async function executeOperatorCommand(input: OperatorCommandInput): Promise<OperatorCommandResult> {
  const { session, actionId, commandKey, clientIdempotencyKey } = input;

  // ── Guard 1: V1 gate ──
  // approve/retry are V2 and should not reach here until #97 implements their mutations.
  if (!V1_COMMANDS.has(commandKey)) {
    return { ok: false, code: 'COMMAND_NOT_IN_V1', httpStatus: 422 };
  }

  // ── Guard 2: Session command scope ──
  // session.allowedCommands is set at mint time and validated by verifyOperatorSession (#96).
  if (!session.allowedCommands.includes(commandKey)) {
    return { ok: false, code: 'COMMAND_NOT_ALLOWED', httpStatus: 403 };
  }

  const now = new Date();
  const validStatuses = VALID_STATUSES_FOR_COMMAND[commandKey];

  // ── Transaction: action load + workroom guard + status CAS + mutation + audit ──
  //
  // ALL action-state checks happen inside the transaction to prevent TOCTOU races.
  // If any check fails, the transaction throws OperatorCmdError — both the mutation
  // and the audit row are rolled back atomically (no orphan rows in either direction).
  try {
    await db.$transaction(async (tx) => {
      // Step 1: Load action INSIDE the transaction (authoritative, race-safe)
      const txAction = await tx.controlAction.findUnique({ where: { id: actionId } });
      if (!txAction) {
        throw new OperatorCmdError({ ok: false, code: 'ACTION_NOT_FOUND', httpStatus: 404 });
      }

      // Step 2: Workroom ownership guard (inside tx — fail-closed, no-leak: 404 not 403)
      if (txAction.workroomId !== session.workroomId) {
        throw new OperatorCmdError({ ok: false, code: 'ACTION_NOT_FOUND', httpStatus: 404 });
      }

      // Step 3: Status guard (inside tx — prevents TOCTOU on concurrent status mutation)
      if (!validStatuses.includes(txAction.status)) {
        const isTerminal = HARD_TERMINAL_STATUSES.has(txAction.status);
        throw new OperatorCmdError(
          isTerminal
            ? { ok: false, code: 'ACTION_TERMINAL', httpStatus: 409, currentStatus: txAction.status }
            : { ok: false, code: 'ACTION_WRONG_STATUS', httpStatus: 409, currentStatus: txAction.status },
        );
      }

      // Step 4: CAS mutation — authoritative TOCTOU guard.
      // updateMany WHERE includes status condition: if a concurrent transaction committed a
      // status change between our Step 3 read and this write, count === 0 and we abort
      // without writing the audit row (transaction throws → rolls back atomically).
      let casCount = 0;
      if (commandKey === 'acknowledge_needs_human') {
        const { count } = await tx.controlAction.updateMany({
          where: { id: actionId, workroomId: session.workroomId, status: { in: [...validStatuses] } },
          data: { operatorAcknowledgedAt: now },
        });
        casCount = count;
      } else if (commandKey === 'mark_reviewed') {
        const { count } = await tx.controlAction.updateMany({
          where: { id: actionId, workroomId: session.workroomId, status: { in: [...validStatuses] } },
          data: { operatorReviewedAt: now },
        });
        casCount = count;
      }
      // approve / retry: V2 — V1 gate above ensures we never reach here for those commands.

      if (casCount === 0) {
        // CAS returned 0: either a concurrent status change, a wrong workroom, or action gone.
        // Re-query (fresh READ COMMITTED read) to distinguish these cases accurately.
        const reloaded = await tx.controlAction.findUnique({ where: { id: actionId } });

        // Defense-in-depth workroom guard: CAS WHERE already filters by workroomId so a
        // cross-workroom action always yields count=0.  Step 2 above should have caught this,
        // but if it somehow didn't (e.g. Prisma quirk returning stale workroomId at step 2),
        // this is the authoritative backstop — no-leak 404 same as step 2.
        if (!reloaded || reloaded.workroomId !== session.workroomId) {
          throw new OperatorCmdError({ ok: false, code: 'ACTION_NOT_FOUND', httpStatus: 404 });
        }

        // CAS failed due to concurrent status mutation — report accurate current status.
        const currentStatus = reloaded.status;
        throw new OperatorCmdError(
          HARD_TERMINAL_STATUSES.has(currentStatus)
            ? { ok: false, code: 'ACTION_TERMINAL',    httpStatus: 409, currentStatus }
            : { ok: false, code: 'ACTION_WRONG_STATUS', httpStatus: 409, currentStatus },
        );
      }

      // Step 5: Audit row — same transaction as mutation
      // SECURITY: only controlled metadata. NEVER: raw token, secret, path, stack trace.
      await tx.controlOperatorAuditLog.create({
        data: {
          id: randomUUID(),
          sessionId: session.sessionId,
          workroomId: session.workroomId,
          actionId,
          commandKey,
          operatorSubjectId: session.operatorSubjectId,
          outcome: 'succeeded',
          clientIdempotencyKey,
          decidedAt: now,
        },
      });
    });
  } catch (err) {
    // Propagate typed action-guard failures from inside the transaction
    if (err instanceof OperatorCmdError) {
      return err.result;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Unique violation on clientIdempotencyKey — duplicate submission rejected.
      // The mutation was NOT applied (transaction rolled back).
      return { ok: false, code: 'DUPLICATE_IDEMPOTENCY_KEY', httpStatus: 409 };
    }
    throw err;
  }

  // ── Post-transaction: emit event (write-before-broadcast) ──
  // Topic: action.operator_acknowledged | action.operator_reviewed
  // Payload: locator IDs + command enum + decided_at only. No free text, no operator identity.
  const topic = commandKey === 'acknowledge_needs_human'
    ? 'action.operator_acknowledged'
    : 'action.operator_reviewed';

  await publishControlEvent({
    workroomId: session.workroomId,
    eventId: randomUUID(),
    topic,
    payload: {
      workroom_id: session.workroomId,
      action_id: actionId,
      command_key: commandKey,          // controlled enum
      decided_at: now.toISOString(),
    },
  }).then((event) => {
    if (!event.idempotent) {
      workroomBroadcaster.broadcast(session.workroomId, {
        event_id: event.eventId,
        workroom_id: event.workroomId,
        seq: event.seq.toString(),
        topic: event.topic,
        payload: event.payloadJson as Record<string, unknown>,
        created_at: event.createdAt.toISOString(),
      });
    }
  }).catch(() => { /* broadcast failure is non-fatal; client catches up via GET /events */ });

  return { ok: true };
}
