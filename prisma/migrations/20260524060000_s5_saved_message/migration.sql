-- Migration: S5 ControlSavedMessage
-- Branch: feat/server-control-plane
--
-- Adds the control_saved_messages table for S5 Saved messages.
--
-- Purpose:
--   A caller subject (operator subject id like 'pairing:<uuid>', or a machine id)
--   may save (bookmark) a message. subject_id is TEXT (opaque actor id, matches
--   control_messages.sender_id text convention). message_id is UUID.
--
--   Idempotent save: the UNIQUE(subject_id, message_id) index makes a double-save a
--   no-op at the DB level (the route catches P2002 and returns 200). The
--   subject_id index serves the GET /saved per-subject listing (newest first).
--
-- No FK (control-plane self-reference convention, consistent with the existing
-- message/task columns that reference other control tables without DB FKs).
--
-- This is the form `prisma migrate dev --name s5_saved_message` generates for this
-- change (verified via `prisma migrate diff` datamodel-to-datamodel against HEAD).

-- CreateTable
CREATE TABLE "control_saved_messages" (
    "id" UUID NOT NULL,
    "workroom_id" UUID NOT NULL,
    "subject_id" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "control_saved_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "control_saved_messages_subject_id_idx" ON "control_saved_messages"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "control_saved_messages_subject_id_message_id_key" ON "control_saved_messages"("subject_id", "message_id");
