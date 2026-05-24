/**
 * S7 Phase C backfill: COPY legacy device-scoped data into the control plane.
 *
 *   Device  → ControlOrg + ControlWorkroom ("personal" per-device room) + one ControlChannel ("monitor")
 *   Session        → ControlSession  (in that device's personal workroom)
 *   SessionMessage → ControlMessage  (into the device channel, per-channel seq, ordered by original time)
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  ABSOLUTE SAFETY (this runs against real prod data at deploy time):
 *   • COPY ONLY. This script NEVER deletes/updates/drops legacy rows. The legacy
 *     Device / Session / SessionMessage tables are read-only here. Deletion is a
 *     SEPARATE later slice (S7 Phase D) and is intentionally NOT in this file.
 *   • IDEMPOTENT + re-runnable. Every created control row gets a STABLE id derived
 *     (UUIDv5) from the legacy id, so a second run finds the same rows and creates 0.
 *   • DRY-RUN: pass `--dry-run` to report what WOULD be created without writing.
 *   • SELF-VERIFYING: after a real run it re-counts control rows for the migrated
 *     scope and asserts they match the legacy source counts; mismatch → non-zero exit.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Usage (from project root):
 *   npx tsx --env-file=.env.dev prisma/backfill/s7_legacy_sessions_to_control.ts --dry-run
 *   npx tsx --env-file=.env.dev prisma/backfill/s7_legacy_sessions_to_control.ts
 *
 * Mapping decisions / honest defaults (legacy has fewer fields than control):
 *   • ControlSession.mode    = 'daemon'  — legacy sessions are device/daemon-reported
 *                                          monitoring, not cmux/applescript. (default, noted)
 *   • ControlSession.runtime = 'claude'  — legacy has no runtime column; these are Claude
 *                                          Code monitoring sessions. (default, noted)
 *   • ControlSession.status  : legacy `active` boolean → 'running' (active) | 'disconnected'
 *                              (inactive). 'disconnected' is chosen over 'completed' because
 *                              legacy never recorded success/failure — we must not fabricate one.
 *   • ControlSession.capabilities: the legacy `metadata` blob + tag + metadataVersion + seq are
 *                              preserved verbatim here under `legacy` so NOTHING is dropped.
 *   • ControlMessage.senderKind: legacy SessionMessage has NO role column. We best-effort parse
 *                              the content JSON for a role/type and map user/assistant/system →
 *                              user/agent/system. When undeterminable we default to 'system'
 *                              (neutral — does not falsely claim a human or AI author) and count it.
 */

import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
// Relative import (not the `@/` alias): this file lives under prisma/, outside
// tsconfig's rootDir (sources/), so the alias is not resolvable from here under
// tsx / vitest. Reuse the production per-channel seq allocator unchanged.
import { nextChannelSeq } from '../../sources/control/messages/channelSeq';

// ── Stable id derivation (RFC-4122 UUIDv5, self-contained) ──────────────────
// Fixed namespace UUID for the S7 backfill. Deriving control-plane UUIDs as
// uuidv5(NAMESPACE, "kind:<legacyId>") makes every created row's id a pure
// function of the legacy source id → re-runs resolve to the same id → idempotent.
// Implemented with Node's crypto (SHA-1, the v5 algorithm) so we add no untyped
// external dependency — bit-for-bit identical to the `uuid` package's v5.
export const S7_NAMESPACE = 'b3f1c0de-5e7c-4a2b-9d11-7e7a5c0ffee5';

