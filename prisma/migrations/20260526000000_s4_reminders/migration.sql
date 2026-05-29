-- Migration: S4.1 Reminders — ControlReminder + ControlReminderEvent
-- Branch: feat/server-control-plane
--
-- Adds the control_reminders and control_reminder_events tables.
--
-- Purpose:
--   Slock Reminders (S4.1). A reminder is a scheduled nudge authored by an agent
--   and anchored to a channel surface (optionally a specific message). Reminders
--   fire at fire_at; cadence=NULL means one-shot, otherwise it recurs. The events
--   table is an append-only audit trail of lifecycle transitions.
--
-- Design / conventions (mirrors existing control-plane migrations):
--   - ids are native UUID with gen_random_uuid() default (see control_agents etc.).
--   - timestamps are TIMESTAMPTZ (see control_channels / control_tasks migrations).
--   - FKs are declared inline via REFERENCES (matches s1_channels_messages and the
--     original add_control_plane migration), NOT via Prisma relation fields. The
--     Prisma schema uses plain FK columns (like ControlMessage.senderId), so the
--     DB-level FKs exist ONLY because this DDL adds them.
--   - control_reminder_events.reminder_id cascades on parent delete.

-- ============================================================
-- 1. control_reminders
-- ============================================================
CREATE TABLE control_reminders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id       UUID NOT NULL REFERENCES control_workrooms(id),
  agent_id          UUID NOT NULL REFERENCES control_agents(id),   -- author
  channel_id        UUID NOT NULL REFERENCES control_channels(id), -- anchor surface
  anchor_message_id UUID,
  title             TEXT NOT NULL,
  fire_at           TIMESTAMPTZ NOT NULL,
  cadence           TEXT,                                          -- NULL = one-shot
  status            TEXT NOT NULL DEFAULT 'scheduled',
  -- scheduled | fired | snoozed | canceled | done
  version           INTEGER NOT NULL DEFAULT 1,
  snoozed_until     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX control_reminders_agent_id_status_idx
  ON control_reminders (agent_id, status);

CREATE INDEX control_reminders_workroom_id_idx
  ON control_reminders (workroom_id);

-- ============================================================
-- 2. control_reminder_events
-- ============================================================
CREATE TABLE control_reminder_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id UUID NOT NULL REFERENCES control_reminders(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail      JSONB
);

CREATE INDEX control_reminder_events_reminder_id_idx
  ON control_reminder_events (reminder_id);
