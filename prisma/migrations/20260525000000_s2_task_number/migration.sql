-- Migration: S2 ControlTask.number — per-channel task number
-- Branch: feat/server-control-plane
--
-- Adds a nullable integer `number` column to control_tasks.
--
-- Purpose:
--   Slock Tasks (S2). Agents and the iOS client reference tasks as `task #N`
--   (a small per-channel integer). number=NULL for workroom-scoped tasks
--   (channelId IS NULL), so existing rows are safe.
--
-- Design:
--   - number is nullable: channel-scoped tasks get a number; workroom-level
--     tasks (channelId=null) keep number=null.
--   - A PARTIAL unique index (both channel_id and number non-null) enforces
--     uniqueness per channel without touching null-number rows. Prisma @@unique
--     cannot express partial indexes cleanly, so this lives in the migration SQL.
--   - Back-fill assigns ordinals 1..N by created_at ASC (then id for ties) for
--     all pre-existing channel-scoped rows. New rows get numbers from
--     nextChannelTaskNumber (application layer, FOR UPDATE serialized).

-- AlterTable
ALTER TABLE "control_tasks" ADD COLUMN "number" integer;

-- Back-fill per-channel ordinal for existing channel-scoped rows.
-- Rows with channel_id IS NULL are left as number=NULL (workroom-level tasks).
WITH n AS (
  SELECT id,
         row_number() OVER (PARTITION BY channel_id ORDER BY created_at, id) AS rn
  FROM "control_tasks"
  WHERE channel_id IS NOT NULL
)
UPDATE "control_tasks" t
SET "number" = n.rn
FROM n
WHERE t.id = n.id;

-- Partial unique: (channel_id, number) uniqueness only where both are non-null.
CREATE UNIQUE INDEX "control_tasks_channel_id_number_key"
  ON "control_tasks"("channel_id", "number")
  WHERE "channel_id" IS NOT NULL AND "number" IS NOT NULL;
