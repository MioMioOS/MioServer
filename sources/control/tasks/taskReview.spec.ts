/**
 * taskReview.spec — pure-logic tests for the P3 reviewer-gate decision.
 *
 * decideReviewGate is the synchronous core; resolveTaskReviewer (DB) is covered
 * by agentApiTasks.integration.spec.ts. These tests pin every branch + the
 * 1-bounce-cap sequence so the gate can't silently regress.
 */

import { describe, it, expect } from 'vitest';
import { decideReviewGate, MAX_REVIEW_ROUNDS } from './taskReview';

describe('decideReviewGate', () => {
  it('diverts a done-submit from in_progress when an independent reviewer exists', () => {
    expect(
      decideReviewGate({ currentStatus: 'in_progress', targetStatus: 'done', reviewRound: 0, hasIndependentReviewer: true }),
    ).toEqual({ action: 'divert_to_review' });
  });

  it('falls through to done when there is NO independent reviewer (solo/graceful degradation)', () => {
    expect(
      decideReviewGate({ currentStatus: 'in_progress', targetStatus: 'done', reviewRound: 0, hasIndependentReviewer: false }),
    ).toEqual({ action: 'allow', reason: 'no-independent-reviewer' });
  });

  it('falls through to done once the bounce cap is reached (no review↔rework loop)', () => {
    expect(
      decideReviewGate({
        currentStatus: 'in_progress',
        targetStatus: 'done',
        reviewRound: MAX_REVIEW_ROUNDS,
        hasIndependentReviewer: true,
      }),
    ).toEqual({ action: 'allow', reason: 'bounce-cap-reached' });
  });

  it('does NOT gate a non-done target (e.g. claiming / in_progress)', () => {
    expect(
      decideReviewGate({ currentStatus: 'todo', targetStatus: 'in_progress', reviewRound: 0, hasIndependentReviewer: true }),
    ).toEqual({ action: 'allow', reason: 'not-a-done-submit' });
  });

  it('does NOT re-gate a reviewer closing the task (in_review → done)', () => {
    // The reviewer's pass verdict transitions in_review→done; currentStatus is
    // in_review, not in_progress, so it must not be diverted again.
    expect(
      decideReviewGate({ currentStatus: 'in_review', targetStatus: 'done', reviewRound: 1, hasIndependentReviewer: true }),
    ).toEqual({ action: 'allow', reason: 'not-a-done-submit' });
  });

  it('does NOT gate a done-submit from todo (only active in_progress work is gated)', () => {
    expect(
      decideReviewGate({ currentStatus: 'todo', targetStatus: 'done', reviewRound: 0, hasIndependentReviewer: true }),
    ).toEqual({ action: 'allow', reason: 'not-a-done-submit' });
  });

  it('1-bounce-cap sequence: first submit diverts, post-bounce re-submit auto-passes', () => {
    // Submit #1 from active work → divert (server then increments reviewRound 0→1).
    expect(
      decideReviewGate({ currentStatus: 'in_progress', targetStatus: 'done', reviewRound: 0, hasIndependentReviewer: true }),
    ).toEqual({ action: 'divert_to_review' });

    // Reviewer bounces (in_review→in_progress); reviewRound stays 1. The owner
    // reworks and submits done again — now reviewRound === MAX, so it closes
    // WITHOUT a second review, even though a reviewer still exists.
    expect(
      decideReviewGate({ currentStatus: 'in_progress', targetStatus: 'done', reviewRound: 1, hasIndependentReviewer: true }),
    ).toEqual({ action: 'allow', reason: 'bounce-cap-reached' });
  });

  it('MAX_REVIEW_ROUNDS is 1 (single adversarial round)', () => {
    expect(MAX_REVIEW_ROUNDS).toBe(1);
  });
});
