-- P3 reviewer-gate: track adversarial-review rounds per task.
-- Additive, NOT NULL with a default → safe for existing rows (all backfill to 0).
-- The done→in_review divert increments review_round; a re-submit at
-- review_round >= MAX_REVIEW_ROUNDS (1) falls through to done (1-bounce cap).
ALTER TABLE "control_tasks"
  ADD COLUMN IF NOT EXISTS "review_round" INTEGER NOT NULL DEFAULT 0;
