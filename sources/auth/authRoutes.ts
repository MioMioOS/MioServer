/**
 * Slice 7 — Task A5: device-keypair auth now binds the Device row to a User.
 *
 * Every POST /v1/auth call MUST carry a valid `Authorization: Bearer user_sess_…`
 * (the user-side session token minted by /v1/users/signin). The handler:
 *   1. Resolves the user_sess_ token → UserSession (401 MISSING_USER_SESSION if
 *      absent, 401 INVALID_SESSION if present-but-invalid/expired/revoked).
 *   2. Verifies the ed25519 challenge/signature against the supplied publicKey
 *      (unchanged, 401 'Invalid signature').
 *   3. Hijack guard — if a Device row already exists for this publicKey and is
 *      bound to a DIFFERENT user, refuse with 409 DEVICE_OWNED_BY_OTHER_USER.
 *      Fires BEFORE upsert so the row never enters a transient ownership state.
 *      Legacy rows with userId=NULL (chat-side installs from before Slice 7)
 *      rebind to the caller — that's the migration path.
 *   4. Upserts the Device with userId set, mints a JWT carrying both deviceId
 *      AND userId in its payload.
 *
 * Spec: docs/superpowers/specs/2026-05-26-slock-clone-slice7-user-auth-unification-design.md §6.1
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

        // Step 3: hijack guard — fires BEFORE upsert so we never write a row
        // into a half-transferred state. The check is on the EXISTING Device's
        // userId, not on the signature: even a cryptographically-valid request
        // is refused if the publicKey is already bound to someone else.
        // userId=NULL (legacy chat-side install) is treated as rebindable —
        // that's the upgrade path, see T3.
        const existing = await db.device.findUnique({ where: { publicKey } });
        if (existing && existing.userId !== null && existing.userId !== userSession.userId) {
            return reply
                .code(409)
                .send({ error: { code: 'DEVICE_OWNED_BY_OTHER_USER' } });
        }

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
     * machine_token for a monitoring identity so ONE QR scan sets up both
     * universes:
     *   - verifies the Bearer machine_token → ControlMachine
     *   - resolves the org OWNER (the enrolling user) via UserWorkroomMembership
     *   - upserts a kind='mac' Device BRIDGED to the ControlMachine
     *     (Device.controlMachineId — the R2.3 monitoring↔workspace bridge, which
     *     also lets the enrollment machine-reuse lookup find this Mac), keyed by
     *     a synthetic, stable publicKey `mtok:<machineId>` for idempotency
     *   - lazily mints the permanent monitoring shortCode
     *   - returns a device JWT (carrying deviceId + the owner userId) the daemon
     *     uses to push live sessions, plus the shortCode the pairing QR embeds
     *
     * SECURITY: machine_token authority only; never logs the token. The minted
     * Device is bound to the org owner's userId so the phone (same user) sees it.
     */
    app.post('/v1/auth/machine', async (request, reply) => {
        const machine = await verifyMachineToken(request.headers.authorization);
        if (!machine) {
            return reply.code(401).send({ error: { code: 'INVALID_MACHINE_TOKEN' } });
        }
        if (!machine.orgId) {
            // A machine registered but never bound into a workspace org has no
            // owner to attribute the monitoring Device to.
            return reply.code(409).send({ error: { code: 'MACHINE_NOT_IN_ORG' } });
        }

        // Resolve the org owner = the user who enrolled this machine's workspace.
        // ControlOrg.ownerUserId is a synthetic uuid (no User FK, see
        // provisionPersonalWorkspace), so the authoritative owner is the
        // UserWorkroomMembership(role='owner') on a workroom of this org.
        const workrooms = await db.controlWorkroom.findMany({
            where: { orgId: machine.orgId },
            select: { id: true },
        });
        const ownerMembership = workrooms.length
            ? await db.userWorkroomMembership.findFirst({
                  where: { workroomId: { in: workrooms.map((w) => w.id) }, role: 'owner' },
                  orderBy: { createdAt: 'asc' },
              })
            : null;
        if (!ownerMembership) {
            return reply.code(409).send({ error: { code: 'NO_OWNER_FOR_MACHINE' } });
        }
        const ownerUserId = ownerMembership.userId;

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
                userId: ownerUserId,
                controlMachineId: machine.id,
            },
            update: {
                lastSeenAt: now,
                kind: 'mac',
                userId: ownerUserId,
                controlMachineId: machine.id,
            },
        });

        const shortCode = await ensureShortCode(device.id);
        const ttl = config.tokenExpiryDays;
        const token = createToken(device.id, ownerUserId, config.masterSecret, ttl);
        return { success: true, token, deviceId: device.id, shortCode, expiresInDays: ttl };
    });
}
