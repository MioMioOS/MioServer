/**
 * S7 Phase C — legacy → control-plane COPY backfill (REAL Postgres integration).
 *
 * Seeds a couple of legacy Device + Session + SessionMessage rows, runs the
 * backfill logic, and asserts:
 *   1. control rows are created with the correct mapping (org/workroom/channel/sessions/messages)
 *   2. counts match (legacy N → control M)
 *   3. a SECOND run creates 0 new rows (idempotent)
 *   4. dry-run writes NOTHING
 *   5. NO legacy rows are ever deleted/modified (copy-only)
 *
 * The control-plane test DB (setup-test-db.sh) intentionally does NOT include the
 * legacy Device/Session/SessionMessage tables, so this spec creates them itself
 * (IF NOT EXISTS) — keeping the test self-contained without disturbing the shared
 * setup script. Real prod always has these tables.
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
// Relative import (this spec lives under prisma/, outside tsconfig rootDir, so
// the `@/` alias is not resolvable here). Same singleton Prisma client.
import { db } from '../../sources/storage/db';
import {
    runBackfill,
    validateBackfill,
    deriveOrgId,
    deriveWorkroomId,
    deriveChannelId,
    deriveSessionId,
    deriveMessageId,
    mapSenderKind,
    mapSessionStatus,
    DEVICE_ORG_SLUG,
    DEVICE_CHANNEL_NAME,
} from './s7_legacy_sessions_to_control';

// ── Unique fixture ids so this spec is isolated from any other data ──────────
const DEVICE_A = `s7dev-A-${randomUUID()}`;
const DEVICE_B = `s7dev-B-${randomUUID()}`;
const SESSION_A1 = `s7sess-A1-${randomUUID()}`;
const SESSION_A2 = `s7sess-A2-${randomUUID()}`;
const SESSION_B1 = `s7sess-B1-${randomUUID()}`;

const MSG_A1_1 = `s7msg-A1-1-${randomUUID()}`;
const MSG_A1_2 = `s7msg-A1-2-${randomUUID()}`;
const MSG_A2_1 = `s7msg-A2-1-${randomUUID()}`;
const MSG_B1_1 = `s7msg-B1-1-${randomUUID()}`;

// Legacy tables use camelCase quoted identifiers (Prisma default for legacy models).
async function ensureLegacyTables(): Promise<void> {
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Device" (
            "id" TEXT PRIMARY KEY,
            "publicKey" TEXT NOT NULL,
            "name" TEXT NOT NULL,
            "kind" TEXT NOT NULL DEFAULT 'ios',
            "shortCode" TEXT,
            "seq" INTEGER NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastSeenAt" TIMESTAMP(3),
            "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
            "notifyOnCompletion" BOOLEAN NOT NULL DEFAULT false,
            "notifyOnApproval" BOOLEAN NOT NULL DEFAULT false,
            "notifyOnError" BOOLEAN NOT NULL DEFAULT false,
            "subscriptionStatus" TEXT NOT NULL DEFAULT 'none',
            "trialStartedAt" TIMESTAMP(3),
            "trialExpiresAt" TIMESTAMP(3),
            "trialExpireNotifiedAt" TIMESTAMP(3)
        );
    `);
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Session" (
            "id" TEXT PRIMARY KEY,
            "tag" TEXT NOT NULL,
            "deviceId" TEXT NOT NULL,
            "metadata" TEXT NOT NULL,
            "metadataVersion" INTEGER NOT NULL DEFAULT 0,
            "seq" INTEGER NOT NULL DEFAULT 0,
            "active" BOOLEAN NOT NULL DEFAULT true,
            "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SessionMessage" (
            "id" TEXT PRIMARY KEY,
            "sessionId" TEXT NOT NULL,
            "localId" TEXT,
            "seq" INTEGER NOT NULL,
            "content" TEXT NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

async function seedLegacyData(): Promise<void> {
    const now = Date.now();
    await db.device.createMany({
        data: [
            { id: DEVICE_A, publicKey: `pk-${DEVICE_A}`, name: 'Alice iPhone', kind: 'ios', updatedAt: new Date() },
            { id: DEVICE_B, publicKey: `pk-${DEVICE_B}`, name: 'Bob Mac', kind: 'mac', updatedAt: new Date() },
        ],
    });
    await db.session.createMany({
        data: [
            { id: SESSION_A1, tag: 'project-alpha', deviceId: DEVICE_A, metadata: '{"path":"/tmp/alpha"}', active: true, seq: 2, lastActiveAt: new Date(now - 1000), createdAt: new Date(now - 60_000), updatedAt: new Date() },
            { id: SESSION_A2, tag: 'project-beta', deviceId: DEVICE_A, metadata: '{"path":"/tmp/beta"}', active: false, seq: 1, lastActiveAt: new Date(now - 2000), createdAt: new Date(now - 50_000), updatedAt: new Date() },
            { id: SESSION_B1, tag: 'project-gamma', deviceId: DEVICE_B, metadata: '{}', active: true, seq: 1, lastActiveAt: new Date(now - 3000), createdAt: new Date(now - 40_000), updatedAt: new Date() },
        ],
    });
    await db.sessionMessage.createMany({
        data: [
            // Device A, session A1 — two messages (one user, one assistant via JSON role)
            { id: MSG_A1_1, sessionId: SESSION_A1, seq: 1, content: '{"role":"user","text":"hello"}', createdAt: new Date(now - 30_000) },
            { id: MSG_A1_2, sessionId: SESSION_A1, seq: 2, content: '{"role":"assistant","text":"hi there"}', createdAt: new Date(now - 29_000) },
            // Device A, session A2 — one plain-text (non-JSON) message → undetermined role
            { id: MSG_A2_1, sessionId: SESSION_A2, seq: 1, content: 'plain text status update', createdAt: new Date(now - 28_000) },
            // Device B, session B1 — one system message
            { id: MSG_B1_1, sessionId: SESSION_B1, seq: 1, content: '{"role":"system","text":"session started"}', createdAt: new Date(now - 27_000) },
        ],
    });
}

async function cleanupControl(): Promise<void> {
    const deviceIds = [DEVICE_A, DEVICE_B];
    const workroomIds = deviceIds.map(deriveWorkroomId);
    const orgIds = deviceIds.map(deriveOrgId);
    // Order matters (FKs): messages → channels → sessions → workrooms → orgs.
    await db.controlMessage.deleteMany({ where: { workroomId: { in: workroomIds } } });
    await db.controlChannel.deleteMany({ where: { workroomId: { in: workroomIds } } });
    await db.controlSession.deleteMany({ where: { workroomId: { in: workroomIds } } });
    await db.controlWorkroom.deleteMany({ where: { id: { in: workroomIds } } });
    await db.controlOrg.deleteMany({ where: { id: { in: orgIds } } });
}

async function cleanupLegacy(): Promise<void> {
    await db.sessionMessage.deleteMany({ where: { id: { in: [MSG_A1_1, MSG_A1_2, MSG_A2_1, MSG_B1_1] } } });
    await db.session.deleteMany({ where: { id: { in: [SESSION_A1, SESSION_A2, SESSION_B1] } } });
    await db.device.deleteMany({ where: { id: { in: [DEVICE_A, DEVICE_B] } } });
}

beforeAll(async () => {
    await ensureLegacyTables();
    // Clean any leftovers from a previous aborted run, then seed.
    await cleanupControl();
    await cleanupLegacy();
    await seedLegacyData();
});

afterAll(async () => {
    await cleanupControl();
    await cleanupLegacy();
    await db.$disconnect();
});

// ── Pure mapping unit assertions ─────────────────────────────────────────────

describe('S7 mapping helpers (pure)', () => {
    it('mapSessionStatus: active→running, inactive→disconnected', () => {
        expect(mapSessionStatus(true)).toBe('running');
        expect(mapSessionStatus(false)).toBe('disconnected');
    });

    it('mapSenderKind: maps roles and flags undetermined', () => {
        expect(mapSenderKind('{"role":"user"}')).toEqual({ senderKind: 'user', determined: true });
        expect(mapSenderKind('{"role":"assistant"}')).toEqual({ senderKind: 'agent', determined: true });
        expect(mapSenderKind('{"role":"system"}')).toEqual({ senderKind: 'system', determined: true });
        expect(mapSenderKind('not json')).toEqual({ senderKind: 'system', determined: false });
        expect(mapSenderKind('{"text":"no role here"}')).toEqual({ senderKind: 'system', determined: false });
    });
});

// ── Backfill behavior ────────────────────────────────────────────────────────

describe('S7 backfill — COPY legacy → control plane', () => {
    it('dry-run writes NOTHING but reports what would be created', async () => {
        const stats = await runBackfill(db, { dryRun: true });
        expect(stats.dryRun).toBe(true);
        // Both seeded devices have sessions → both considered.
        expect(stats.devicesConsidered).toBeGreaterThanOrEqual(2);
        expect(stats.sessionsCreated).toBeGreaterThanOrEqual(3);
        expect(stats.messagesCreated).toBeGreaterThanOrEqual(4);

        // Nothing actually persisted.
        const orgCount = await db.controlOrg.count({ where: { id: { in: [deriveOrgId(DEVICE_A), deriveOrgId(DEVICE_B)] } } });
        const sessCount = await db.controlSession.count({ where: { id: { in: [deriveSessionId(SESSION_A1), deriveSessionId(SESSION_A2), deriveSessionId(SESSION_B1)] } } });
        const msgCount = await db.controlMessage.count({ where: { id: { in: [deriveMessageId(MSG_A1_1), deriveMessageId(MSG_A1_2), deriveMessageId(MSG_A2_1), deriveMessageId(MSG_B1_1)] } } });
        expect(orgCount).toBe(0);
        expect(sessCount).toBe(0);
        expect(msgCount).toBe(0);
    });

    it('real run creates control rows with correct mapping + counts', async () => {
        const stats = await runBackfill(db, { dryRun: false });

        expect(stats.orgsCreated).toBe(2);
        expect(stats.workroomsCreated).toBe(2);
        expect(stats.channelsCreated).toBe(2);
        expect(stats.sessionsCreated).toBe(3);
        expect(stats.messagesCreated).toBe(4);
        // One plain-text message had no determinable role.
        expect(stats.messagesRoleUndetermined).toBe(1);

        // Org scaffold mapping.
        const orgA = await db.controlOrg.findUnique({ where: { id: deriveOrgId(DEVICE_A) } });
        expect(orgA).not.toBeNull();
        expect(orgA!.slug).toBe(DEVICE_ORG_SLUG(DEVICE_A));
        expect(orgA!.name).toBe('Legacy Device: Alice iPhone');

        // Workroom mapping.
        const wrA = await db.controlWorkroom.findUnique({ where: { id: deriveWorkroomId(DEVICE_A) } });
        expect(wrA!.name).toBe('Alice iPhone');
        expect(wrA!.visibility).toBe('private');
        expect(wrA!.orgId).toBe(deriveOrgId(DEVICE_A));

        // Channel mapping.
        const chA = await db.controlChannel.findUnique({ where: { id: deriveChannelId(DEVICE_A) } });
        expect(chA!.name).toBe(DEVICE_CHANNEL_NAME);
        expect(chA!.type).toBe('standard');
        expect(chA!.visibility).toBe('private');
        expect(chA!.workroomId).toBe(deriveWorkroomId(DEVICE_A));

        // Session mapping: A1 active→running, A2 inactive→disconnected.
        const sA1 = await db.controlSession.findUnique({ where: { id: deriveSessionId(SESSION_A1) } });
        expect(sA1!.workroomId).toBe(deriveWorkroomId(DEVICE_A));
        expect(sA1!.displayName).toBe('project-alpha');
        expect(sA1!.status).toBe('running');
        expect(sA1!.mode).toBe('daemon');
        expect(sA1!.runtime).toBe('claude');
        expect(sA1!.machineId).toBeNull();
        // Legacy metadata preserved in capabilities.
        expect((sA1!.capabilities as any).legacy.metadata).toBe('{"path":"/tmp/alpha"}');
        expect((sA1!.capabilities as any).legacy.sessionId).toBe(SESSION_A1);

        const sA2 = await db.controlSession.findUnique({ where: { id: deriveSessionId(SESSION_A2) } });
        expect(sA2!.status).toBe('disconnected');

        // Messages mapped into device A's channel with sequential seq, chronological order.
        const channelMsgs = await db.controlMessage.findMany({
            where: { channelId: deriveChannelId(DEVICE_A) },
            orderBy: { seq: 'asc' },
        });
        expect(channelMsgs).toHaveLength(3); // A1_1, A1_2, A2_1
        // seq is monotone per channel starting at 1.
        expect(channelMsgs.map((m) => Number(m.seq))).toEqual([1, 2, 3]);
        // chronological order preserved (createdAt ascending).
        const times = channelMsgs.map((m) => m.createdAt.getTime());
        expect(times[0]).toBeLessThanOrEqual(times[1]);
        expect(times[1]).toBeLessThanOrEqual(times[2]);

        const m1 = await db.controlMessage.findUnique({ where: { id: deriveMessageId(MSG_A1_1) } });
        expect(m1!.senderKind).toBe('user');
        expect(m1!.content).toBe('{"role":"user","text":"hello"}');
        const m2 = await db.controlMessage.findUnique({ where: { id: deriveMessageId(MSG_A1_2) } });
        expect(m2!.senderKind).toBe('agent');
        const m3 = await db.controlMessage.findUnique({ where: { id: deriveMessageId(MSG_A2_1) } });
        expect(m3!.senderKind).toBe('system'); // undetermined → neutral default

        const mB = await db.controlMessage.findUnique({ where: { id: deriveMessageId(MSG_B1_1) } });
        expect(mB!.senderKind).toBe('system');
        expect(mB!.channelId).toBe(deriveChannelId(DEVICE_B));
        expect(Number(mB!.seq)).toBe(1);
    });

    it('self-validation passes (legacy counts == control counts for scope)', async () => {
        const v = await validateBackfill(db);
        // Our seeded legacy sessions/messages are all covered.
        expect(v.controlSessions).toBe(v.legacySessions);
        expect(v.controlMessages).toBe(v.legacyMessages);
        expect(v.mismatches).toEqual([]);
        expect(v.ok).toBe(true);
    });

    it('second run is idempotent — creates 0 new rows', async () => {
        const stats = await runBackfill(db, { dryRun: false });
        expect(stats.orgsCreated).toBe(0);
        expect(stats.workroomsCreated).toBe(0);
        expect(stats.channelsCreated).toBe(0);
        expect(stats.sessionsCreated).toBe(0);
        expect(stats.messagesCreated).toBe(0);
        // All counted as already-present.
        expect(stats.sessionsSkippedExisting).toBe(3);
        expect(stats.messagesSkippedExisting).toBe(4);

        // No duplicate rows in the channel.
        const channelMsgs = await db.controlMessage.count({ where: { channelId: deriveChannelId(DEVICE_A) } });
        expect(channelMsgs).toBe(3);
    });

    it('copy-only: legacy rows are untouched after backfill', async () => {
        const devices = await db.device.count({ where: { id: { in: [DEVICE_A, DEVICE_B] } } });
        const sessions = await db.session.count({ where: { id: { in: [SESSION_A1, SESSION_A2, SESSION_B1] } } });
        const messages = await db.sessionMessage.count({ where: { id: { in: [MSG_A1_1, MSG_A1_2, MSG_A2_1, MSG_B1_1] } } });
        expect(devices).toBe(2);
        expect(sessions).toBe(3);
        expect(messages).toBe(4);
    });
});
