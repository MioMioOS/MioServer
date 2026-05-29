-- Migration: S4.2 Prepared Actions — ControlPreparedAction
-- Branch: feat/server-control-plane
--
-- Adds the control_prepared_actions table.
--
-- Purpose:
--   Slock Prepared Actions (S4.2). A prepared action is a control operation
--   proposed by an agent (e.g. channel:create, channel:add_member) and rendered
--   as a card on a channel surface. A human operator fulfills or dismisses it.
--
-- Design / conventions (mirrors existing control-plane migrations):
--   - ids are native UUID with gen_random_uuid() default (see control_agents etc.).
--   - timestamps are TIMESTAMPTZ (see control_channels / control_tasks migrations).
--   - params is JSONB (matches control_reminder_events.detail).
--   - FKs are declared inline via REFERENCES (matches s4_reminders and the original
--     add_control_plane migration), NOT via Prisma relation fields.
--   - fulfilled_by_operator is TEXT (NOT uuid): operator subject ids look like
--     `pairing:<uuid>`, not a bare uuid.
--   - card_message_id and fulfilled_result_id are soft refs that can dangle, so
--     they have NO FK (matching how s4_reminders.anchor_message_id had no FK).

-- ============================================================
-- 1. control_prepared_actions
-- ============================================================
CREATE TABLE control_prepared_actions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workroom_id           UUID NOT NULL REFERENCES control_workrooms(id),
  channel_id            UUID NOT NULL REFERENCES control_channels(id), -- card surface
  proposer_agent_id     UUID NOT NULL REFERENCES control_agents(id),   -- proposer
  type                  TEXT NOT NULL,
  -- channel:create | channel:add_member
  params                JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'proposed',
  -- proposed | fulfilled | dismissed
  card_message_id       UUID,                                          -- soft ref, may dangle
  fulfilled_by_operator TEXT,                                          -- operator subject id, e.g. pairing:<uuid>
  fulfilled_result_id   UUID,                                          -- soft ref, may dangle
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX control_prepared_actions_workroom_id_status_idx
  ON control_prepared_actions (workroom_id, status);

CREATE INDEX control_prepared_actions_proposer_agent_id_idx
  ON control_prepared_actions (proposer_agent_id);
