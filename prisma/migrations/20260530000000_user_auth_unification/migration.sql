-- Migration: Slice 7 — User Auth Unification.
--
-- Introduces a single email+password User model and retires the three legacy
-- auth surfaces:
--   - control_dev_tokens         (dev_ctl_ read-only)
--   - control_operator_sessions  (op_sess_ operator-write)
--   - control_operator_pairings  (QR pairing handle that minted op_sess_)
--
-- Slice 6's control_machine_enrollments is re-created with the approval column
-- renamed from approved_by_op_sess → approved_by_user_id. No stale intents
-- preserved (5-min TTL ephemerals).
--
-- Conventions (mirrors existing control-plane migrations):
--   - User/UserSession/UserWorkroomMembership ids are TEXT (cuid, matches Device).
--   - workroom_id columns are native UUID (matches control_workrooms.id).
--   - timestamps are TIMESTAMPTZ.
--   - devices.user_id is added via ALTER TABLE IF EXISTS so this migration is a
--     no-op against test DBs that only apply the control-plane chain (the
--     `devices` table belongs to the chat-side migration chain not replayed in
--     setup-test-db.sh — see header comment in that script).

BEGIN;

-- 7.1 Create new tables -----------------------------------------------------

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  default_workroom_id UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_workroom_memberships (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workroom_id  UUID NOT NULL,
  role         TEXT NOT NULL DEFAULT 'owner',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, workroom_id)
);
CREATE INDEX idx_uwm_workroom ON user_workroom_memberships(workroom_id);

CREATE TABLE user_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  device_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_user_sessions_user_id    ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_token_hash ON user_sessions(token_hash);

-- 7.2 Add Device.user_id ----------------------------------------------------
-- IF EXISTS guard: the test-DB harness applies only control-plane migrations,
-- so `devices` is absent there. Prod (real prisma deploy on full chain) has it.
-- ON DELETE SET NULL: spec §5.4 — DELETE /v1/users/me unbinds devices rather
-- than cascading (chat-side rows survive and can be re-bound by another signin).
ALTER TABLE IF EXISTS devices ADD COLUMN user_id TEXT NULL REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = 'devices') THEN
    EXECUTE 'CREATE INDEX idx_devices_user_id ON devices(user_id)';
  END IF;
END$$;

-- 7.3 Drop old auth surfaces ------------------------------------------------
-- Order: pairings first (intent referencing sessions), then sessions, then dev tokens.
DROP TABLE IF EXISTS control_operator_pairings    CASCADE;
DROP TABLE IF EXISTS control_operator_sessions    CASCADE;
DROP TABLE IF EXISTS control_dev_tokens           CASCADE;

-- 7.4 Re-create Slice 6 enrollment intent with renamed approval column -----
DROP TABLE IF EXISTS control_machine_enrollments  CASCADE;
CREATE TABLE control_machine_enrollments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash           TEXT NOT NULL UNIQUE,
  device_name         TEXT NOT NULL,
  platform            TEXT NOT NULL,
  arch                TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  approved_at         TIMESTAMPTZ,
  approved_by_user_id TEXT,
  approved_workroom_id UUID,
  machine_id          UUID,
  delivered_token     TEXT,
  canceled_at         TIMESTAMPTZ
);

COMMIT;
