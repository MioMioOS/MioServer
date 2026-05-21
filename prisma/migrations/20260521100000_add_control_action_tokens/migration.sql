-- Migration: Add control_action_tokens table (Phase 5B)
--
-- One-time action capability token issued at fire time.
-- Raw token returned in fire 200 response exactly once and NEVER stored.
-- Only SHA-256 hash is stored here.
--
-- Security invariants:
--   UNIQUE(action_id)   → one action, one token issuance (no re-issuance on retry)
--   UNIQUE(token_hash)  → no hash collision double-use
--   expiresAt           → 5-minute TTL enforced by consume CAS
--   consumedAt          → nullable; set atomically by consume endpoint (CAS)
--
-- Consume authentication: action_token bearer (NOT machine_token).
-- machine_id is bound at issuance (from fire request's machine auth), not re-verified at consume.

CREATE TABLE control_action_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id   UUID        NOT NULL UNIQUE REFERENCES control_actions(id),
  token_hash  TEXT        NOT NULL UNIQUE,
  session_id  UUID        NOT NULL,
  workroom_id UUID        NOT NULL,
  machine_id  UUID        NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

-- Index for token lookup at consume time (hash-based auth).
CREATE INDEX idx_control_action_tokens_token_hash ON control_action_tokens(token_hash);
