-- Migration: S5 ControlActivityState
-- Branch: feat/server-control-plane
--
-- Adds the control_activity_state table for the S5 Activity feed.
--
-- Purpose:
--   Per-subject handled-state for an activity (mention) item. A caller subject
--   (operator subject id like 'pairing:<uuid>', a machine id, or a ControlAgent.id)
--   may mark a mention as handled. subject_id is TEXT (opaque actor id, matches the
--   control_messages.sender_id / control_saved_messages.subject_id text convention).
--   message_id is UUID.
--
--   handled defaults false: "unhandled" ≈ "unread" (there is no per-message read-cursor
--   this MVP). The activity list LEFT-joins this table by (subject_id, message_id) and
--   treats a missing row as handled=false.
--
--   Idempotent upset: the UNIQUE(subject_id, message_id) index lets the POST /handled
--   route upsert on (subject_id, message_id). The subject_id index serves the per-subject
--   join/lookup.
--
-- No FK (control-plane self-reference convention, consistent with control_saved_messages
-- and the message/task columns that reference other control tables without DB FKs).
--
-- This is the form `prisma migrate dev --name s5_activity_state` generates for this change
-- (verified via `prisma migrate diff` datamodel-to-datamodel against HEAD).

-- CreateTable
CREATE TABLE "control_activity_state" (
    "id" UUID NOT NULL,
    "subject_id" TEXT NOT NULL,
    "message_id" UUID NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "control_activity_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "control_activity_state_subject_id_idx" ON "control_activity_state"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "control_activity_state_subject_id_message_id_key" ON "control_activity_state"("subject_id", "message_id");
