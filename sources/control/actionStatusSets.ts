/**
 * Canonical ControlAction status value sets — single source of truth.
 *
 * ControlAction status lifecycle (from Prisma schema):
 *   proposed | approved | rejected | canceled | fired |
 *   transmission_complete | reconciling | succeeded | failed | needs_human
 *
 * ── Cross-repo sync ────────────────────────────────────────────────────────
 * mio-agent (actionGate.ts) maintains mirrored sets — keep in sync:
 *   NON_FIREABLE_STATUSES  ← mirrors FIRE_GUARD_STATUSES
 *   DRAIN_COMPLETE_STATUSES ← mirrors HARD_TERMINAL_STATUSES
 *
 * When adding or renaming a status here, update actionGate.ts in mio-agent.
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * Hard terminal statuses — post-fire outcomes that are final and unrecoverable.
 *
 * Used by:
 *   - Reconcile endpoint pre-check: actions in these states cannot be reconciled.
 *   - Cancel endpoint guard.
 *
 * mio-agent mirror: DRAIN_COMPLETE_STATUSES (actionGate.ts)
 */
export const HARD_TERMINAL_STATUSES = new Set([
  'canceled',
  'failed',
  'succeeded',
  'transmission_complete',
]);

/**
 * Fire guard statuses — daemon must NOT fire an action already in these states.
 * Superset of HARD_TERMINAL_STATUSES; also includes in-flight and blocked states.
 *
 * 'fired'       — action already dispatched; re-firing would duplicate execution.
 * 'needs_human' — outcome unknown, human review required. NOT product-complete.
 *                 Do NOT count needs_human as done/complete in any summary/check.
 *
 * Used by:
 *   - Action fire endpoint CAS guard (notIn check).
 *   - Cancel pre-check (all except 'fired' are non-cancellable terminals).
 *
 * mio-agent mirror: NON_FIREABLE_STATUSES (actionGate.ts)
 */
export const FIRE_GUARD_STATUSES = new Set([
  'fired',
  'canceled',
  'failed',
  'succeeded',
  'transmission_complete',
  // needs_human: outcome UNKNOWN. Daemon must NOT auto-fire. Requires human review.
  // NOT a product completion state — action is blocked, not done.
  'needs_human',
]);

/**
 * Pre-fire statuses — actions eligible to be fired.
 *
 * Used by:
 *   - Reconcile endpoint validation (non-fired actions cannot be reconciled).
 *   - Fire eligibility checks.
 */
export const PRE_FIRE_STATUSES = new Set([
  'proposed',
  'approved',
]);

/**
 * Summary terminal statuses — used to exclude done actions from "active actions" queries.
 * Actions in these states are definitively complete and should not appear in active context.
 *
 * Intentionally EXCLUDED from this set (remain in "active"):
 *   proposed, approved  — pre-fire, actively awaiting fire
 *   fired               — in-flight, actively executing
 *   needs_human         — blocked, awaiting human review (NOT product-done)
 *   reconciling         — reconciliation in progress (if used)
 *
 * Used by:
 *   - WorkroomSummary generation (summaryRoutes.ts): active actions query filter.
 */
export const SUMMARY_TERMINAL_STATUSES = new Set([
  'rejected',           // pre-fire rejection — no further action
  'canceled',           // explicitly canceled
  'failed',             // execution failed
  'succeeded',          // execution confirmed successful
  'transmission_complete', // action completed; external system confirmed
]);
