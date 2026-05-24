-- Migration: S2 ControlMessage.parentMessageId
-- Branch: feat/server-control-plane
--
-- Adds a nullable parent_message_id column + index to control_messages.
--
-- Purpose:
--   Threads (S2 §3/§4). null = top-level message; non-null = a reply to the
--   referenced parent message. Replies share the channel seq space with
--   top-level messages and are filtered out of the main channel timeline
--   (GET channel messages adds WHERE parent_message_id IS NULL).
--
-- No FK (control-plane self-reference convention; a deleted parent would leave
-- orphan replies — out of scope, no delete-message path exists). Existing rows
-- default to NULL (safe — all current messages remain top-level / visible).
--
-- This is the form `prisma migrate dev --name s2_message_parent` generates for
-- this change (verified via `prisma migrate diff` datamodel-to-datamodel).

-- AlterTable
ALTER TABLE "control_messages" ADD COLUMN     "parent_message_id" UUID;

-- CreateIndex
CREATE INDEX "control_messages_parent_message_id_idx" ON "control_messages"("parent_message_id");
