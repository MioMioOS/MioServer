-- #83: add updated_at to control_actions, backing capabilities.action_version (stale-write CAS marker).
-- NOT NULL DEFAULT now() backfills existing rows; Prisma @updatedAt bumps it on every action write.
ALTER TABLE "control_actions" ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();