function uuidv5(name: string, namespace: string): string {
    const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex'); // 16 bytes
    const hash = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
    const bytes = hash.subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function deriveOrgId(deviceId: string): string {
    return uuidv5(`s7:org:${deviceId}`, S7_NAMESPACE);
}
export function deriveOwnerUserId(deviceId: string): string {
    return uuidv5(`s7:owner:${deviceId}`, S7_NAMESPACE);
}
export function deriveWorkroomId(deviceId: string): string {
    return uuidv5(`s7:workroom:${deviceId}`, S7_NAMESPACE);
}
export function deriveChannelId(deviceId: string): string {
    return uuidv5(`s7:channel:${deviceId}`, S7_NAMESPACE);
}
export function deriveSessionId(legacySessionId: string): string {
    return uuidv5(`s7:session:${legacySessionId}`, S7_NAMESPACE);
}
export function deriveMessageId(legacyMessageId: string): string {
    return uuidv5(`s7:message:${legacyMessageId}`, S7_NAMESPACE);
}

export const DEVICE_ORG_SLUG = (deviceId: string) => `legacy-device-${deviceId}`;
export const DEVICE_CHANNEL_NAME = 'monitor';

// ── Status / role mapping (pure, unit-testable) ─────────────────────────────

/** legacy Session.active → ControlSession.status. See header note. */
export function mapSessionStatus(active: boolean): string {
    return active ? 'running' : 'disconnected';
}

/**
 * Best-effort map a legacy SessionMessage.content blob → control senderKind.
 * Legacy has NO role column, so we inspect the content. Returns one of
 * 'user' | 'agent' | 'system'. Undetermined → 'system' (neutral default).
 * Also reports `determined` so the caller can count unclassified messages.
 */
export function mapSenderKind(content: string): { senderKind: string; determined: boolean } {
    let role: unknown;
    try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
            role = (parsed as Record<string, unknown>).role ?? (parsed as Record<string, unknown>).type;
        }
    } catch {
        // content is not JSON — leave role undefined.
    }
    if (typeof role === 'string') {
        const r = role.toLowerCase();
        if (r === 'user' || r === 'human') return { senderKind: 'user', determined: true };
        if (r === 'assistant' || r === 'agent' || r === 'ai') return { senderKind: 'agent', determined: true };
        if (r === 'system' || r === 'tool') return { senderKind: 'system', determined: true };
    }
    return { senderKind: 'system', determined: false };
}

// ── Types ────────────────────────────────────────────────────────────────────

type Txish = Pick<PrismaClient,
    'controlOrg' | 'controlWorkroom' | 'controlChannel' | 'controlSession' | 'controlMessage'>
    & { $queryRaw: PrismaClient['$queryRaw'] };

export interface BackfillStats {
    devicesConsidered: number;
    orgsCreated: number;
    workroomsCreated: number;
    channelsCreated: number;
    sessionsCreated: number;
    sessionsSkippedExisting: number;
    messagesCreated: number;
    messagesSkippedExisting: number;
    messagesRoleUndetermined: number;
    dryRun: boolean;
}

function emptyStats(dryRun: boolean): BackfillStats {
    return {
        devicesConsidered: 0,
        orgsCreated: 0,
        workroomsCreated: 0,
        channelsCreated: 0,
        sessionsCreated: 0,
        sessionsSkippedExisting: 0,
        messagesCreated: 0,
        messagesSkippedExisting: 0,
        messagesRoleUndetermined: 0,
        dryRun,
    };
}

// ── Per-device scaffold (find-or-create) ────────────────────────────────────

/**
 * Ensure the personal Org + Workroom + Channel exist for a device.
 * Returns the (orgId, workroomId, channelId) regardless of dry-run.
 * In dry-run mode it does NOT write; it returns the derived ids and the
 * `created` flags reflect what WOULD be created.
 */
export async function ensureDeviceScaffold(
    db: Txish,
    device: { id: string; name: string },
    opts: { dryRun: boolean },
): Promise<{
    orgId: string;
    workroomId: string;
    channelId: string;
    orgCreated: boolean;
    workroomCreated: boolean;
    channelCreated: boolean;
}> {
    const orgId = deriveOrgId(device.id);
    const ownerUserId = deriveOwnerUserId(device.id);
    const workroomId = deriveWorkroomId(device.id);
    const channelId = deriveChannelId(device.id);

    // Org — guard by stable derived id (and slug is also unique & derived).
    const existingOrg = await db.controlOrg.findUnique({ where: { id: orgId }, select: { id: true } });
    const orgCreated = !existingOrg;
    if (!existingOrg && !opts.dryRun) {
        await db.controlOrg.create({
            data: {
                id: orgId,
                name: `Legacy Device: ${device.name}`,
                slug: DEVICE_ORG_SLUG(device.id),
                ownerUserId,
                billingPlan: 'free',
            },
        });
    }

    // Workroom — the device's "personal" room.
    const existingWr = await db.controlWorkroom.findUnique({ where: { id: workroomId }, select: { id: true } });
    const workroomCreated = !existingWr;
    if (!existingWr && !opts.dryRun) {
        await db.controlWorkroom.create({
            data: {
                id: workroomId,
                orgId,
                name: device.name,
                description: `Personal monitoring workroom backfilled from legacy device ${device.id}.`,
                visibility: 'private',
                purpose: 'legacy-monitoring',
                createdBy: ownerUserId,
            },
        });
    }

    // Channel — the default "monitor" channel that holds all backfilled messages.
    const existingCh = await db.controlChannel.findUnique({ where: { id: channelId }, select: { id: true } });
    const channelCreated = !existingCh;
    if (!existingCh && !opts.dryRun) {
        await db.controlChannel.create({
            data: {
                id: channelId,
                workroomId,
                name: DEVICE_CHANNEL_NAME,
                type: 'standard',
                visibility: 'private',
                description: 'Backfilled legacy session messages.',
                createdBy: 'system',
                lastActivityAt: new Date(),
            },
        });
    }

    return { orgId, workroomId, channelId, orgCreated, workroomCreated, channelCreated };
}

