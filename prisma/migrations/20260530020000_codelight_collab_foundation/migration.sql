-- CodeLight multi-workspace + collaboration foundation (STEP 1).
-- ADDITIVE ONLY — safe to run on the already-seeded prod (mio.wdao.chat).
-- See CodeLight/PLAN-workspace-collab.md for the full contract.

-- R1: user-editable display name. Avatar is a derived identicon(display_name||email);
--     no avatar column yet (add avatar_blob_id later only if custom upload ships).
ALTER TABLE "users" ADD COLUMN "display_name" TEXT;

-- R2.3: bridge the monitoring universe (Device/DeviceLink) to the workspace universe
--       (control_machines). A monitor Device for a Mac that already enrolled a workspace
--       links here, so attaching MioIsland monitoring REUSES that workspace (no new one).
ALTER TABLE "Device" ADD COLUMN "control_machine_id" UUID;
CREATE INDEX "Device_control_machine_id_idx" ON "Device"("control_machine_id");
ALTER TABLE "Device" ADD CONSTRAINT "Device_control_machine_id_fkey"
  FOREIGN KEY ("control_machine_id") REFERENCES "control_machines"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- R4 (minimal collaboration): human-to-human friendship. ONE canonical row per pair
-- (user_id = smaller id, friend_id = larger). status pending|accepted; discovered by email.
CREATE TABLE "user_friendships" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "friend_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requested_by" TEXT NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL,
  CONSTRAINT "user_friendships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_friendships_user_id_friend_id_key" ON "user_friendships"("user_id", "friend_id");
CREATE INDEX "user_friendships_friend_id_idx" ON "user_friendships"("friend_id");
ALTER TABLE "user_friendships" ADD CONSTRAINT "user_friendships_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_friendships" ADD CONSTRAINT "user_friendships_friend_id_fkey"
  FOREIGN KEY ("friend_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
