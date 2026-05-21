-- Migration: Add control_dev_tokens table (#32)
--
-- Debug/dev-only READ-ONLY token for the human UI (CodeLight) to call control-plane
-- GET endpoints WITHOUT machine_token. Minted via a root-only CLI/seed (HTTP issuance
-- endpoint is disabled when NODE_ENV=production). Raw token is returned exactly once at
-- mint time and NEVER stored — only its SHA-256 hash is persisted here.
--
-- Security invariants:
--   UNIQUE(token_hash)  → no hash collision / double-registration
--   scope               → fixed 'read_only' (no write capability ever)
--   workroom_id         → token bound to a single workroom (verify layer enforces scope)
--   expires_at          → short TTL
--   revoked_at          → nullable; set to revoke a token before expiry
--
-- Auth: dev_control_token bearer (NOT machine_token, NOT action_token). The verify layer
-- enforces a hardcoded GET allowlist + workroom-scope (reverse-lookup for /actions/:id)
-- and returns a uniform 403 on any failure (anti-enumeration: never leak whether the
-- token was expired / revoked / out-of-scope / hit a non-allowlisted route).
--
-- Native-uuid convention matches the rest of the control-plane schema
-- (control_action_tokens etc.: id UUID DEFAULT gen_random_uuid()).

CREATE TABLE control_dev_tokens (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash            TEXT        NOT NULL UNIQUE,
  org_id                UUID        NOT NULL,
  workroom_id           UUID        NOT NULL,
  scope                 TEXT        NOT NULL DEFAULT 'read_only',
  created_by_machine_id UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ
);

-- Token lookup at verify time (hash-based auth).
CREATE INDEX idx_control_dev_tokens_token_hash ON control_dev_tokens(token_hash);
-- Workroom-scoped listing / admin.
CREATE INDEX idx_control_dev_tokens_workroom_id ON control_dev_tokens(workroom_id);
