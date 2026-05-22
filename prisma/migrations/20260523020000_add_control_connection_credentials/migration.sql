-- Migration: add control_connection_credentials (#179, Track 4)
--
-- Long-lived, refreshable ROOT credential for CodeLight's "bind once, stay connected" model.
-- Stores ONLY sha256(conn_...); the raw is returned once at mint (pairing redeem) and held in the
-- iOS Keychain. Exchanged at /connections/access for short-lived read/operator access tokens.
-- revoked_at is the single kill switch (self-revoke or machine_token revoke). rotated_from_id is the
-- rolling-refresh lineage. scopes carries the granted scopes (read, operator) — operator only when
-- explicitly granted with an operator_subject_id.

CREATE TABLE control_connection_credentials (
  id                    UUID PRIMARY KEY,
  credential_hash       TEXT NOT NULL UNIQUE,
  org_id                UUID NOT NULL,
  workroom_id           UUID NOT NULL,
  scopes                TEXT[] NOT NULL,
  operator_subject_id   TEXT,
  allowed_commands      TEXT[] NOT NULL,
  device_label          TEXT,
  created_by_machine_id UUID,
  rotated_from_id       UUID,
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at            TIMESTAMP(3) NOT NULL,
  last_refresh_at       TIMESTAMP(3),
  revoked_at            TIMESTAMP(3)
);

CREATE INDEX control_connection_credentials_workroom_id_idx ON control_connection_credentials (workroom_id);
