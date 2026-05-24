-- Migration: S2 ControlAgent — drop @@unique([orgId, machineId]), replace with non-unique index
-- Branch: feat/server-control-plane
--
-- The "Create Agent" feature needs MULTIPLE agents per computer (one machine may host many
-- agents). The previous UNIQUE index (control_agents_org_id_machine_id_key, added in
-- 20260524030000_s2_agent_machine_unique) enforced one-agent-per-machine-per-org and blocked
-- the second create. We drop the uniqueness and keep a plain index for the (org_id, machine_id)
-- lookup paths (bind-org findFirst, daemon sender-name resolution by machineId, activity caller
-- keys, channel stop-agents).
--
-- SAFE ON PROD: dropping a UNIQUE index only REMOVES a constraint — no rows are touched, no data
-- is lost. The replacement non-unique index preserves lookup performance. bind-org idempotency is
-- now enforced at the APP layer (findFirst-then-create) instead of by the DB unique.
--
-- This is the exact form `prisma migrate dev` generates for this change (verified via
-- `prisma migrate diff` datamodel-to-datamodel: HEAD schema → new schema).

-- DropIndex
DROP INDEX "control_agents_org_id_machine_id_key";

-- CreateIndex
CREATE INDEX "control_agents_org_id_machine_id_idx" ON "control_agents"("org_id", "machine_id");
