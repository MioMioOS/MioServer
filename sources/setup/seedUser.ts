/**
 * Slice 7 — Task A6: first-boot user seed + migration attribution.
 *
 * Behavior (spec §4.4 + §7.5):
 *   - If the `users` table is empty AND SEED_USER_EMAIL + SEED_USER_PASSWORD_HASH
 *     are set, create that User row.
 *   - Migration attribution: every pre-existing ControlWorkroom becomes a
 *     UserWorkroomMembership for the seed user (role='owner'), the user's
 *     defaultWorkroomId is pinned to the oldest workroom, and every Device
 *     with userId=NULL is rebound to this user.
 *   - If `users` is empty but env is missing → throw (so the operator notices
 *     on first boot rather than running a server with no human identity).
 *   - If `users` is non-empty → no-op (idempotent across reboots).
 *
 * Called from main.ts after `db.$connect()` and before `app.listen`.
 */
import { db } from '@/storage/db';
import { config } from '@/config';

export async function seedUserIfEmpty(): Promise<void> {
    const existing = await db.user.count();
    if (existing > 0) {
        // Idempotent: subsequent boots are no-ops. CRITICALLY this branch runs
        // BEFORE the env check so a missing SEED_USER_* var can never brick a
        // server whose User table was already seeded on a prior boot.
        return;
    }

    const email = config.SEED_USER_EMAIL;
    const hash = config.SEED_USER_PASSWORD_HASH;
    if (!email || !hash) {
        throw new Error(
            'SEED_USER_EMAIL and SEED_USER_PASSWORD_HASH must be set for first boot (User table is empty)',
        );
    }

    const user = await db.user.create({
        data: { email, passwordHash: hash },
    });
    await runMigrationAttribution(user.id);
}

/**
 * Spec §7.5 migration attribution:
 *   1. Every existing ControlWorkroom → UserWorkroomMembership(role='owner').
 *   2. User.defaultWorkroomId pinned to the oldest workroom (if any).
 *   3. Every Device with userId=NULL → bound to this user.
 *
 * Step (3) uses `db.device.updateMany`. In environments where the Device table
 * doesn't exist (e.g. control-plane-only test DBs) the call will throw — that's
 * fine for prod boot where the table always exists, and integration tests that
 * exercise this path materialize a minimal Device table via inline DDL.
 */
async function runMigrationAttribution(userId: string): Promise<void> {
    const workrooms = await db.controlWorkroom.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true },
    });

    for (const w of workrooms) {
        await db.userWorkroomMembership.upsert({
            where: { userId_workroomId: { userId, workroomId: w.id } },
            create: { userId, workroomId: w.id, role: 'owner' },
            update: {},
        });
    }

    if (workrooms[0]) {
        await db.user.update({
            where: { id: userId },
            data: { defaultWorkroomId: workrooms[0].id },
        });
    }

    await db.device.updateMany({
        where: { userId: null },
        data: { userId },
    });
}
