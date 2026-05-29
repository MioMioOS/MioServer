-- Migration: S4.3 Reactions + Attachments data/channel_id
-- Branch: feat/server-control-plane
--
-- Adds the control_message_reactions table and extends control_attachments
-- with two new nullable columns (data, channel_id).
--
-- Purpose:
--   Slock Reactions (S4.3). A reaction is an emoji response by a user or agent
--   to a control message. One row per (message, reactor, emoji); the unique
--   constraint makes toggle-upsert idempotent.
--   The data/channel_id columns are added now (one migration for all S4.3 DDL)
--   even though they are consumed in Chunk B (attachments).
--
-- Design / conventions (mirrors existing control-plane migrations):
--   - ids are native UUID with gen_random_uuid() default (see control_agents etc.).
--   - timestamps are TIMESTAMPTZ (see control_channels / control_tasks migrations).
--   - FKs are declared inline via REFERENCES (matches s4_reminders and the
--     s4_2_prepared_actions migration), NOT via Prisma relation fields.
--   - reactor_id has NO FK: it can be a user OR agent id — soft ref, consistent
--     with how s4_reminders.anchor_message_id had no FK.

-- ============================================================
-- 1. control_message_reactions
-- ============================================================
CREATE TABLE control_message_reactions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID        NOT NULL REFERENCES control_messages(id),
  workroom_id   UUID        NOT NULL REFERENCES control_workrooms(id),
  reactor_kind  TEXT        NOT NULL,
  -- user | agent
  reactor_id    UUID        NOT NULL,
  -- soft ref: can be a user OR agent id, no FK
  emoji         TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT control_message_reactions_message_id_reactor_id_emoji_key
    UNIQUE (message_id, reactor_id, emoji)
);

CREATE INDEX control_message_reactions_message_id_idx
  ON control_message_reactions (message_id);

-- ============================================================
-- 2. control_attachments — add data + channel_id columns
-- ============================================================
ALTER TABLE control_attachments ADD COLUMN data BYTEA;
ALTER TABLE control_attachments ADD COLUMN channel_id UUID;
