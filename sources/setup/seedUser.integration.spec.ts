/**
 * Slice 7 — Task A6 integration tests for the boot seed.
 *
 * Covers spec §9.1 T18–T20:
 *   T18 — first boot seeds + attributes (workrooms + memberships + devices + default workroom)
 *   T19 — idempotent re-seed (User table non-empty → no-op)
 *   T20 — missing env crashes (User table empty + SEED_USER_EMAIL unset → throw)
 *
 * Run:
 *   npm run test:db:setup
 *   npm run test:integration -- sources/setup/seedUser.integration.spec.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { config } from '@/config';
import { seedUserIfEmpty } from './seedUser';

// As in A5: the test DB has the control-plane chain only, NOT the chat-side
// `Device` table. Materialize a minimal version inline so the §7.5 device
// attribution step can be observed.
const DEVICE_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS "Device" (
        id                       TEXT PRIMARY KEY,
        "publicKey"              TEXT NOT NULL UNIQUE,
        name                     TEXT NOT NULL,
        kind                     TEXT NOT NULL DEFAULT 'ios',
        "shortCode"              TEXT UNIQUE,
        seq                      INTEGER NOT NULL DEFAULT 0,
        "createdAt"              TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"              TIMESTAMP NOT NULL DEFAULT now(),
        "lastSeenAt"             TIMESTAMP,
        "notificationsEnabled"   BOOLEAN NOT NULL DEFAULT true,
        "notifyOnCompletion"     BOOLEAN NOT NULL DEFAULT false,
        "notifyOnApproval"       BOOLEAN NOT NULL DEFAULT false,
        "notifyOnError"          BOOLEAN NOT NULL DEFAULT false,
        "subscriptionStatus"     TEXT NOT NULL DEFAULT 'none',
        "trialStartedAt"         TIMESTAMP,
        "trialExpiresAt"         TIMESTAMP,
        "trialExpireNotifiedAt"  TIMESTAMP,
        "userId"                 TEXT REFERENCES users(id) ON DELETE SET NULL
    )
`;
const DEVICE_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_device_userid ON "Device"("userId")`;

// config is a runtime object — `as const` is type-only. We swap SEED_USER_*
// per test by mutating the same imported object the SUT reads from.
// Save original values to restore in afterAll for cross-spec hygiene.
const ORIG_SEED_EMAIL = config.SEED_USER_EMAIL;
const ORIG_SEED_HASH = config.SEED_USER_PASSWORD_HASH;

type MutableConfig = {
    -readonly [K in keyof typeof config]: (typeof config)[K];
};

function setSeedEnv(email: string | undefined, hash: string | undefined): void {
    (config as MutableConfig).SEED_USER_EMAIL = email;
    (config as MutableConfig).SEED_USER_PASSWORD_HASH = hash;
}

/**
 * Reset state the seed reads/writes: clear users (cascades to memberships +
 * sessions), unbind devices we plant, and clean up the workrooms+org we plant.
 * Run before each test so they are order-independent.
 */
async function resetAll(orgId: string, deviceIds: string[], workroomIds: string[]): Promise<void> {
    await db.userSession.deleteMany({}).catch(() => {});
    await db.userWorkroomMembership.deleteMany({}).catch(() => {});
    await db.user.deleteMany({}).catch(() => {});
    if (deviceIds.length > 0) {
        await db.device
            .deleteMany({ where: { id: { in: deviceIds } } })
            .catch(() => {});
    }
    if (workroomIds.length > 0) {
        await db.controlWorkroom
            .deleteMany({ where: { id: { in: workroomIds } } })
            .catch(() => {});
    }
    await db.controlOrg.deleteMany({ where: { id: orgId } }).catch(() => {});
}

beforeAll(async () => {
    await db.$executeRawUnsafe(DEVICE_TABLE_DDL);
    await db.$executeRawUnsafe(DEVICE_INDEX_DDL);
});

afterAll(async () => {
    setSeedEnv(ORIG_SEED_EMAIL, ORIG_SEED_HASH);
    await db.$disconnect();
});

beforeEach(async () => {
    // Nothing global — each test plants its own org/workrooms/devices with
    // unique UUIDs and cleans them up.
});

// --- tests ------------------------------------------------------------------

