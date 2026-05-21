-- Phase 5D-A: Expand control_credentials scope model + add access audit log.
--
-- control_credentials: replaces free-form `scope` TEXT with structured scope_mode,
-- scope_workroom_ids, allowed_action_kinds, revoked/expires fields.
-- DB zero secret bytes: only storage_ref (pointer) + metadata stored here.
--
-- control_credential_access_logs: immutable audit trail per resolve attempt.
-- NEVER contains secret values — only metadata + controlled reason_code enums.
--
-- UUID types throughout (consistent with control_orgs/control_actions FK conventions).

-- ── Expand control_credentials ─────────────────────────────────────────────

-- Drop the free-form scope column (replaced by structured fields below)
ALTER TABLE "control_credentials" DROP COLUMN IF EXISTS "scope";

-- Add structured scope fields
ALTER TABLE "control_credentials"
  ADD COLUMN "scope_mode"          TEXT    NOT NULL DEFAULT 'workroom',
  ADD COLUMN "scope_workroom_ids"  UUID[]  NOT NULL DEFAULT '{}',
  ADD COLUMN "allowed_action_kinds" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "revoked"             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "revoked_at"          TIMESTAMPTZ,
  ADD COLUMN "expires_at"          TIMESTAMPTZ;

-- Scope integrity constraint:
--   workroom scope requires at least one workroom (empty = no authorization)
--   org-wide scope must be explicitly requested
ALTER TABLE "control_credentials"
  ADD CONSTRAINT "control_credentials_scope_check"
  CHECK (
    (scope_mode = 'workroom' AND array_length(scope_workroom_ids, 1) >= 1)
    OR (scope_mode = 'org')
  );

-- Idempotency: same alias within same org must be unique
CREATE UNIQUE INDEX "control_credentials_org_id_alias_key"
  ON "control_credentials"("org_id", "alias");

-- ── Create control_credential_access_logs ──────────────────────────────────

CREATE TABLE "control_credential_access_logs" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "credential_id" UUID         NOT NULL,
  "action_id"     UUID         NOT NULL,
  "machine_id"    UUID         NOT NULL,
  "success"       BOOLEAN      NOT NULL,
  "reason_code"   TEXT,
  "accessed_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT "control_credential_access_logs_pkey" PRIMARY KEY ("id")
);

-- FKs: both must exist
ALTER TABLE "control_credential_access_logs"
  ADD CONSTRAINT "control_credential_access_logs_credential_id_fkey"
  FOREIGN KEY ("credential_id")
  REFERENCES "control_credentials"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "control_credential_access_logs"
  ADD CONSTRAINT "control_credential_access_logs_action_id_fkey"
  FOREIGN KEY ("action_id")
  REFERENCES "control_actions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lookup indexes
CREATE INDEX "control_credential_access_logs_credential_id_idx"
  ON "control_credential_access_logs"("credential_id");

CREATE INDEX "control_credential_access_logs_action_id_idx"
  ON "control_credential_access_logs"("action_id");
