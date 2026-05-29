/**
 * Task status transition validator.
 *
 * Validates whether a status change between two ControlTask statuses is legal.
 * This is a pure function — no DB, no I/O.
 *
 * Agent-facing status set (from prisma/schema.prisma ControlTask.status comment):
 *   todo | in_progress | in_review | done | canceled
 *
 * waiting_approval is a server-only state with no agent-facing meaning; it is NOT
 * a valid source or target in the transition table.
 *
 * Legal transitions:
 *   todo        → in_progress
 *   in_progress → in_review
 *   in_progress → done          (bypass review)
 *   in_review   → done
 *   in_review   → in_progress   (send back for rework)
 *
 * Terminal statuses (done, canceled) cannot be transitioned away from.
 */

/** Result of a transition validation — discriminated union. */
export type TaskTransitionResult =
  | { ok: true }
  | { ok: false; code: 'INVALID_TASK_TRANSITION' };

const INVALID: TaskTransitionResult = { ok: false, code: 'INVALID_TASK_TRANSITION' };
const VALID: TaskTransitionResult = { ok: true };

/**
 * Transition table: maps each agent-facing from-status to the set of
 * statuses it may legally transition to.
 */
const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  todo:        new Set(['in_progress']),
  in_progress: new Set(['in_review', 'done']),
  in_review:   new Set(['done', 'in_progress']),
  // done and canceled are terminal — no outgoing transitions.
};

/**
 * Validate whether a status transition from `from` to `to` is legal.
 *
 * Returns `{ok:true}` for legal transitions; `{ok:false, code:'INVALID_TASK_TRANSITION'}`
 * for terminal sources, unknown statuses, or any unlisted transition.
 */
export function validateTaskTransition(from: string, to: string): TaskTransitionResult {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed === undefined) {
    // from is either terminal (done/canceled) or completely unknown.
    return INVALID;
  }
  return allowed.has(to) ? VALID : INVALID;
}
