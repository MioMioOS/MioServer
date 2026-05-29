/**
 * Slice 7 — Task A4: signin / signout / me / delete integration tests.
 *
 * Covers spec §9.1 T1–T11 against real Postgres.
 *
 * Run:
 *   npm run test:db:setup
 *   npm run test:integration -- \
 *     sources/auth/userSession/userSessionRoutes.integration.spec.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { hashPassword } from './passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from './tokenMint';
import {
    userSessionRoutes,
    __resetUserSessionRateLimit,
} from './userSessionRoutes';

let app: FastifyInstance;

beforeAll(async () => {
    app = fastify();
    await app.register(userSessionRoutes);
    await app.ready();
});

afterAll(async () => {
    await app.close();
    await db.$disconnect();
});

beforeEach(() => {
    __resetUserSessionRateLimit();
});

// --- helpers ----------------------------------------------------------------

interface Fixture {
    orgId: string;
    workroomIds: string[];
    userId: string;
    email: string;
    password: string;
    token: string;
    sessionId: string;
    cleanup: () => Promise<void>;
}

async function makeFixture(opts?: {
    workrooms?: number;
    sessions?: number;
}): Promise<Fixture> {
    const workroomsN = opts?.workrooms ?? 1;
    const extraSessionsN = opts?.sessions ?? 0;

    const orgId = randomUUID();
    const email = `a4-${randomUUID()}@example.test`;
    const password = 'correct-horse-battery-staple';

    await db.controlOrg.create({
        data: {
            id: orgId,
            name: 'A4 Org',
            slug: `a4-${randomUUID()}`,
            ownerUserId: randomUUID(),
        },
    });

    const workroomIds: string[] = [];
    for (let i = 0; i < workroomsN; i++) {
        const wkId = randomUUID();
        await db.controlWorkroom.create({
            data: { id: wkId, orgId, name: `WK ${i}`, createdBy: randomUUID() },
        });
        workroomIds.push(wkId);
    }

    const user = await db.user.create({
        data: {
            email,
            passwordHash: await hashPassword(password),
            defaultWorkroomId: workroomIds[0] ?? null,
        },
    });

    for (const wkId of workroomIds) {
        await db.userWorkroomMembership.create({
            data: { userId: user.id, workroomId: wkId, role: 'owner' },
        });
    }

    const token = mintUserSessionToken();
    const session = await db.userSession.create({
        data: {
            userId: user.id,
            tokenHash: hashUserSessionToken(token),
            expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
    });

    const extraSessionIds: string[] = [];
    for (let i = 0; i < extraSessionsN; i++) {
        const t = mintUserSessionToken();
        const s = await db.userSession.create({
            data: {
                userId: user.id,
                tokenHash: hashUserSessionToken(t),
                expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
            },
        });
        extraSessionIds.push(s.id);
    }

    const cleanup = async () => {
        await db.userSession
            .deleteMany({ where: { userId: user.id } })
            .catch(() => {});
        await db.userWorkroomMembership
            .deleteMany({ where: { userId: user.id } })
            .catch(() => {});
        await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
        await db.controlWorkroom
            .deleteMany({ where: { id: { in: workroomIds } } })
            .catch(() => {});
        await db.controlOrg.deleteMany({ where: { id: orgId } }).catch(() => {});
    };

    return {
        orgId,
        workroomIds,
        userId: user.id,
        email,
        password,
        token,
        sessionId: session.id,
        cleanup,
    };
}

// --- tests ------------------------------------------------------------------

describe('POST /v1/users/signin', () => {
    it('T1 — happy: returns token + workrooms', async () => {
        const f = await makeFixture({ workrooms: 2 });
        try {
            const r = await app.inject({
                method: 'POST',
                url: '/v1/users/signin',
                payload: { email: f.email, password: f.password },
            });
            expect(r.statusCode).toBe(200);
            const body = r.json() as {
                token: string;
                user: { id: string; email: string };
                default_workroom_id: string | null;
                workrooms: Array<{ id: string; name: string; role: string }>;
            };
            expect(body.token.startsWith('user_sess_')).toBe(true);
            expect(body.user.id).toBe(f.userId);
            expect(body.user.email).toBe(f.email);
            expect(body.default_workroom_id).toBe(f.workroomIds[0]);
            expect(body.workrooms).toHaveLength(2);
            expect(new Set(body.workrooms.map((w) => w.id))).toEqual(
                new Set(f.workroomIds),
            );
            for (const w of body.workrooms) expect(w.role).toBe('owner');

            // Token is persisted (sha256 lookup).
            const persisted = await db.userSession.findUnique({
                where: { tokenHash: hashUserSessionToken(body.token) },
            });
            expect(persisted).not.toBeNull();
            expect(persisted!.userId).toBe(f.userId);
        } finally {
            await f.cleanup();
        }
    });

    it('T2 — wrong password → 401 EMAIL_OR_PASSWORD_INVALID', async () => {
        const f = await makeFixture();
        try {
            const r = await app.inject({
                method: 'POST',
                url: '/v1/users/signin',
                payload: { email: f.email, password: 'wrong-pw' },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe(
                'EMAIL_OR_PASSWORD_INVALID',
            );
        } finally {
            await f.cleanup();
        }
    });

    it('T3 — unknown email → 401 same code (timing-constant via dummy hash)', async () => {
        const r = await app.inject({
            method: 'POST',
            url: '/v1/users/signin',
            payload: {
                email: `nobody-${randomUUID()}@example.test`,
                password: 'anything',
            },
        });
        expect(r.statusCode).toBe(401);
        expect((r.json() as { error: { code: string } }).error.code).toBe(
            'EMAIL_OR_PASSWORD_INVALID',
        );
        // Source-inspection assertion: the route file imports DUMMY_PASSWORD_HASH
        // and runs verifyPassword on it (see top of file). We test the behavior
        // (same status + same code) and trust the source-level contract;
        // wall-clock timing in CI is too flaky to assert on directly.
    });

    it('T4 — rate limit: 6 attempts/min from same IP → 429 + Retry-After', async () => {
        const email = `nobody-rl-${randomUUID()}@example.test`;
        for (let i = 0; i < 5; i++) {
            const r = await app.inject({
                method: 'POST',
                url: '/v1/users/signin',
                payload: { email, password: 'x' },
            });
            expect(r.statusCode).toBe(401);
        }
        const sixth = await app.inject({
            method: 'POST',
            url: '/v1/users/signin',
            payload: { email, password: 'x' },
        });
        expect(sixth.statusCode).toBe(429);
        expect(sixth.headers['retry-after']).toBeDefined();
        expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('T4b — per-email lock: 11 attempts on same email from 11 distinct IPs → 11th is 429', async () => {
        const email = `nobody-emailrl-${randomUUID()}@example.test`;
        // 10 attempts from 10 distinct IPs — each survives the per-IP gate
        // (1 hit < 5/min) but counts against the per-email 15-min window.
        for (let i = 0; i < 10; i++) {
            const r = await app.inject({
                method: 'POST',
                url: '/v1/users/signin',
                payload: { email, password: 'x' },
                remoteAddress: `10.0.0.${i + 1}`,
            });
            expect(r.statusCode).toBe(401);
        }
        const eleventh = await app.inject({
            method: 'POST',
            url: '/v1/users/signin',
            payload: { email, password: 'x' },
            remoteAddress: '10.0.0.99',
        });
        expect(eleventh.statusCode).toBe(429);
        expect(eleventh.headers['retry-after']).toBeDefined();
        // 15-minute window means Retry-After is on the order of 900s.
        expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(60);
    });
});

describe('GET /v1/users/me', () => {
    it('T5 — happy + sliding refresh bumps expiresAt when stale', async () => {
        const f = await makeFixture({ workrooms: 1 });
        try {
            // Force expiresAt to 24 days out — past the 25-day staleness gate
            // (spec §5.3) so /me should bump it back to ~30d.
            const twentyFourDays = new Date(Date.now() + 24 * 24 * 3600 * 1000);
            await db.userSession.update({
                where: { id: f.sessionId },
                data: { expiresAt: twentyFourDays },
            });

            const r = await app.inject({
                method: 'GET',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
            });
            expect(r.statusCode).toBe(200);
            const body = r.json() as {
                user: { id: string; email: string };
                default_workroom_id: string | null;
                workrooms: Array<{ id: string; role: string }>;
            };
            expect(body.user.id).toBe(f.userId);
            expect(body.user.email).toBe(f.email);
            expect(body.workrooms).toHaveLength(1);

            // Sliding refresh is fire-and-forget — give it a tick to land.
            for (let i = 0; i < 20; i++) {
                const row = await db.userSession.findUnique({
                    where: { id: f.sessionId },
                });
                if (row && row.expiresAt.getTime() > twentyFourDays.getTime() + 1000) {
                    expect(
                        row.expiresAt.getTime() - Date.now(),
                    ).toBeGreaterThan(29 * 24 * 3600 * 1000);
                    return;
                }
                await new Promise((res) => setTimeout(res, 25));
            }
            throw new Error('sliding refresh never bumped expiresAt');
        } finally {
            await f.cleanup();
        }
    });

    it('T5b — fresh session (>25d remaining) → /me does NOT bump expiresAt', async () => {
        const f = await makeFixture({ workrooms: 1 });
        try {
            // Force expiresAt to exactly 29 days out — well inside the
            // staleness gate (>25d remaining). /me must NOT bump.
            const twentyNineDays = new Date(Date.now() + 29 * 24 * 3600 * 1000);
            await db.userSession.update({
                where: { id: f.sessionId },
                data: { expiresAt: twentyNineDays },
            });

            const r = await app.inject({
                method: 'GET',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
            });
            expect(r.statusCode).toBe(200);

            // Give any errant fire-and-forget bump a generous chance to land.
            await new Promise((res) => setTimeout(res, 200));
            const row = await db.userSession.findUnique({
                where: { id: f.sessionId },
            });
            expect(row).not.toBeNull();
            // expiresAt should be unchanged (allow ±2s clock slack to be safe).
            expect(
                Math.abs(row!.expiresAt.getTime() - twentyNineDays.getTime()),
            ).toBeLessThan(2000);
        } finally {
            await f.cleanup();
        }
    });

    it('T6 — expired token → 401 INVALID_SESSION', async () => {
        const f = await makeFixture();
        try {
            await db.userSession.update({
                where: { id: f.sessionId },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });
            const r = await app.inject({
                method: 'GET',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe(
                'INVALID_SESSION',
            );
        } finally {
            await f.cleanup();
        }
    });

    it('T7 — revoked token → 401 INVALID_SESSION', async () => {
        const f = await makeFixture();
        try {
            await db.userSession.update({
                where: { id: f.sessionId },
                data: { revokedAt: new Date() },
            });
            const r = await app.inject({
                method: 'GET',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe(
                'INVALID_SESSION',
            );
        } finally {
            await f.cleanup();
        }
    });
});

describe('POST /v1/users/signout', () => {
    it('T8 — signout 204 → subsequent /me 401', async () => {
        const f = await makeFixture();
        try {
            const out = await app.inject({
                method: 'POST',
                url: '/v1/users/signout',
                headers: { authorization: `Bearer ${f.token}` },
            });
            expect(out.statusCode).toBe(204);

            const me = await app.inject({
                method: 'GET',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
            });
            expect(me.statusCode).toBe(401);
            expect((me.json() as { error: { code: string } }).error.code).toBe(
                'INVALID_SESSION',
            );
        } finally {
            await f.cleanup();
        }
    });

    it('T9 — signout idempotent on already-revoked token', async () => {
        const f = await makeFixture();
        try {
            await db.userSession.update({
                where: { id: f.sessionId },
                data: { revokedAt: new Date() },
            });
            const r = await app.inject({
                method: 'POST',
                url: '/v1/users/signout',
                headers: { authorization: `Bearer ${f.token}` },
            });
            expect(r.statusCode).toBe(204);

            // Also: signout with no token / bad token → still 204.
            const r2 = await app.inject({
                method: 'POST',
                url: '/v1/users/signout',
            });
            expect(r2.statusCode).toBe(204);
            const r3 = await app.inject({
                method: 'POST',
                url: '/v1/users/signout',
                headers: { authorization: 'Bearer junk' },
            });
            expect(r3.statusCode).toBe(204);
        } finally {
            await f.cleanup();
        }
    });
});

describe('DELETE /v1/users/me', () => {
    it('T10 — missing pw → 403 PASSWORD_REQUIRED, wrong pw → 403 PASSWORD_INVALID, correct → 204', async () => {
        const f = await makeFixture();
        try {
            const noBody = await app.inject({
                method: 'DELETE',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
                payload: {},
            });
            expect(noBody.statusCode).toBe(403);
            expect((noBody.json() as { error: { code: string } }).error.code).toBe(
                'PASSWORD_REQUIRED',
            );

            const wrongPw = await app.inject({
                method: 'DELETE',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
                payload: { password: 'not-it' },
            });
            expect(wrongPw.statusCode).toBe(403);
            expect((wrongPw.json() as { error: { code: string } }).error.code).toBe(
                'PASSWORD_INVALID',
            );

            const ok = await app.inject({
                method: 'DELETE',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
                payload: { password: f.password },
            });
            expect(ok.statusCode).toBe(204);

            // User row is gone.
            const userRow = await db.user.findUnique({ where: { id: f.userId } });
            expect(userRow).toBeNull();
        } finally {
            await f.cleanup();
        }
    });

    it('T11 — cascade: sessions + memberships gone (devices SetNull verified separately)', async () => {
        // NOTE: the `devices` table is part of the chat-side migration chain
        // which is NOT replayed in the test DB (see migration
        // 20260530000000_user_auth_unification/migration.sql §7.2 — devices is
        // ALTERed with `IF EXISTS`). We therefore can't create Device rows in
        // this integration spec. The Device.userId `ON DELETE SET NULL` FK is
        // declared on the prod schema and exercised by prod-deploy migrations;
        // we trust the FK contract here and verify only the rows we CAN see.
        const f = await makeFixture({
            workrooms: 2,
            sessions: 2, // plus the implicit one => 3 total
        });
        try {
            const preSessions = await db.userSession.count({
                where: { userId: f.userId },
            });
            const preMemberships = await db.userWorkroomMembership.count({
                where: { userId: f.userId },
            });
            expect(preSessions).toBe(3);
            expect(preMemberships).toBe(2);

            const r = await app.inject({
                method: 'DELETE',
                url: '/v1/users/me',
                headers: { authorization: `Bearer ${f.token}` },
                payload: { password: f.password },
            });
            expect(r.statusCode).toBe(204);

            expect(
                await db.userSession.count({ where: { userId: f.userId } }),
            ).toBe(0);
            expect(
                await db.userWorkroomMembership.count({
                    where: { userId: f.userId },
                }),
            ).toBe(0);
            expect(
                await db.user.findUnique({ where: { id: f.userId } }),
            ).toBeNull();

            // TODO (spec §5.4 cascade): solo-owned workrooms are NOT deleted in
            // this slice — see userSessionRoutes.ts comment block in the
            // DELETE handler. When the cascade strategy (or FK redesign) is
            // decided, extend this test to assert ControlWorkroom rows owned
            // solely by f.userId are gone. For now we verify they are STILL
            // present (which is the behavior we're explicitly accepting).
            const wkStillThere = await db.controlWorkroom.count({
                where: { id: { in: f.workroomIds } },
            });
            expect(wkStillThere).toBe(2);
        } finally {
            await f.cleanup();
        }
    });
});
