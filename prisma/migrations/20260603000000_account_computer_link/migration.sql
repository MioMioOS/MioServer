-- Account-only identity refactor (2026-06-03): additive table only.
-- Single-account-ownership of a computer is enforced by UNIQUE(computer_id).
-- Data backfill (DeviceLink + stray Device.userId → AccountComputerLink) is a
-- SEPARATE one-shot script (prisma/scripts/backfill_account_computer_links.ts),
-- intentionally NOT part of this schema migration.

CREATE TABLE "account_computer_links" (
    "id"          TEXT NOT NULL,
    "user_id"     TEXT NOT NULL,
    "computer_id" TEXT NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_computer_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_computer_links_computer_id_key"
    ON "account_computer_links"("computer_id");

CREATE INDEX "account_computer_links_user_id_idx"
    ON "account_computer_links"("user_id");

ALTER TABLE "account_computer_links"
    ADD CONSTRAINT "account_computer_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