describe('seedUserIfEmpty (Slice 7 A6)', () => {
    it('T18 — first boot seeds user, binds workrooms, attributes devices, pins default workroom', async () => {
        // Clean slate.
        await db.userSession.deleteMany({}).catch(() => {});
        await db.userWorkroomMembership.deleteMany({}).catch(() => {});
        await db.user.deleteMany({}).catch(() => {});

        const orgId = randomUUID();
        const wkId1 = randomUUID();
        const wkId2 = randomUUID();
        // Use unique publicKey so we don't collide with other specs.
        const deviceId = `dev-a6-t18-${randomUUID()}`;
        const devicePublicKey = `pk-a6-t18-${randomUUID()}`;
        const seedEmail = `a6-seed-${randomUUID()}@example.test`;

        try {
            await db.controlOrg.create({
                data: {
                    id: orgId,
                    name: 'A6 Org',
                    slug: `a6-${randomUUID()}`,
                    ownerUserId: randomUUID(),
                },
            });
            // Plant two workrooms; oldest first (createdAt order).
            await db.controlWorkroom.create({
                data: {
                    id: wkId1,
                    orgId,
                    name: 'Older WK',
                    createdBy: randomUUID(),
                    createdAt: new Date(Date.now() - 60_000),
                },
            });
            await db.controlWorkroom.create({
                data: {
                    id: wkId2,
                    orgId,
                    name: 'Newer WK',
                    createdBy: randomUUID(),
                },
            });
            // Plant a Device with userId=null (legacy chat-side row).
            await db.device.create({
                data: {
                    id: deviceId,
                    publicKey: devicePublicKey,
                    name: 'Legacy device',
                    userId: null,
                },
            });

            // Sanity: User table really is empty.
            expect(await db.user.count()).toBe(0);

            setSeedEnv(seedEmail, '$2b$12$fakehashfortest.fakehashfortest.fakehashfortest.fa');

            await seedUserIfEmpty();

            // Post: User exists with the seed email.
            const users = await db.user.findMany();
            expect(users).toHaveLength(1);
            const user = users[0]!;
            expect(user.email).toBe(seedEmail);

            // Post: defaultWorkroomId pinned to the OLDEST workroom in the DB
            // (the seed's createdAt asc scan is global, not scoped to our org —
            // other integration specs may have left workrooms behind).
            const oldestOverall = await db.controlWorkroom.findFirst({
                orderBy: { createdAt: 'asc' },
                select: { id: true },
            });
            expect(user.defaultWorkroomId).toBe(oldestOverall!.id);

            // Post: memberships exist for BOTH of OUR workrooms with role=owner.
            // (The seed binds every workroom in the DB to the seed user; we
            // only assert about the rows we planted to stay robust to other
            // specs' leftovers.)
            const ourMemberships = await db.userWorkroomMembership.findMany({
                where: { userId: user.id, workroomId: { in: [wkId1, wkId2] } },
            });
            expect(ourMemberships).toHaveLength(2);
            for (const m of ourMemberships) {
                expect(m.role).toBe('owner');
            }
            expect(new Set(ourMemberships.map((m) => m.workroomId))).toEqual(
                new Set([wkId1, wkId2]),
            );

            // Post: device.userId is set to seed user's id.
            const device = await db.device.findUnique({ where: { id: deviceId } });
            expect(device).not.toBeNull();
            expect(device!.userId).toBe(user.id);
        } finally {
            await resetAll(orgId, [deviceId], [wkId1, wkId2]);
        }
    });

    it('T19 — idempotent re-seed: User table non-empty → no new rows, no error', async () => {
        await db.userSession.deleteMany({}).catch(() => {});
        await db.userWorkroomMembership.deleteMany({}).catch(() => {});
        await db.user.deleteMany({}).catch(() => {});

        const existingEmail = `a6-existing-${randomUUID()}@example.test`;
        const planted = await db.user.create({
            data: {
                email: existingEmail,
                passwordHash: '$2b$12$placeholderplaceholderplaceholderplaceholderplaceh',
            },
        });

        try {
            // Even if env IS set, we must not seed a second user.
            setSeedEnv(
                `a6-should-not-create-${randomUUID()}@example.test`,
                '$2b$12$nopeNopeNopeNopeNopeNopeNopeNopeNopeNopeNopeNopeNope',
            );

            await expect(seedUserIfEmpty()).resolves.toBeUndefined();

            const count = await db.user.count();
            expect(count).toBe(1);

            // And the env-throw branch is ALSO suppressed when the table is
            // non-empty — verifies the count-then-bail order from main.ts.
            setSeedEnv(undefined, undefined);
            await expect(seedUserIfEmpty()).resolves.toBeUndefined();
            expect(await db.user.count()).toBe(1);
            // The planted user is still the same row.
            const still = await db.user.findUnique({ where: { id: planted.id } });
            expect(still).not.toBeNull();
            expect(still!.email).toBe(existingEmail);
        } finally {
            await db.userSession.deleteMany({ where: { userId: planted.id } }).catch(() => {});
            await db.userWorkroomMembership.deleteMany({ where: { userId: planted.id } }).catch(() => {});
            await db.user.deleteMany({ where: { id: planted.id } }).catch(() => {});
        }
    });

    it('T20 — empty User table + SEED_USER_EMAIL unset → throws with SEED_USER message', async () => {
        await db.userSession.deleteMany({}).catch(() => {});
        await db.userWorkroomMembership.deleteMany({}).catch(() => {});
        await db.user.deleteMany({}).catch(() => {});

        expect(await db.user.count()).toBe(0);

        setSeedEnv(undefined, 'some-hash');
        await expect(seedUserIfEmpty()).rejects.toThrow(/SEED_USER/);

        // Also: hash missing but email set → still throws.
        setSeedEnv(`a6-${randomUUID()}@example.test`, undefined);
        await expect(seedUserIfEmpty()).rejects.toThrow(/SEED_USER/);

        // No user was created in either failure path.
        expect(await db.user.count()).toBe(0);
    });
});
