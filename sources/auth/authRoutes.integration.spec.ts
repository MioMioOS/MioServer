/**
 * Slice 7 — Task A5 integration tests for the user-bound /v1/auth route.
 *
 * Covers spec §6.1 T1–T7:
 *   T1 happy: signed-in user + valid sig → 200, Device.userId set, JWT carries userId
 *   T2 hijack: publicKey already bound to userA, userB tries → 409
 *   T3 legacy rebind: Device.userId NULL + valid bearer → upsert sets userId
 *   T4 idempotent: same user re-auth → 200, lastSeenAt bumped, no error
 *   T5 missing bearer: no Authorization → 401 MISSING_USER_SESSION
 *   T6 invalid bearer: expired/revoked/garbage → 401 INVALID_SESSION
 *   T7 invalid signature: valid bearer + bad sig → 401 'Invalid signature'
 *
 * Convention: this is `.integration.spec.ts` because it touches Postgres
 * (Device + User + UserSession rows). Default `npm test` excludes these.
 *
 * Run:
 *   npm run test:db:setup
 *   npm run test:integration -- sources/auth/authRoutes.integration.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import {
    serializerCompiler,
    validatorCompiler,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'crypto';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import jwt from 'jsonwebtoken';

import { db } from '@/storage/db';
import { config } from '@/config';
import { authRoutes } from './authRoutes';
import { hashPassword } from './userSession/passwordHash';
import {
    mintUserSessionToken,
    hashUserSessionToken,
} from './userSession/tokenMint';

const { encodeBase64 } = tweetnaclUtil;

// --- helpers ----------------------------------------------------------------

let app: FastifyInstance;

// The shared test DB setup script (scripts/setup-test-db.sh) intentionally
// applies ONLY the control-plane migration chain and does NOT create the
// chat-side `Device` table — see comment block at the top of that script.
// Slice 7 A5 tests need it, so we materialize a minimal Device table on the
// fly inside the test DB. The schema mirrors prisma/schema.prisma's `Device`
// model just deeply enough for the columns the route touches (publicKey,
// name, lastSeenAt, userId, plus defaulted required cols).
//
// PascalCase quoted identifier `"Device"` matches Prisma's default mapping
// (no @@map on the model). The FK to users(id) lets the legacy NULL→bind
// path (T3) verify Postgres-level integrity end-to-end.
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

beforeAll(async () => {
    // Prisma's $executeRawUnsafe runs a single prepared statement per call —
    // split DDL accordingly. No-ops on re-run thanks to IF NOT EXISTS.
    await db.$executeRawUnsafe(DEVICE_TABLE_DDL);
    await db.$executeRawUnsafe(DEVICE_INDEX_DDL);

    app = fastify();
    // /v1/auth uses zod body schemas via fastify-type-provider-zod (matches api.ts).
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(authRoutes);
    await app.ready();
});

afterAll(async () => {
    await app.close();
    await db.$disconnect();
});

interface UserFixture {
    userId: string;
    email: string;
    sessionToken: string; // raw user_sess_… token
    sessionId: string;
    cleanup: () => Promise<void>;
}

async function makeUserFixture(): Promise<UserFixture> {
    const email = `a5-${randomUUID()}@example.test`;
    const user = await db.user.create({
        data: {
            email,
            passwordHash: await hashPassword('does-not-matter'),
        },
    });
    const rawToken = mintUserSessionToken();
    const session = await db.userSession.create({
        data: {
            userId: user.id,
            tokenHash: hashUserSessionToken(rawToken),
            expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
    });
    return {
        userId: user.id,
        email,
        sessionToken: rawToken,
        sessionId: session.id,
        cleanup: async () => {
            await db.userSession
                .deleteMany({ where: { userId: user.id } })
                .catch(() => {});
            await db.device
                .deleteMany({ where: { userId: user.id } })
                .catch(() => {});
            await db.user.deleteMany({ where: { id: user.id } }).catch(() => {});
        },
    };
}

interface KeyMaterial {
    publicKeyB64: string;
    challengeB64: string;
    signatureB64: string;
    // Holders for arbitrary tampering in T7.
    keyPair: nacl.SignKeyPair;
    challenge: Uint8Array;
}

function freshKeyMaterial(): KeyMaterial {
    const keyPair = nacl.sign.keyPair();
    const challenge = new TextEncoder().encode(`challenge-${randomUUID()}`);
    const signature = nacl.sign.detached(challenge, keyPair.secretKey);
    return {
        keyPair,
        challenge,
        publicKeyB64: encodeBase64(keyPair.publicKey),
        challengeB64: encodeBase64(challenge),
        signatureB64: encodeBase64(signature),
    };
}

// --- tests ------------------------------------------------------------------

describe('POST /v1/auth — Slice 7 user-binding', () => {
    it('T1 — happy: valid bearer + valid sig → 200, Device.userId set, JWT carries userId', async () => {
        const u = await makeUserFixture();
        const km = freshKeyMaterial();
        try {
            const r = await app.inject({
                method: 'POST',
                url: '/v1/auth',
                headers: { authorization: `Bearer ${u.sessionToken}` },
                payload: {
                    publicKey: km.publicKeyB64,
                    challenge: km.challengeB64,
                    signature: km.signatureB64,
                },
            });
            expect(r.statusCode).toBe(200);
            const body = r.json() as {
                success: boolean;
                token: string;
                deviceId: string;
                expiresInDays: number;
            };
            expect(body.success).toBe(true);
            expect(body.deviceId).toBeTruthy();

            // Device row carries userId.
            const device = await db.device.findUnique({
                where: { publicKey: km.publicKeyB64 },
            });
            expect(device).not.toBeNull();
            expect(device!.userId).toBe(u.userId);

            // JWT payload decodes with deviceId AND userId.
            const decoded = jwt.verify(body.token, config.masterSecret) as {
                deviceId: string;
                userId: string;
            };
            expect(decoded.deviceId).toBe(body.deviceId);
            expect(decoded.userId).toBe(u.userId);
        } finally {
            await u.cleanup();
        }
    });

    it('T2 — unconditional rebind: publicKey owned by userA, userB auths → 200, Device.userId becomes userB', async () => {
        // Account-only refactor (CONTRACT §2.4): the hijack-409 guard is retired.
        // The device keypair is a non-identity transport handle; a phone always
        // rebinds to whoever is logged in. DEVICE_OWNED_BY_OTHER_USER no longer exists.
        const userA = await makeUserFixture();
        const userB = await makeUserFixture();
        const km = freshKeyMaterial();
        try {
            // Plant a Device row owned by userA at this publicKey.
            await db.device.create({
                data: {
                    publicKey: km.publicKeyB64,
                    name: 'A device',
                    userId: userA.userId,
                    lastSeenAt: new Date(),
                },
            });

            // userB submits a cryptographically-VALID request for the same
            // publicKey. It must succeed and rebind ownership to userB.
            const r = await app.inject({
                method: 'POST',
                url: '/v1/auth',
                headers: { authorization: `Bearer ${userB.sessionToken}` },
                payload: {
                    publicKey: km.publicKeyB64,
                    challenge: km.challengeB64,
                    signature: km.signatureB64,
                },
            });
            expect(r.statusCode).toBe(200);

            // Post-state: Device.userId is now userB — unconditional rebind.
            const after = await db.device.findUnique({
                where: { publicKey: km.publicKeyB64 },
            });
            expect(after!.userId).toBe(userB.userId);
        } finally {
            await db.device
                .deleteMany({ where: { publicKey: km.publicKeyB64 } })
                .catch(() => {});
            await userA.cleanup();
            await userB.cleanup();
        }
    });

    it('T3 — legacy rebind: Device.userId NULL + valid bearer → upsert sets userId', async () => {
        const u = await makeUserFixture();
        const km = freshKeyMaterial();
        try {
            // Simulate a pre-Slice-7 chat-side install: row exists with no user.
            await db.device.create({
                data: {
                    publicKey: km.publicKeyB64,
                    name: 'Legacy device',
                    userId: null,
                    lastSeenAt: new Date(Date.now() - 86400_000),
                },
            });

            const r = await app.inject({
                method: 'POST',
                url: '/v1/auth',
                headers: { authorization: `Bearer ${u.sessionToken}` },
                payload: {
                    publicKey: km.publicKeyB64,
                    challenge: km.challengeB64,
                    signature: km.signatureB64,
                },
            });
            expect(r.statusCode).toBe(200);

            const after = await db.device.findUnique({
                where: { publicKey: km.publicKeyB64 },
            });
            expect(after!.userId).toBe(u.userId);
        } finally {
            await db.device
                .deleteMany({ where: { publicKey: km.publicKeyB64 } })
                .catch(() => {});
            await u.cleanup();
        }
    });

    it('T4 — idempotent: same user re-auth on same device → 200, lastSeenAt bumped', async () => {
        const u = await makeUserFixture();
        const km = freshKeyMaterial();
        try {
            // First auth establishes the row.
            const first = await app.inject({
                method: 'POST',
                url: '/v1/auth',
                headers: { authorization: `Bearer ${u.sessionToken}` },
                payload: {
                    publicKey: km.publicKeyB64,
                    challenge: km.challengeB64,
                    signature: km.signatureB64,
                },
            });
            expect(first.statusCode).toBe(200);
            const before = await db.device.findUnique({
                where: { publicKey: km.publicKeyB64 },
            });
            expect(before!.userId).toBe(u.userId);
            const lastSeenBefore = before!.lastSeenAt!;

            // Ensure measurable wall-clock gap so lastSeenAt change is detectable.
            await new Promise((res) => setTimeout(res, 25));

            const second = await app.inject({
                method: 'POST',
                url: '/v1/auth',
                headers: { authorization: `Bearer ${u.sessionToken}` },
                payload: {
                    publicKey: km.publicKeyB64,
                    challenge: km.challengeB64,
                    signature: km.signatureB64,
                },
            });
            expect(second.statusCode).toBe(200);
            const after = await db.device.findUnique({
                where: { publicKey: km.publicKeyB64 },
            });
            expect(after!.userId).toBe(u.userId);
            expect(after!.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(
                lastSeenBefore.getTime(),
            );
        } finally {
            await u.cleanup();
        }
    });

    it('T5 — missing user bearer → 401 MISSING_USER_SESSION', async () => {
        const km = freshKeyMaterial();
        const r = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            // No authorization header at all.
            payload: {
                publicKey: km.publicKeyB64,
                challenge: km.challengeB64,
                signature: km.signatureB64,
            },
        });
        expect(r.statusCode).toBe(401);
        expect((r.json() as { error: { code: string } }).error.code).toBe(
            'MISSING_USER_SESSION',
        );
        // Side effect: no Device row created (guard fires before upsert).
        const dev = await db.device.findUnique({
            where: { publicKey: km.publicKeyB64 },
        });
        expect(dev).toBeNull();
    });

    it('T6 — invalid user bearer (revoked) → 401 INVALID_SESSION', async () => {
        const u = await makeUserFixture();
        const km = freshKeyMaterial();
        try {
            // Revoke the session — the token itself is still well-formed but
            // resolveUserSession must reject it.
            await db.userSession.update({
                where: { id: u.sessionId },
                data: { revokedAt: new Date() },
            });

            const r = await app.inject({
                method: 'POST',
                url: '/v1/auth',
                headers: { authorization: `Bearer ${u.sessionToken}` },
                payload: {
                    publicKey: km.publicKeyB64,
                    challenge: km.challengeB64,
                    signature: km.signatureB64,
                },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: { code: string } }).error.code).toBe(
                'INVALID_SESSION',
            );
        } finally {
            await u.cleanup();
        }
    });

    it('T6b — garbage bearer (wrong prefix) → 401 INVALID_SESSION', async () => {
        const km = freshKeyMaterial();
        const r = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            headers: { authorization: 'Bearer not_a_valid_token' },
            payload: {
                publicKey: km.publicKeyB64,
                challenge: km.challengeB64,
                signature: km.signatureB64,
            },
        });
        expect(r.statusCode).toBe(401);
        expect((r.json() as { error: { code: string } }).error.code).toBe(
            'INVALID_SESSION',
        );
    });

    it('T7 — valid bearer + invalid signature → 401 Invalid signature', async () => {
        const u = await makeUserFixture();
        const km = freshKeyMaterial();
        try {
            // Tamper the signature — flip a byte so verification fails.
            const badSig = new Uint8Array(64);
            const r = await app.inject({
                method: 'POST',
                url: '/v1/auth',
                headers: { authorization: `Bearer ${u.sessionToken}` },
                payload: {
                    publicKey: km.publicKeyB64,
                    challenge: km.challengeB64,
                    signature: encodeBase64(badSig),
                },
            });
            expect(r.statusCode).toBe(401);
            expect((r.json() as { error: string }).error).toBe('Invalid signature');

            // Side effect: no Device row was created (signature fail short-
            // circuits BEFORE upsert).
            const dev = await db.device.findUnique({
                where: { publicKey: km.publicKeyB64 },
            });
            expect(dev).toBeNull();
        } finally {
            await u.cleanup();
        }
    });
});
