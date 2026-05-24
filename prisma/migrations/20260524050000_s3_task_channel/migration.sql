-- Migration: S3 ControlTask.channelId
-- Branch: feat/server-control-plane
--
-- Adds a nullable channel_id column + index to control_tasks.
--
-- Purpose:
--   Slock Tasks (S3). A task now belongs to a channel (the iOS client lists tasks
--   per-channel and as a global workroom aggregate). null = no channel binding;
--   existing rows default NULL (safe — pre-S3 tasks were workroom-scoped only).
--
-- No FK (control-plane self-reference convention, consistent with the existing
-- task/message columns that reference other control tables without DB FKs).
--
-- This is the form `prisma migrate dev --name s3_task_channel` generates for this
-- change (verified via `prisma migrate diff` datamodel-to-datamodel against HEAD).

-- AlterTable
ALTER TABLE "control_tasks" ADD COLUMN     "channel_id" UUID;

-- CreateIndex
CREATE INDEX "control_tasks_channel_id_idx" ON "control_tasks"("channel_id");
