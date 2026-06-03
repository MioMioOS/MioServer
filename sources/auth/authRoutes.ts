/**
 * POST /v1/auth — device-keypair registration (account-only identity refactor,
 * 2026-06-03; CONTRACT §2.4).
 *
 * Every POST /v1/auth call MUST carry a valid `Authorization: Bearer user_sess_…`.
 * The handler:
 *   1. Resolves the user_sess_ token → UserSession (401 MISSING_USER_SESSION if
 *      absent, 401 INVALID_SESSION if present-but-invalid/expired/revoked).
 *   2. Verifies the ed25519 challenge/signature against the supplied publicKey
 *      (unchanged, 401 'Invalid signature').
 *   3. Upserts the Device, UNCONDITIONALLY rebinding userId to the caller. The
 *      hijack-409 guard is GONE — the device keypair is a non-identity transport
 *      handle (push/socket target), not an ownership authority. Ownership lives
 *      in AccountComputerLink. DEVICE_OWNED_BY_OTHER_USER is retired.
 *   4. Mints a JWT carrying deviceId + userId in its payload.
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifySignature, createToken } from './crypto';
import { resolveUserSession } from './userSession/resolveUserSession';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { ensureShortCode } from '@/devices/devicesRoutes';
import { db } from '@/storage/db';
import { config } from '@/config';

export async function authRoutes(app: FastifyInstance) {
    app.post('/v1/auth', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                challenge: z.string(),
                signature: z.string(),
                // Optional client-chosen TTL in days. Clamped to a sane
                // range; falls back to the server default if absent or
                // out of bounds. Lets the iOS Settings picker actually
                // control how long the JWT lives.
                expiryDays: z.number().int().min(1).max(365).optional(),
            }),
        },
    }, async (request, reply) => {
        // Step 1: hard-require valid user_sess_ Bearer (Slice 7 §6.1).
        // We distinguish MISSING (no/non-Bearer header at all) from INVALID
        // (a header was supplied but didn't resolve to a live session) so the
        // iOS client can show "please sign in" vs "your session expired".
        const auth = request.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) {
            return reply.code(401).send({ error: { code: 'MISSING_USER_SESSION' } });
        }
        const userSession = await resolveUserSession(auth);
        if (!userSession) {
            return reply.code(401).send({ error: { code: 'INVALID_SESSION' } });
        }

        const { publicKey, challenge, signature, expiryDays } = request.body as {
            publicKey: string;
            challenge: string;
            signature: string;
            expiryDays?: number;
        };

        // Step 2: existing signature check (preserved verbatim).
        if (!verifySignature(challenge, signature, publicKey)) {
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        // Step 3 (account-only refactor, CONTRACT §2.4): the hijack-409 guard is
        // GONE. A phone keypair always rebinds to whoever is logged in — the
        // device keypair is a non-identity transport handle now, not an
        // ownership authority. `Device.userId` for kind='ios' is just "last
        // logged-in account on this phone". The DEVICE_OWNED_BY_OTHER_USER code
        // is retired; clients must remove all handling of it.
        const now = new Date();
        const device = await db.device.upsert({
            where: { publicKey },
            create: {
                publicKey,
                name: 'Unknown Device',
                lastSeenAt: now,
                userId: userSession.userId,
            },
            // Touch lastSeenAt on every fresh auth so the proactive
            // staleness filter in notifyLinkedIPhones knows the iPhone
            // is alive at this exact moment. Also (re)assert userId so
            // legacy null-userId rows rebind to the caller (T3) and the
            // same-user re-auth case stays idempotent (T4).
            update: { lastSeenAt: now, userId: userSession.userId },
        });

        // Step 4: JWT payload now carries userId alongside deviceId. Downstream
        // middleware (middleware.ts) still only reads deviceId today, but new
        // user-aware code paths can pluck userId from the payload without a
        // second DB round-trip.
        const ttl = expiryDays && expiryDays > 0 ? expiryDays : config.tokenExpiryDays;
        const token = createToken(device.id, userSession.userId, config.masterSecret, ttl);
        return { success: true, token, deviceId: device.id, expiresInDays: ttl };
    });

    /**
     * POST /v1/auth/machine — monitoring auth for the Mac daemon (MioIsland).
     *
     * The Slock daemon is machine-scoped: it has NO user_sess_, so it cannot use
     * POST /v1/auth (which hard-requires one since Slice 7). But after workspace
     * enrollment it DOES hold a `machine_token`. This endpoint exchanges that
     * machine_token for a monitoring identity:
     *   - verifies the Bearer machine_token → ControlMachine
     *   - upserts a kind='mac' Device BRIDGED to the ControlMachine
     *     (Device.controlMachineId — the R2.3 monitoring↔workspace bridge, which
     *     also lets the enrollment machine-reuse lookup find this Mac), keyed by
     *     a synthetic, stable publicKey `mtok:<machineId>` for idempotency
     *   - lazily mints the permanent monitoring shortCode
     *   - returns an OWNERLESS device JWT (userId claim = '') the daemon uses as
     *     a push transport handle, plus the shortCode the pairing QR embeds
     *
     * Account-only refactor (CONTRACT §2.6): the computer is OWNERLESS. We no
     * longer resolve an org owner or bind Device.userId. Ownership is expressed
     * solely via AccountComputerLink, set later by a phone scan.
     *
     * SECURITY: machine_token authority only; never logs the token.
     */
    app.post('/v1/auth/machine', async (request, reply) => {
        const machine = await verifyMachineToken(request.headers.authorization);
        if (!machine) {
            return reply.code(401).send({ error: { code: 'INVALID_MACHINE_TOKEN' } });
        }

        // Account-only refactor (CONTRACT §2.6): the computer is OWNERLESS here.
        // We no longer resolve an org owner and we no longer bind Device.userId.
        // Ownership is expressed solely via AccountComputerLink, established later
        // by a phone scan (POST /v1/pairing/computer). A fresh Mac with no
        // workspace enrollment (machine.orgId == null) is still minted + given a
        // shortCode so it is scannable before any workspace exists. The MACHINE_NOT_IN_ORG
        // / NO_OWNER_FOR_MACHINE 409s are retired.

        const now = new Date();
        // Synthetic, stable publicKey — the Mac monitoring identity has no
        // ed25519 keypair (that was the legacy /v1/auth flow). Keying the upsert
        // on the machine id keeps re-auth idempotent.
        const syntheticPublicKey = `mtok:${machine.id}`;
        const device = await db.device.upsert({
            where: { publicKey: syntheticPublicKey },
            create: {
                publicKey: syntheticPublicKey,
                name: machine.displayName ?? 'Mac',
                kind: 'mac',
                lastSeenAt: now,
                userId: null,
                controlMachineId: machine.id,
            },
            update: {
                lastSeenAt: now,
                kind: 'mac',
                userId: null,
                controlMachineId: machine.id,
            },
        });

        const shortCode = await ensureShortCode(device.id);
        const ttl = config.tokenExpiryDays;
        // Ownerless: the JWT carries an empty userId claim. The daemon uses this
        // token only as a push transport handle, never for authority.
        const token = createToken(device.id, '', config.masterSecret, ttl);
        return { success: true, token, deviceId: device.id, shortCode, expiresInDays: ttl };
    });
}
