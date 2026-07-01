-- S2 (Task #121): human (real-person) mention plumbing.
-- ADDITIVE ONLY — safe to run on the already-seeded prod (mio.wdao.chat).
--
-- The existing `mentions` column on control_messages is `uuid[]` (created by the
-- add_control_plane migration) and can therefore ONLY hold ControlAgent.id values
-- (which are uuids). Real-person user ids are cuids (e.g. "clx..."), which cannot be
-- stored in a uuid[] column. We add a sibling `user_mentions` text[] column that holds
-- the cuid user ids of mentioned humans. The activity feed and mention-push both match
-- a human viewer's user.id against this array.
ALTER TABLE "control_messages"
  ADD COLUMN "user_mentions" TEXT[] NOT NULL DEFAULT '{}';

-- GIN index so the activity feed's `user_mentions @> ARRAY[viewer]` / hasSome lookups
-- stay fast as message volume grows (mirrors how Postgres array containment is queried).
CREATE INDEX "control_messages_user_mentions_idx"
  ON "control_messages" USING GIN ("user_mentions");