// ── Session copy ─────────────────────────────────────────────────────────────

export interface LegacySession {
    id: string;
    tag: string;
    metadata: string;
    metadataVersion: number;
    seq: number;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
}

/**
 * Copy one legacy Session → ControlSession (idempotent by derived id).
 * Returns whether a row was created (false = already existed / dry-run-would-skip).
 */
export async function copySession(
    db: Txish,
    legacy: LegacySession,
    target: { orgId: string; workroomId: string },
    opts: { dryRun: boolean },
): Promise<{ created: boolean; controlSessionId: string }> {
    const controlSessionId = deriveSessionId(legacy.id);
    const existing = await db.controlSession.findUnique({
        where: { id: controlSessionId },
        select: { id: true },
    });
    if (existing) return { created: false, controlSessionId };
    if (opts.dryRun) return { created: true, controlSessionId };

    await db.controlSession.create({
        data: {
            id: controlSessionId,
            orgId: target.orgId,
            workroomId: target.workroomId,
            machineId: null, // legacy sessions have no control machine
            mode: 'daemon', // default (noted in header)
            runtime: 'claude', // default (noted in header)
            displayName: legacy.tag,
            status: mapSessionStatus(legacy.active),
            // Preserve everything legacy that has no first-class control field.
            capabilities: {
                legacy: {
                    sessionId: legacy.id,
                    tag: legacy.tag,
                    metadata: legacy.metadata,
                    metadataVersion: legacy.metadataVersion,
                    seq: legacy.seq,
                },
            },
            lastActivityAt: legacy.lastActiveAt,
            createdAt: legacy.createdAt,
        },
    });
    return { created: true, controlSessionId };
}

// ── Message copy ─────────────────────────────────────────────────────────────

export interface LegacyMessage {
    id: string;
    sessionId: string;
    localId: string | null;
    seq: number;
    content: string;
    createdAt: Date;
}

/**
 * Copy one legacy SessionMessage → ControlMessage into the device channel.
 * Idempotent by derived id. Allocates a real per-channel seq via nextChannelSeq
 * inside the supplied tx. Returns {created, roleUndetermined}.
 *
 * MUST be called inside a $transaction (nextChannelSeq locks the channel row).
 */
