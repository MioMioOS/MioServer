/**
 * Slice 7 — Task A3: requireUser middleware integration tests.
 *
 * Exercises the auth + workroom-membership path against the real test Postgres,
 * mirroring the spec's 7 cases (§6.2 + plan A3 Step 1).
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/auth/userSession/requireUser.integration.spec.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { hashPassword } from './passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from './tokenMint';
import { requireUser } from './requireUser';

let app: FastifyInstance;
let userId: string;
let sessionId: string;
let validToken: string;
let orgId: string;
let wkA: string;
let wkB: string;

beforeAll(async () => {
    app = fastify();
    app.get<{ Params: { workroom_id: string } }>(
        '/test/:workroom_id',
        { preHandler: requireUser({ workroomIdFrom: 'param', paramName: 'workroom_id' }) },
        async (req) => ({
            ok: true,
            role: req.userWorkroomRole,
            userId: req.user!.id,
        }),
    );
    await app.ready();
});

beforeEach(async () => {
    // Fresh org + two workrooms per test (UUIDs random so we never collide).
    orgId = randomUUID();
    wkA = randomUUID();
    wkB = randomUUID();
    await db.controlOrg.create({
        data: {
            id: orgId,
            name: 'A3 Org',
            slug: `a3-${randomUUID()}`,
            ownerUserId: randomUUID(),
        },
    });
    await db.controlWorkroom.create({
        data: { id: wkA, orgId, name: 'A', createdBy: randomUUID() },
    });
    await db.controlWorkroom.create({
        data: { id: wkB, orgId, name: 'B', createdBy: randomUUID() },
    });

    const user = await db.user.create({
        data: {
            email: `a3-${randomUUID()}@example.test`,
            passwordHash: await hashPassword('p'),
        },
    });
    userId = user.id;

    validToken = mintUserSessionToken();
    const session = await db.userSession.create({
        data: {
            userId,
            tokenHash: hashUserSessionToken(validToken),
            expiresAt: new Date(Date.now() + 86_400_000),
        },
    });
    sessionId = session.id;

    await db.userWorkroomMembership.create({
        data: { userId, workroomId: wkA, role: 'owner' },
    });
});

// Per-test cleanup: cascade off User handles sessions+memberships;
// workrooms/org are blown away last.
async function cleanup() {
    await db.userSession.deleteMany({ where: { id: sessionId } }).catch(() => {});
    await db.userWorkroomMembership.deleteMany({ where: { userId } }).catch(() => {});
    await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await db.controlWorkroom.deleteMany({ where: { id: { in: [wkA, wkB] } } }).catch(() => {});
    await db.controlOrg.deleteMany({ where: { id: orgId } }).catch(() => {});
}

afterAll(async () => {
    await cleanup();
    await app.close();
    await db.$disconnect();
});

describe('requireUser', () => {
    it('missing Bearer → 401', async () => {
        try {
            const r = await app.inject({ method: 'GET', url: `/test/${wkA}` });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe('INVALID_SESSION');
        } finally {
            await cleanup();
        }
    });

    it('wrong prefix → 401', async () => {
        try {
            const r = await app.inject({
                method: 'GET',
                url: `/test/${wkA}`,
                headers: { authorization: 'Bearer machine_xxx' },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe('INVALID_SESSION');
        } finally {
            await cleanup();
        }
    });

    it('unknown token → 401', async () => {
        try {
            const r = await app.inject({
                method: 'GET',
                url: `/test/${wkA}`,
                headers: { authorization: 'Bearer user_sess_unknown' },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe('INVALID_SESSION');
        } finally {
            await cleanup();
        }
    });

    it('valid token + member workroom → 200', async () => {
        try {
            const r = await app.inject({
                method: 'GET',
                url: `/test/${wkA}`,
                headers: { authorization: `Bearer ${validToken}` },
            });
            expect(r.statusCode).toBe(200);
            const body = r.json() as { ok: boolean; role: string; userId: string };
            expect(body.ok).toBe(true);
            expect(body.role).toBe('owner');
            expect(body.userId).toBe(userId);
        } finally {
            await cleanup();
        }
    });

    it('valid token + non-member workroom → 403', async () => {
        try {
            const r = await app.inject({
                method: 'GET',
                url: `/test/${wkB}`,
                headers: { authorization: `Bearer ${validToken}` },
            });
            expect(r.statusCode).toBe(403);
            expect((r.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
        } finally {
            await cleanup();
        }
    });

    it('revoked session → 401', async () => {
        try {
            await db.userSession.update({
                where: { id: sessionId },
                data: { revokedAt: new Date() },
            });
            const r = await app.inject({
                method: 'GET',
                url: `/test/${wkA}`,
                headers: { authorization: `Bearer ${validToken}` },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe('INVALID_SESSION');
        } finally {
            await cleanup();
        }
    });

    it('expired session → 401', async () => {
        try {
            await db.userSession.update({
                where: { id: sessionId },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });
            const r = await app.inject({
                method: 'GET',
                url: `/test/${wkA}`,
                headers: { authorization: `Bearer ${validToken}` },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe('INVALID_SESSION');
        } finally {
            await cleanup();
        }
    });
});
