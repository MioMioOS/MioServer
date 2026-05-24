-- Migration: S2 ControlAgent @@unique([orgId, machineId])
-- Branch: feat/server-control-plane
--
-- Adds a UNIQUE index on (org_id, machine_id) to control_agents.
--
-- Purpose:
--   1. Idempotent agent creation on machine bind-org (findFirst-then-create guarded
--      by this unique; avoids duplicate ControlAgent rows under concurrent binds).
--   2. Provides an index for the additive sender-name resolution path that looks up
--      ControlAgent by machine_id (daemon-sent messages, S2 §1.4).
--
-- Full (non-partial) unique index: Postgres treats NULLs as distinct, so multiple
-- agents with machine_id = NULL do NOT collide. Prisma @@unique only emits full
-- unique indexes (no previewFeatures), so a hand-written partial WHERE index would
-- drift against `prisma migrate`. This is the form `prisma migrate dev` generates
-- for this change.

CREATE UNIQUE INDEX "control_agents_org_id_machine_id_key" ON "control_agents"("org_id", "machine_id");