export async function copyMessage(
    db: Txish,
    legacy: LegacyMessage,
    target: { workroomId: string; channelId: string },
    opts: { dryRun: boolean },
): Promise<{ created: boolean; roleUndetermined: boolean }> {
    const controlMessageId = deriveMessageId(legacy.id);
    const { senderKind, determined } = mapSenderKind(legacy.content);

    const existing = await db.controlMessage.findUnique({
        where: { id: controlMessageId },
        select: { id: true },
    });
    if (existing) return { created: false, roleUndetermined: !determined };
    if (opts.dryRun) return { created: true, roleUndetermined: !determined };

    const seq = await nextChannelSeq(db as Parameters<typeof nextChannelSeq>[0], target.channelId);
    await db.controlMessage.create({
        data: {
            id: controlMessageId,
            workroomId: target.workroomId,
            channelId: target.channelId,
            seq,
            // Stable idempotency key derived from legacy id (also unique per channel).
            clientIdempotencyKey: `s7-legacy-msg-${legacy.id}`,
            senderKind,
            // Opaque actor id — we don't have a real control actor for legacy authors.
            senderId: `legacy:${senderKind}`,
            content: legacy.content,
            mentions: [],
            createdAt: legacy.createdAt,
        },
    });
    return { created: true, roleUndetermined: !determined };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Run the full backfill against the given Prisma client.
 * Reads every legacy Device that has ≥1 Session, scaffolds its personal
 * org/workroom/channel, copies its Sessions and their Messages, and returns stats.
 *
 * NOTE: this function reads legacy tables and writes control tables ONLY.
 */
export async function runBackfill(db: PrismaClient, opts: { dryRun: boolean }): Promise<BackfillStats> {
    const stats = emptyStats(opts.dryRun);

    // Only devices that actually have sessions are worth scaffolding.
    const devices = await db.device.findMany({
        where: { sessions: { some: {} } },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
    });
    stats.devicesConsidered = devices.length;

    for (const device of devices) {
        const scaffold = await ensureDeviceScaffold(db as unknown as Txish, device, opts);
        if (scaffold.orgCreated) stats.orgsCreated++;
        if (scaffold.workroomCreated) stats.workroomsCreated++;
        if (scaffold.channelCreated) stats.channelsCreated++;

        const sessions = await db.session.findMany({
            where: { deviceId: device.id },
            orderBy: { createdAt: 'asc' },
            select: {
                id: true, tag: true, metadata: true, metadataVersion: true,
                seq: true, active: true, lastActiveAt: true, createdAt: true,
            },
        });

        for (const session of sessions) {
            const res = await copySession(
                db as unknown as Txish,
                session,
                { orgId: scaffold.orgId, workroomId: scaffold.workroomId },
                opts,
            );
            if (res.created) stats.sessionsCreated++;
            else stats.sessionsSkippedExisting++;
        }

        // Messages for this device, across all its sessions, ordered by original
        // timestamp (then legacy seq) so the backfilled per-channel seq matches
        // chronological order.
        const messages = await db.sessionMessage.findMany({
            where: { session: { deviceId: device.id } },
            orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
            select: { id: true, sessionId: true, localId: true, seq: true, content: true, createdAt: true },
        });

        for (const message of messages) {
            // Each message copy runs in its own tx so nextChannelSeq's FOR UPDATE
            // lock + insert are atomic (mirrors sendMessageTransaction). In dry-run
            // we skip the tx entirely (no writes, no seq allocation needed).
            if (opts.dryRun) {
                const res = await copyMessage(
                    db as unknown as Txish,
                    message,
                    { workroomId: scaffold.workroomId, channelId: scaffold.channelId },
                    opts,
                );
                if (res.created) stats.messagesCreated++;
                else stats.messagesSkippedExisting++;
                if (res.roleUndetermined) stats.messagesRoleUndetermined++;
            } else {
                const res = await db.$transaction(async (tx) =>
                    copyMessage(
                        tx as unknown as Txish,
                        message,
                        { workroomId: scaffold.workroomId, channelId: scaffold.channelId },
                        opts,
                    ),
                );
                if (res.created) stats.messagesCreated++;
                else stats.messagesSkippedExisting++;
                if (res.roleUndetermined) stats.messagesRoleUndetermined++;
            }
        }
    }

    return stats;
}

// ── Validation / self-check ──────────────────────────────────────────────────

export interface ValidationResult {
    ok: boolean;
    legacySessions: number;
    controlSessions: number;
    legacyMessages: number;
    controlMessages: number;
    mismatches: string[];
}

/**
 * After a REAL run, verify that the control plane now holds at least as many
 * sessions/messages as legacy for the backfilled scope. We compare legacy totals
 * against the count of control rows whose ids are the derived ids of legacy rows
 * (so we only count what THIS backfill is responsible for, not pre-existing data).
 */
export async function validateBackfill(db: PrismaClient): Promise<ValidationResult> {
    const mismatches: string[] = [];

    const legacySessions = await db.session.findMany({
        where: { device: { sessions: { some: {} } } },
        select: { id: true },
    });
    const legacyMessages = await db.sessionMessage.findMany({
        select: { id: true },
    });

    const expectedSessionIds = legacySessions.map((s) => deriveSessionId(s.id));
    const expectedMessageIds = legacyMessages.map((m) => deriveMessageId(m.id));

    const controlSessions = expectedSessionIds.length
        ? await db.controlSession.count({ where: { id: { in: expectedSessionIds } } })
        : 0;
    const controlMessages = expectedMessageIds.length
        ? await db.controlMessage.count({ where: { id: { in: expectedMessageIds } } })
        : 0;

    if (controlSessions !== legacySessions.length) {
        mismatches.push(
            `sessions: legacy ${legacySessions.length} → control ${controlSessions} (expected equal)`,
        );
    }
    if (controlMessages !== legacyMessages.length) {
        mismatches.push(
            `messages: legacy ${legacyMessages.length} → control ${controlMessages} (expected equal)`,
        );
    }

    return {
        ok: mismatches.length === 0,
        legacySessions: legacySessions.length,
        controlSessions,
        legacyMessages: legacyMessages.length,
        controlMessages,
        mismatches,
    };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const dryRun = process.argv.includes('--dry-run');
    const db = new PrismaClient();

    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`[s7_backfill] legacy → control-plane COPY  (mode: ${dryRun ? 'DRY-RUN (no writes)' : 'REAL'})`);
    console.log('[s7_backfill] COPY ONLY — legacy tables are never modified.');
    console.log('═══════════════════════════════════════════════════════════════');

    try {
        const stats = await runBackfill(db, { dryRun });

        console.log('\n[s7_backfill] Results:');
        console.log(`  devices considered          : ${stats.devicesConsidered}`);
        console.log(`  orgs       ${dryRun ? 'WOULD create' : 'created     '}: ${stats.orgsCreated}`);
        console.log(`  workrooms  ${dryRun ? 'WOULD create' : 'created     '}: ${stats.workroomsCreated}`);
        console.log(`  channels   ${dryRun ? 'WOULD create' : 'created     '}: ${stats.channelsCreated}`);
        console.log(`  sessions   ${dryRun ? 'WOULD create' : 'created     '}: ${stats.sessionsCreated} (already present: ${stats.sessionsSkippedExisting})`);
        console.log(`  messages   ${dryRun ? 'WOULD create' : 'created     '}: ${stats.messagesCreated} (already present: ${stats.messagesSkippedExisting})`);
        console.log(`  messages w/ undetermined role (defaulted to 'system'): ${stats.messagesRoleUndetermined}`);

        if (dryRun) {
            console.log('\n[s7_backfill] DRY-RUN complete — NOTHING was written.');
            await db.$disconnect();
            return;
        }

        // Self-verify after a real run.
        console.log('\n[s7_backfill] Validating (self-check counts)…');
        const v = await validateBackfill(db);
        console.log(`  legacy sessions ${v.legacySessions} → control sessions ${v.controlSessions}`);
        console.log(`  legacy messages ${v.legacyMessages} → control messages ${v.controlMessages}`);

        // Sample comparison (first migrated session, if any).
        const sampleLegacy = await db.session.findFirst({ orderBy: { createdAt: 'asc' } });
        if (sampleLegacy) {
            const sampleControl = await db.controlSession.findUnique({
                where: { id: deriveSessionId(sampleLegacy.id) },
                select: { id: true, displayName: true, status: true, createdAt: true },
            });
            console.log('\n[s7_backfill] Sample comparison (first session):');
            console.log(`  legacy : id=${sampleLegacy.id} tag="${sampleLegacy.tag}" active=${sampleLegacy.active} createdAt=${sampleLegacy.createdAt.toISOString()}`);
            console.log(`  control: id=${sampleControl?.id} displayName="${sampleControl?.displayName}" status=${sampleControl?.status} createdAt=${sampleControl?.createdAt.toISOString()}`);
        }

        if (!v.ok) {
            console.error('\n[s7_backfill] ❌ VALIDATION FAILED:');
            for (const m of v.mismatches) console.error(`   - ${m}`);
            await db.$disconnect();
            process.exit(1);
        }
        console.log('\n[s7_backfill] ✅ Validation passed — control counts match legacy.');
        await db.$disconnect();
    } catch (err) {
        console.error('[s7_backfill] ERROR:', err);
        await db.$disconnect();
        process.exit(1);
    }
}

const isDirectRun =
    process.argv[1]?.endsWith('s7_legacy_sessions_to_control.ts') ||
    process.argv[1]?.endsWith('s7_legacy_sessions_to_control.js');

if (isDirectRun) {
    void main();
}
