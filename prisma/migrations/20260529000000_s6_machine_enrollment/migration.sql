-- Migration: S6 ControlMachineEnrollment — zero-touch Mac daemon enrollment intent.
--
-- Slice 6: Mac creates an enrollment intent (no auth), phone approves with
-- op_sess_, Mac long-polls and atomically claims the machine_token exactly once.
-- Security model mirrors control_operator_pairings:
--   - only sha256(opaque_code) stored (codeHash); raw code never persisted.
--   - uniform 403 anti-enumeration on any failure (expired / used / wrong code).
--   - CAS one-time consume via deliveredToken updateMany WHERE count check.
--
-- Conventions (mirrors existing control-plane migrations):
--   - id is native UUID with gen_random_uuid() default.
--   - timestamps are TIMESTAMPTZ (matches control_channels / control_tasks etc.).
--   - approved_by_op_sess + machine_id are soft refs — NO FK (opaque-ref pattern,
--     consistent with s4_reminders soft refs and ControlOperatorPairing style).

CREATE TABLE control_machine_enrollments (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash            TEXT        NOT NULL,
  device_name          TEXT        NOT NULL,
  platform             TEXT        NOT NULL,
  arch                 TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ NOT NULL,
  approved_at          TIMESTAMPTZ,
  approved_by_op_sess  UUID,
  -- soft ref: ControlOperatorSession.id — no FK (anti-enumeration pattern)
  machine_id           UUID,
  -- soft ref: ControlMachine.id — no FK
  delivered_token      TEXT,
  canceled_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX control_machine_enrollments_code_hash_key
  ON control_machine_enrollments (code_hash);

-- @@index([expiresAt]) intentionally deferred per spec §12 (no janitor yet).
