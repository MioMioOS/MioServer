/**
 * taskReview — P3 reviewer-gate.
 *
 * Motivation: two real-task evaluations (a CLI calculator, a terminal snake game)
 * each shipped CORRECT implementations whose REQUIRED features had ZERO test
 * coverage — the executor self-certified `done` and the blind spot escaped
 * (calc: unary minus untested; snake: 180°-reversal + food-not-on-body untested).
 * Mutation testing was the only mechanical way to catch "tests pass but feature
 * unprotected". This module makes that an enforced gate: an AGENT owner can never
 * write `done` directly — the server diverts `in_progress → in_review` and wakes
 * an INDEPENDENT agent to adversarially audit the deliverable before it closes.
 *
 * Design (MVP):
 *   - Divert only when an independent reviewer EXISTS. Solo / no-other-agent
 *     channels fall through to `done` (graceful degradation — never deadlock).
 *   - 1-bounce hard cap: the divert increments ControlTask.reviewRound; a
 *     re-submit after a bounce sees reviewRound >= MAX and falls through to done.
 *     So the worst case is exactly one review round, never an infinite loop.
 *   - Self-pass impossible: the verdict endpoint requires caller != task owner.
 *
 * This module is the pure decision core (`decideReviewGate`) plus the one DB
 * lookup it needs (`resolveTaskReviewer`). The HTTP wiring lives in
 * agentApiTasks.ts; the reviewer wake + `mio task review` CLI live in the daemon.
 */

import { db } from '@/storage/db';

/**
 * Channel members are stored as opaque text member_ids: agent rows are UUIDs,
 * but HUMAN members are user cuids (e.g. "cmpm…"). ControlAgent.id is a real
 * `uuid` column, so passing a cuid into `findMany({ where: { id: { in } } })`
 * makes Postgres reject the uuid cast and THROW. Every real channel has a human
 * member, so we MUST filter to UUID-shaped ids before the agent lookup. (This
 * mirrors loadChannelMembers in classifyAndMaybeCreateTask.)
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maximum number of review rounds before a re-submit auto-passes. 1 = a single
 * adversarial review; if the reviewer bounces once, the owner's reworked
 * re-submit closes without a second review (avoids review↔rework ping-pong).
 */
export const MAX_REVIEW_ROUNDS = 1;

export type ReviewGateDecision =
  | { action: 'divert_to_review' }
  | { action: 'allow'; reason: 'not-a-done-submit' | 'no-independent-reviewer' | 'bounce-cap-reached' };

/**
 * Pure decision: should an agent's status update be diverted into review?
 *
 * Divert ONLY when ALL hold:
 *   - the agent is trying to close the task (`targetStatus === 'done'`),
 *   - from active work (`currentStatus === 'in_progress'` — never re-gate a task
 *     already in_review, and never gate todo→… etc.),
 *   - the bounce cap has room (`reviewRound < MAX_REVIEW_ROUNDS`),
 *   - an independent reviewer exists (`hasIndependentReviewer`).
 *
 * Otherwise allow the original transition (the caller still validates it against
 * the state machine). Pure + synchronous so it is exhaustively unit-testable
 * without a database.
 */
export function decideReviewGate(args: {
  currentStatus: string;
  targetStatus: string;
  reviewRound: number;
  hasIndependentReviewer: boolean;
}): ReviewGateDecision {
  const { currentStatus, targetStatus, reviewRound, hasIndependentReviewer } = args;
  if (targetStatus !== 'done' || currentStatus !== 'in_progress') {
    return { action: 'allow', reason: 'not-a-done-submit' };
  }
  if (reviewRound >= MAX_REVIEW_ROUNDS) {
    return { action: 'allow', reason: 'bounce-cap-reached' };
  }
  if (!hasIndependentReviewer) {
    return { action: 'allow', reason: 'no-independent-reviewer' };
  }
  return { action: 'divert_to_review' };
}

/**
 * Pick an independent reviewer for a task: an AGENT member of the task's channel
 * other than the owner. Deterministic (lowest agent id) so retries/replays pick
 * the same reviewer. Returns null when no other agent member exists (→ the gate
 * falls through to `done`).
 *
 * "Any other agent" is intentional for the MVP: the review is a mechanical
 * mutation/adversarial audit (break each claimed feature, confirm a test goes
 * red), which does not require domain-matched competence — a second pair of eyes
 * running the audit is the value.
 */
export async function resolveTaskReviewer(
  channelId: string,
  ownerInstanceId: string | null,
): Promise<string | null> {
  const memberRows = await db.controlChannelMember.findMany({
    where: { channelId },
    select: { memberId: true },
  });
  if (memberRows.length === 0) return null;

  // UUID-shaped ids only — human members are cuids and would crash the uuid cast.
  const memberIds = memberRows.map((r) => r.memberId).filter((id) => UUID_RE.test(id));
  if (memberIds.length === 0) return null;
  // Only rows that resolve to a real ControlAgent are eligible reviewers
  // (humans/opaque members can't be woken to run a mutation audit).
  const agents = await db.controlAgent.findMany({
    where: { id: { in: memberIds } },
    select: { id: true },
  });

  const candidates = agents
    .map((a) => a.id)
    .filter((id) => id !== ownerInstanceId)
    .sort(); // deterministic selection
  return candidates[0] ?? null;
}
