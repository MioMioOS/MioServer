-- #88: operator write audit log + operator state fields on control_actions
--
-- 1. control_operator_audit_logs: immutable audit record for each operator write command.
--    Written in the SAME transaction as the state mutation — no orphan rows possible.
--    UNIQUE(client_idempotency_key) is the backstop against double-submission.
--    No FK constraints (consistent with rest of system).
--
-- 2. control_actions: two nullable operator state columns.
--    operator_acknowledged_at: set by acknowledge_needs_human command
--    operator_reviewed_at:     set by mark_reviewed command
--    Both nullable, non-breaking, backwards-compatible.

-- Table: control_operator_audit_logs
CREATE TABLE "control_operator_audit_logs" (
    "id"                      UUID         NOT NULL DEFAULT gen_random_uuid(),
    "session_id"              UUID         NOT NULL,
    "workroom_id"             UUID         NOT NULL,
    "action_id"               UUID,
    "command_key"             TEXT         NOT NULL,
    "operator_subject_id"     TEXT         NOT NULL,
    "outcome"                 TEXT         NOT NULL,
    "client_idempotency_key"  TEXT         NOT NULL,
    "decided_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "control_operator_audit_logs_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on client_idempotency_key (double-submission backstop)
CREATE UNIQUE INDEX "control_operator_audit_logs_client_idempotency_key_key"
    ON "control_operator_audit_logs"("client_idempotency_key");

-- Index on action_id (audit lookup by action)
CREATE INDEX "control_operator_audit_logs_action_id_idx"
    ON "control_operator_audit_logs"("action_id");

-- Index on session_id (audit lookup by session/operator)
CREATE INDEX "control_operator_audit_logs_session_id_idx"
    ON "control_operator_audit_logs"("session_id");

-- Add operator state columns to control_actions (nullable, non-breaking)
ALTER TABLE "control_actions"
    ADD COLUMN "operator_acknowledged_at" TIMESTAMP(3),
    ADD COLUMN "operator_reviewed_at"     TIMESTAMP(3);
