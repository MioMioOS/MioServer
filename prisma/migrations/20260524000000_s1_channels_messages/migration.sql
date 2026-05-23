-- Migration: S1 channels + messages schema (Step A — channelId nullable)
-- Branch: feat/server-control-plane
--
-- Adds ControlChannel and ControlChannelMember tables.
-- Extends control_messages with channel_id (nullable during backfill), seq, client_idempotency_key.
-- Step B (s1_channelid_notnull) makes channel_id NOT NULL after backfill.

-- ============================================================
-- 1. control_channels
-- ============================================================
CREATE TABLE control_channels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id      UUID NOT NULL REFERENCES control_workrooms(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,         -- main | standard | dm
  visibility       TEXT NOT NULL,         -- public | private
  description      TEXT,
  created_by       TEXT NOT NULL,         -- opaque actor id (e.g. 'system' / operatorSubject; not a uuid col)
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ
);

CREATE INDEX control_channels_workroom_id_archived_at_idx
  ON control_channels (workroom_id, archived_at);

CREATE INDEX control_channels_workroom_id_type_idx
  ON control_channels (workroom_id, type);

-- ============================================================
-- 2. control_channel_members
-- ============================================================
CREATE TABLE control_channel_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES control_channels(id),
  member_id  TEXT NOT NULL,              -- opaque actor id (agent/human/operatorSubject; not a uuid col)
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX control_channel_members_channel_id_member_id_key
  ON control_channel_members (channel_id, member_id);

-- ============================================================
-- 3. Extend control_messages
-- ============================================================
ALTER TABLE control_messages
  ADD COLUMN channel_id            UUID REFERENCES control_channels(id),
  ADD COLUMN seq                   BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN client_idempotency_key TEXT;

-- UNIQUE(channel_id, seq) — per-channel monotone seq constraint.
-- NOTE: NULLs in channel_id do not collide in Postgres partial unique indexes;
-- we use a standard unique index which Postgres treats NULL as distinct anyway.
CREATE UNIQUE INDEX control_messages_channel_id_seq_key
  ON control_messages (channel_id, seq);

-- UNIQUE(channel_id, clientIdempotencyKey) — idempotency backstop.
-- NULL channel_id or NULL client_idempotency_key rows do NOT collide (Postgres NULL != NULL).
CREATE UNIQUE INDEX control_messages_channel_id_client_idempotency_key_key
  ON control_messages (channel_id, client_idempotency_key);

-- Index to support fast per-channel message listing by seq.
CREATE INDEX control_messages_channel_id_seq_idx
  ON control_messages (channel_id, seq);
