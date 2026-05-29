/**
 * claimControlTaskCas — shared CAS claim primitive for ControlTask.
 *
 * Atomic Compare-And-Swap via Prisma updateMany WHERE clause:
 *   WHERE id = $taskId
 *     AND owner_instance_id IS NULL          ← CAS guard (only unclaimed tasks)
 *     AND status NOT IN ('done', 'canceled') ← only claimable statuses
 *   SET owner_instance_id = $agentId, status = 'in_progress'
 *
 * PostgreSQL evaluates the WHERE predicate atomically at the row level.
 * Concurrent callers: the DB row lock serializes them — exactly one wins
 * (count=1), the rest hit count=0 and get owned_by_other.
 *
 * No TOCTOU on the claim write (CAS is atomic); the post-miss discrimination
 * read is best-effort classification — callers treat owned_by_other as a retry signal.
 *
 * Returns a DISCRIMINATED result. Non-not_found outcomes carry the freshly-read
 * `task` so callers can build their response without a SECOND findUnique:
 *   { ok: true }                                  — fresh claim (count=1); row now owned by agentId, status 'in_progress'
 *   { ok: true; alreadyOwn: true; task }          — already owned by this agentId (idempotent, no mutation)
 *   { ok: false; reason: 'not_found' }            — no task with that id
 *   { ok: false; reason: 'terminal'; task }       — status ∈ done | canceled
 *   { ok: false; reason: 'owned_by_other'; task } — task owned by a different agent
 */

import type { ControlTask } from '@prisma/client';
import { db } from '@/storage/db';

export const NON_CLAIMABLE_STATUSES = ['done', 'canceled'];

export type ClaimCasResult =
  | { ok: true; alreadyOwn?: undefined }
  | { ok: true; alreadyOwn: true; task: ControlTask }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'terminal'; task: ControlTask }
  | { ok: false; reason: 'owned_by_other'; task: ControlTask };

export async function claimControlTaskCas(taskId: string, agentId: string): Promise<ClaimCasResult> {
  // *** CAS CLAIM — single atomic DB statement ***
  // owner_instance_id IS NULL ensures only one concurrent winner.
  // status NOT IN ('done','canceled') prevents claiming terminal tasks.
  const result = await db.controlTask.updateMany({
    where: {
      id: taskId,
      ownerInstanceId: null,                          // CAS: must be unclaimed
      status: { notIn: NON_CLAIMABLE_STATUSES },      // must be claimable
    },
    data: {
      ownerInstanceId: agentId,
      status: 'in_progress',
    },
  });

  if (result.count === 1) {
    // CAS winner: task is now ours (status 'in_progress', owner agentId). No read needed.
    return { ok: true };
  }

  // count === 0: differentiate why the CAS missed.
  const task = await db.controlTask.findUnique({ where: { id: taskId } });

  if (!task) {
    return { ok: false, reason: 'not_found' };
  }

  if (NON_CLAIMABLE_STATUSES.includes(task.status)) {
    return { ok: false, reason: 'terminal', task };
  }

  if (task.ownerInstanceId === agentId) {
    // Task is already owned by this exact agent — idempotent success.
    return { ok: true, alreadyOwn: true, task };
  }

  // Owned by a different agent. Invariant: a non-terminal, non-self CAS miss means
  // the row has SOME other owner (the CAS WHERE includes owner_instance_id IS NULL,
  // so a miss with a present, non-terminal row implies ownerInstanceId !== null).
  if (task.ownerInstanceId === null) {
    // Unexpected: CAS missed but the row looks claimable. Still classify as
    // owned_by_other (retry signal) — this guard documents the invariant for callers.
    // eslint-disable-next-line no-console
    console.warn(`[claimControlTaskCas] unexpected CAS miss: task ${taskId} non-terminal with null owner`);
  }
  return { ok: false, reason: 'owned_by_other', task };
}
