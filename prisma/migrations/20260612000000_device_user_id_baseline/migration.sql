-- Baseline fix (2026-06-12): Slice 7 declared Device.userId in schema.prisma and prod
-- received the column OUT-OF-BAND (db push / hand SQL) — no migration ever existed.
-- Result: a brand-new database built with `prisma migrate deploy` was missing the
-- column and the server could not even boot (seedUserIfEmpty queries Device.userId →
-- P2022). Verified live on a fresh DB 2026-06-12.
--
-- Idempotent on purpose: prod (and any db-push'd dev DB) already has the column, the
-- index, and possibly the FK — every statement here is a no-op in that case, so
-- `prisma migrate deploy` stays safe everywhere.

ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "userId" TEXT;

CREATE INDEX IF NOT EXISTS "Device_userId_idx" ON "Device"("userId");

DO $$
BEGIN
  ALTER TABLE "Device"
    ADD CONSTRAINT "Device_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
