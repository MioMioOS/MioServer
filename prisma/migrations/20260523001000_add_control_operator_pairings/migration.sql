-- Migration: add control_operator_pairings (#153)
--
-- One-time opaque pairing handle for Mac→phone operator-session onboarding (#151 opaque model).
-- mint-at-redeem: this table stores ONLY the pairing intent + sha256(opaque code); the raw
-- op_sess_ is minted at redeem time and never stored here. Redeem is an atomic CAS consume.

CREATE TABLE control_operator_pairings (
  id                    UUID PRIMARY KEY,
  code_hash             TEXT NOT NULL UNIQUE,
  org_id                UUID NOT NULL,
  workroom_id           UUID NOT NULL,
  allowed_commands      TEXT[] NOT NULL,
  ttl_hours             DOUBLE PRECISION NOT NULL,
  scope_label           TEXT NOT NULL,
  created_by_machine_id UUID NOT NULL,
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at            TIMESTAMP(3) NOT NULL,
  consumed_at           TIMESTAMP(3),
  canceled_at           TIMESTAMP(3)
);

CREATE INDEX control_operator_pairings_workroom_id_idx ON control_operator_pairings (workroom_id);
