/**
 * Hard-cut migration: DeviceLink + stray Device.userId → AccountComputerLink.
 * Account-only identity refactor (2026-06-03; CONTRACT §6, spec §7).
 *
 * RUN ORDER:
 *   1. Apply the schema migration 20260603000000_account_computer_link (creates
 *      the account_computer_links table). This script assumes it exists.
 *   2. Run THIS script: `npx tsx prisma/scripts/backfill_account_computer_links.ts`
 *   3. Deploy the server build where all readers use AccountComputerLink.
 *   4. (Later, separate migration) DROP TABLE "DeviceLink" — NOT done here.
 *
 * IDEMPOTENT. Re-running keeps existing links, corrects mis-bindings to the
 * computed winner, and never throws on the UNIQUE(computerId) backstop.
 *
 * CONFLICT RESOLUTION (deterministic given DB state):
 *   When one computer has candidate accounts from >1 distinct user, keep the
 *   MOST-RECENTLY-ACTIVE account. Tiebreaker priority:
 *     a. max(UserSession.lastUsedAt ?? createdAt) among the user's sessions
 *     b. else max(Device.lastSeenAt) among the user's phones
 *   Every dropped candidate is logged (never silent).
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

type Candidate = { userId: string; computerId: string; reason: string };

async function userActivityScore(userId: string): Promise<number> {
    // a. latest session activity
    const sessions = await db.userSession.findMany({
        where: { userId },
        select: { lastUsedAt: true, createdAt: true },
    });
    let best = 0;
    for (const s of sessions) {
        const t = (s.lastUsedAt ?? s.createdAt).getTime();
        if (t > best) best = t;
    }
    if (best > 0) return best;

    // b. fallback: latest phone lastSeenAt
    const phones = await db.device.findMany({
        where: { userId, kind: 'ios' },
        select: { lastSeenAt: true },
    });
    for (const p of phones) {
        const t = p.lastSeenAt ? p.lastSeenAt.getTime() : 0;
        if (t > best) best = t;
    }
    return best;
}

async function main() {
    let created = 0;
    let corrected = 0;
    let contestedDropped = 0;
    let orphanSkipped = 0;

    const candidates: Candidate[] = [];

    // ── Step 2: backfill from DeviceLink ─────────────────────────────────
    const deviceLinks = await db.deviceLink.findMany();
    const producedComputerIds = new Set<string>();
    for (const link of deviceLinks) {
        const [a, b] = await Promise.all([
            db.device.findUnique({ where: { id: link.sourceDeviceId }, select: { id: true, kind: true, userId: true } }),
            db.device.findUnique({ where: { id: link.targetDeviceId }, select: { id: true, kind: true, userId: true } }),
        ]);
        if (!a || !b) {
            console.warn('[backfill] DeviceLink %s references a missing Device — skipped', link.id);
            continue;
        }
        const aMac = a.kind === 'mac';
        const bMac = b.kind === 'mac';
        if (aMac === bMac) {
            // neither or both are mac — anomalous, do not write.
            console.warn('[backfill] DeviceLink %s has %s mac endpoints — anomaly, skipped', link.id, aMac ? 'two' : 'zero');
            continue;
        }
        const mac = aMac ? a : b;
        const phone = aMac ? b : a;
        if (!phone.userId) {
            console.warn('[backfill] WARN orphan-phone-link %s (phone %s has no userId)', link.id, phone.id);
            orphanSkipped++;
            continue;
        }
        candidates.push({ userId: phone.userId, computerId: mac.id, reason: 'devicelink' });
        producedComputerIds.add(mac.id);
    }

    // ── Step 3: backfill stray Device.userId on macs ─────────────────────
    const ownedMacs = await db.device.findMany({
        where: { kind: 'mac', userId: { not: null } },
        select: { id: true, userId: true },
    });
    for (const mac of ownedMacs) {
        if (producedComputerIds.has(mac.id)) continue; // step-4 dedupe vs step 2
        candidates.push({ userId: mac.userId!, computerId: mac.id, reason: 'stray-device-userid' });
    }

    // ── Step 4: conflict resolution — group by computerId ────────────────
    const byComputer = new Map<string, Candidate[]>();
    for (const c of candidates) {
        const arr = byComputer.get(c.computerId) ?? [];
        arr.push(c);
        byComputer.set(c.computerId, arr);
    }

    const winners: Candidate[] = [];
    for (const [computerId, group] of byComputer.entries()) {
        const distinctUsers = [...new Set(group.map((g) => g.userId))];
        if (distinctUsers.length === 1) {
            winners.push({ userId: distinctUsers[0], computerId, reason: group[0].reason });
            continue;
        }
        // Contested: score each candidate user, keep max.
        const scored = await Promise.all(
            distinctUsers.map(async (userId) => ({ userId, score: await userActivityScore(userId) }))
        );
        scored.sort((x, y) => (y.score - x.score) || (x.userId < y.userId ? -1 : 1));
        const winner = scored[0].userId;
        winners.push({ userId: winner, computerId, reason: 'contested-winner' });
        for (const loser of scored.slice(1)) {
            console.warn(
                '[backfill] computer %s contested: kept user=%s dropped user=%s (reason=%s)',
                computerId, winner, loser.userId, 'most-recently-active'
            );
            contestedDropped++;
        }
    }

    // ── Step 5: write winners (idempotent overwrite) ─────────────────────
    for (const w of winners) {
        const existing = await db.accountComputerLink.findUnique({ where: { computerId: w.computerId } });
        if (!existing) {
            await db.accountComputerLink.create({ data: { userId: w.userId, computerId: w.computerId } });
            created++;
        } else if (existing.userId !== w.userId) {
            await db.accountComputerLink.update({
                where: { computerId: w.computerId },
                data: { userId: w.userId },
            });
            console.warn(
                '[backfill] computer %s corrected: %s → %s',
                w.computerId, existing.userId, w.userId
            );
            corrected++;
        }
        // else: identical existing link — keep as-is (idempotent re-run).
    }

    console.log(
        '[backfill] DONE — links created=%d, corrected=%d, contested-dropped=%d, orphan-skipped=%d',
        created, corrected, contestedDropped, orphanSkipped
    );
}

main()
    .catch((err) => {
        console.error('[backfill] FATAL', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await db.$disconnect();
    });
