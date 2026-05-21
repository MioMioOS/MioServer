-- Phase 5C: Evidence records for daemon-reported reconcile attempts.
-- UNIQUE(action_id, evidence_id): same daemon-generated evidence file = idempotent re-report.
-- Multiple different evidence records are allowed per action (full audit trail).
-- machine_id: bound at issuance (verified via ControlActionToken at reconcile time, not from body).
-- Status semantics: action status is advanced to 'needs_human' on first reconcile;
--   subsequent reconcile calls only add evidence records (idempotent, no duplicate events).

CREATE TABLE "control_action_reconciliations" (
  "id"           TEXT        NOT NULL,
  "action_id"    TEXT        NOT NULL,
  "evidence_id"  TEXT        NOT NULL,
  "reason_code"  TEXT        NOT NULL,
  "machine_id"   TEXT        NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "control_action_reconciliations_pkey" PRIMARY KEY ("id")
);

-- FK: action must exist
ALTER TABLE "control_action_reconciliations"
  ADD CONSTRAINT "control_action_reconciliations_action_id_fkey"
  FOREIGN KEY ("action_id")
  REFERENCES "control_actions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Core idempotency constraint: same evidence_id re-reported for same action = P2002 (idempotent)
CREATE UNIQUE INDEX "control_action_reconciliations_action_id_evidence_id_key"
  ON "control_action_reconciliations"("action_id", "evidence_id");

-- Index for lookups by action_id (audit trail retrieval)
CREATE INDEX "control_action_reconciliations_action_id_idx"
  ON "control_action_reconciliations"("action_id");
