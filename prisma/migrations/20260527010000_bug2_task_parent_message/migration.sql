-- Migration: Bug-2 Thread feature — ControlTask.parentMessageId
-- Branch: feat/server-control-plane
--
-- Adds a nullable parent_message_id column + index to control_tasks.
--
-- Purpose:
--   Thread feature (Bug-2). When non-null, the task is "attached" to that
--   message; that message becomes the parent of a thread carrying the task
--   chip. iOS surfaces a task chip on the parent message; tapping it opens
--   the thread view.
--
-- Design:
--   - Nullable: pre-existing tasks (no message attachment) keep parent_message_id=NULL.
--   - No FK (control-plane self-ref convention; mirrors control_messages.parent_message_id).
--   - Plain (non-unique) btree index for the join used in GET messages
--     (look up "task attached to this message"). v1 does NOT enforce DB-level
--     uniqueness on parent_message_id; the server uses ORDER BY created_at ASC
--     LIMIT 1 to pick a single attached task per message ("first wins"). If
--     concurrent creates race for the same parent we accept the second; the
--     read path is deterministic regardless.

-- AlterTable
ALTER TABLE "control_tasks" ADD COLUMN "parent_message_id" UUID;

-- CreateIndex
CREATE INDEX "control_tasks_parent_message_id_idx" ON "control_tasks"("parent_message_id");
