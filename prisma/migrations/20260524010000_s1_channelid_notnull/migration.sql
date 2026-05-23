-- Migration: S1 channelId NOT NULL (Step B — after backfill)
-- Branch: feat/server-control-plane
--
-- Tightens control_messages.channel_id to NOT NULL after the backfill script
-- (prisma/backfill/s1_main_channels.ts) has set every row's channel_id.
-- Run ONLY after the backfill has been verified (no NULL channel_id rows).

ALTER TABLE control_messages
  ALTER COLUMN channel_id SET NOT NULL;
