-- Event-seq counter on the workroom row (2026-06-12 pool-stability work).
--
-- publishControlEvent used to allocate seq via FOR UPDATE on the workroom row +
-- SELECT COALESCE(MAX(seq),0)+1 over control_event_logs. The MAX scan runs while
-- the row lock is held, so the critical section grows with event volume and every
-- publisher in the workroom convoys behind it, each waiter pinning a Prisma pool
-- connection. The counter turns allocation into one indexed single-row UPDATE.
--
-- Idempotent: safe to re-run; backfill only lifts counters that are behind.

ALTER TABLE "control_workrooms"
  ADD COLUMN IF NOT EXISTS "event_seq" BIGINT NOT NULL DEFAULT 0;

-- Backfill: counter must be >= current MAX(seq) per workroom so the next
-- allocation continues the existing sequence without violating
-- UNIQUE(workroom_id, seq).
UPDATE "control_workrooms" w
SET "event_seq" = sub.max_seq
FROM (
  SELECT workroom_id, MAX(seq) AS max_seq
  FROM "control_event_logs"
  GROUP BY workroom_id
) sub
WHERE sub.workroom_id = w.id
  AND w."event_seq" < sub.max_seq;

-- Same fix for the per-channel message seq (nextChannelSeq).
ALTER TABLE "control_channels"
  ADD COLUMN IF NOT EXISTS "message_seq" BIGINT NOT NULL DEFAULT 0;

UPDATE "control_channels" c
SET "message_seq" = sub.max_seq
FROM (
  SELECT channel_id, MAX(seq) AS max_seq
  FROM "control_messages"
  GROUP BY channel_id
) sub
WHERE sub.channel_id = c.id
  AND c."message_seq" < sub.max_seq;
