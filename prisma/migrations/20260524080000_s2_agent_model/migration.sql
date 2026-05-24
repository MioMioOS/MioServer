-- Migration: S2 ControlAgent.model
-- Branch: feat/server-control-plane
--
-- Adds the nullable `model` column to control_agents for the "Create Agent" form
-- (the MODEL field, e.g. "opus" | "sonnet"). The value is a runtime model alias the
-- daemon resolves; null = use the runtime's default model (existing rows stay null).
--
-- ADDITIVE ONLY: ADD COLUMN nullable, no default backfill, no destructive ops. Safe to
-- deploy onto the prod control DB with real ControlAgent rows.
--
-- Env vars are intentionally NOT a column — they live in capabilities.env (Json).
--
-- This is the exact form `prisma migrate dev --name s2_agent_model` generates for this
-- change (verified via `prisma migrate diff` datamodel-to-datamodel against HEAD).

-- AlterTable
ALTER TABLE "control_agents" ADD COLUMN     "model" TEXT;
