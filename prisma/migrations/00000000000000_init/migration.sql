-- MioServer baseline schema — all tables that were created via `prisma db push`
-- before any migration existed. This migration must appear first in the chain so
-- `prisma migrate deploy` works on a fresh database.
--
-- What is NOT here:
--   - notification-prefs columns  (added by 20260406060000_add_notification_prefs)
--   - notificationsEnabled column  (added by 20260408060000_add_notifications_enabled_master)
--   - lastSeenAt column            (added by 20260408070000_add_device_last_seen_at)
--   - subscription/trial columns   (added by 20260423000000_add_subscription_system)
--   - Subscription/SubscriptionDevice/RedeemCode/RedeemCodeUsage tables (same migration)
--   - DeviceLink single-col indexes (added by 20260426120000_add_devicelink_indexes)
--   - All control-plane tables     (added by 20260521000000_add_control_plane and later)

-- ─── Device ──────────────────────────────────────────────────────────────────
CREATE TABLE "Device" (
    "id"        TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "kind"      TEXT NOT NULL DEFAULT 'ios',
    "shortCode" TEXT,
    "seq"       INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Device_publicKey_key" ON "Device"("publicKey");
CREATE UNIQUE INDEX "Device_shortCode_key" ON "Device"("shortCode");

-- ─── DeviceLink ───────────────────────────────────────────────────────────────
-- Note: single-column indexes on sourceDeviceId / targetDeviceId are added by
-- migration 20260426120000_add_devicelink_indexes; not included here.
CREATE TABLE "DeviceLink" (
    "id"             TEXT NOT NULL,
    "sourceDeviceId" TEXT NOT NULL,
    "targetDeviceId" TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeviceLink_sourceDeviceId_targetDeviceId_key"
    ON "DeviceLink"("sourceDeviceId", "targetDeviceId");
ALTER TABLE "DeviceLink" ADD CONSTRAINT "DeviceLink_sourceDeviceId_fkey"
    FOREIGN KEY ("sourceDeviceId") REFERENCES "Device"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceLink" ADD CONSTRAINT "DeviceLink_targetDeviceId_fkey"
    FOREIGN KEY ("targetDeviceId") REFERENCES "Device"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Session ──────────────────────────────────────────────────────────────────
CREATE TABLE "Session" (
    "id"              TEXT NOT NULL,
    "tag"             TEXT NOT NULL,
    "deviceId"        TEXT NOT NULL,
    "metadata"        TEXT NOT NULL,
    "metadataVersion" INTEGER NOT NULL DEFAULT 0,
    "seq"             INTEGER NOT NULL DEFAULT 0,
    "active"          BOOLEAN NOT NULL DEFAULT true,
    "lastActiveAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_deviceId_tag_key" ON "Session"("deviceId", "tag");
CREATE INDEX "Session_deviceId_updatedAt_idx" ON "Session"("deviceId", "updatedAt" DESC);
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── SessionMessage ───────────────────────────────────────────────────────────
CREATE TABLE "SessionMessage" (
    "id"        TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "localId"   TEXT,
    "seq"       INTEGER NOT NULL,
    "content"   TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SessionMessage_sessionId_localId_key" ON "SessionMessage"("sessionId", "localId");
CREATE INDEX "SessionMessage_sessionId_seq_idx" ON "SessionMessage"("sessionId", "seq");
ALTER TABLE "SessionMessage" ADD CONSTRAINT "SessionMessage_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── PairingRequest ───────────────────────────────────────────────────────────
CREATE TABLE "PairingRequest" (
    "id"               TEXT NOT NULL,
    "tempPublicKey"    TEXT NOT NULL,
    "shortCode"        TEXT,
    "serverUrl"        TEXT NOT NULL,
    "deviceName"       TEXT NOT NULL,
    "response"         TEXT,
    "responseDeviceId" TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PairingRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PairingRequest_tempPublicKey_key" ON "PairingRequest"("tempPublicKey");
CREATE UNIQUE INDEX "PairingRequest_shortCode_key" ON "PairingRequest"("shortCode");
CREATE INDEX "PairingRequest_tempPublicKey_idx" ON "PairingRequest"("tempPublicKey");
CREATE INDEX "PairingRequest_shortCode_idx" ON "PairingRequest"("shortCode");

-- ─── LaunchPreset ─────────────────────────────────────────────────────────────
CREATE TABLE "LaunchPreset" (
    "id"        TEXT NOT NULL,
    "deviceId"  TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "command"   TEXT NOT NULL,
    "icon"      TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LaunchPreset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LaunchPreset_deviceId_sortOrder_idx" ON "LaunchPreset"("deviceId", "sortOrder");
ALTER TABLE "LaunchPreset" ADD CONSTRAINT "LaunchPreset_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── KnownProject ─────────────────────────────────────────────────────────────
CREATE TABLE "KnownProject" (
    "id"         TEXT NOT NULL,
    "deviceId"   TEXT NOT NULL,
    "path"       TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnownProject_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnownProject_deviceId_path_key" ON "KnownProject"("deviceId", "path");
CREATE INDEX "KnownProject_deviceId_lastSeenAt_idx" ON "KnownProject"("deviceId", "lastSeenAt" DESC);
ALTER TABLE "KnownProject" ADD CONSTRAINT "KnownProject_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── PushToken ────────────────────────────────────────────────────────────────
CREATE TABLE "PushToken" (
    "id"        TEXT NOT NULL,
    "deviceId"  TEXT NOT NULL,
    "token"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PushToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PushToken_deviceId_token_key" ON "PushToken"("deviceId", "token");
ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── LiveActivityToken ────────────────────────────────────────────────────────
CREATE TABLE "LiveActivityToken" (
    "id"        TEXT NOT NULL,
    "deviceId"  TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "token"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LiveActivityToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LiveActivityToken_deviceId_sessionId_key"
    ON "LiveActivityToken"("deviceId", "sessionId");
CREATE INDEX "LiveActivityToken_sessionId_idx" ON "LiveActivityToken"("sessionId");
