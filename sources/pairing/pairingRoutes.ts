import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '@/storage/db';
import { authMiddleware } from '@/auth/middleware';
import { requireUser } from '@/auth/userSession/requireUser';
import { invalidateAccessCache } from '@/auth/deviceAccess';
import { eventRouter } from '@/socket/socketServer';
import { maskEmail } from '@/auth/maskEmail';
import { sendPushToDevice } from '@/push/apns';
import { config } from '@/config';

// In-memory rate limiter for Mac /v1/pairing/redeem-code. 10 fails/hour/device.
const macRedeemFailures = new Map<string, { count: number; resetAt: number }>();

function macIsRateLimited(deviceId: string): boolean {
    const now = Date.now();
    const entry = macRedeemFailures.get(deviceId);
    if (!entry || entry.resetAt < now) return false;
    return entry.count >= 10;
}

function macRecordFailure(deviceId: string): void {
    const now = Date.now();
    const entry = macRedeemFailures.get(deviceId);
    if (!entry || entry.resetAt < now) {
        macRedeemFailures.set(deviceId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    } else {
        entry.count++;
    }
}

function macClearFailures(deviceId: string): void {
    macRedeemFailures.delete(deviceId);
}

/// Same staleness window the rest of the system uses (mirrors notify.ts /
/// sessionHandler.ts): JWT TTL + 1 day grace.
function getStaleThresholdMs(): number {
    const days = (config.tokenExpiryDays || 30) + 1;
    return days * 24 * 60 * 60 * 1000;
}

/**
 * Fire-and-forget APNs alert to every phone of a DISPLACED account after a
 * force-takeover (CONTRACT §5). Master kill-switch + staleness apply; per-kind
 * toggles do NOT (this is an account-security notice). Must run OUTSIDE the
 * takeover transaction — a push failure must never roll back a committed takeover.
 */
async function notifyDisplacedAccount(oldUserId: string, computerId: string, computerName: string): Promise<void> {
    const phones = await db.device.findMany({
        where: { userId: oldUserId, kind: 'ios' },
        select: { id: true, notificationsEnabled: true, lastSeenAt: true },
    });
    const staleCutoff = Date.now() - getStaleThresholdMs();
    const payload = {
        title: 'Computer disconnected',
        body: `“${computerName}” was linked to another account and is no longer connected to this account.`,
        data: { kind: 'computer_taken_over', computerId },
    };
    for (const phone of phones) {
        if (!phone.notificationsEnabled) continue;
        if (phone.lastSeenAt && phone.lastSeenAt.getTime() < staleCutoff) continue;
        sendPushToDevice(phone.id, payload, db).catch((err) =>
            console.error('[takeover-notify] push failed', err)
        );
    }
}

export async function pairingRoutes(app: FastifyInstance) {
    // ─────────────────────────────────────────────────────────────────────
    // Scan / Pair — account↔computer (account-only identity refactor, §2.1).
    // Replaces the retired device↔device redeem flow. Auth: user_sess_.
    // ─────────────────────────────────────────────────────────────────────
    app.post('/v1/pairing/computer', {
        preHandler: requireUser(),
        schema: {
            body: z.object({
                code: z.string().min(4).max(12),
                force: z.boolean().optional().default(false),
            }),
        },
    }, async (request, reply) => {
        try {
            const current = request.user!.id;
            const { code, force } = request.body as { code: string; force: boolean };
            const normalized = code.toUpperCase().trim();

            const computer = await db.device.findUnique({
                where: { shortCode: normalized },
                select: { id: true, name: true, kind: true },
            });
            if (!computer) {
                return reply.code(404).send({ error: { code: 'INVALID_CODE' } });
            }
            if (computer.kind !== 'mac') {
                return reply.code(400).send({ error: { code: 'NOT_A_MAC' } });
            }
            const computerId = computer.id;
            const computerOut = { computerId, name: computer.name, kind: computer.kind };

            const existing = await db.accountComputerLink.findUnique({ where: { computerId } });

            // Branch 1: no link → create.
            if (!existing) {
                await db.accountComputerLink.create({ data: { userId: current, computerId } });
                invalidateAccessCache();
                return reply.code(200).send({ status: 'linked', computer: computerOut });
            }

            // Branch 2: same account → idempotent.
            if (existing.userId === current) {
                return reply.code(200).send({ status: 'already_linked_self', computer: computerOut });
            }

            // Branch 3: other account, no force → refuse with masked email.
            if (!force) {
                const owner = await db.user.findUnique({
                    where: { id: existing.userId },
                    select: { email: true },
                });
                const maskedEmail = owner ? maskEmail(owner.email) : '***';
                return reply.code(409).send({
                    error: { code: 'ALREADY_LINKED_OTHER_ACCOUNT', maskedEmail, computerId },
                });
            }

            // Branch 4: other account + force → takeover (§4), atomic.
            const oldUserId = existing.userId;
            const owner = await db.user.findUnique({
                where: { id: oldUserId },
                select: { email: true },
            });
            const displacedMaskedEmail = owner ? maskEmail(owner.email) : '***';

            try {
                await db.$transaction(async (tx) => {
                    // Step 1: CAS re-read.
                    const link = await tx.accountComputerLink.findUnique({ where: { computerId } });
                    if (!link || link.userId !== oldUserId) {
                        throw Object.assign(new Error('takeover_race'), { code: 'TAKEOVER_RACE' });
                    }

                    // Step 2: delete old link.
                    await tx.accountComputerLink.delete({ where: { computerId } });

                    // Step 3: transfer workspace owner membership old → new.
                    const dev = await tx.device.findUnique({
                        where: { id: computerId },
                        select: { controlMachineId: true },
                    });
                    if (dev?.controlMachineId) {
                        const cmachine = await tx.controlMachine.findUnique({
                            where: { id: dev.controlMachineId },
                            select: { orgId: true },
                        });
                        if (cmachine?.orgId) {
                            const workrooms = await tx.controlWorkroom.findMany({
                                where: { orgId: cmachine.orgId },
                                select: { id: true },
                            });
                            const wkIds = workrooms.map((w) => w.id);
                            if (wkIds.length > 0) {
                                // Conflict guard (UNIQUE(userId, workroomId)): drop the
                                // new user's pre-existing rows in these workrooms FIRST,
                                // then move old → new. Ordering is mandatory.
                                await tx.userWorkroomMembership.deleteMany({
                                    where: { workroomId: { in: wkIds }, userId: current },
                                });
                                await tx.userWorkroomMembership.updateMany({
                                    where: { workroomId: { in: wkIds }, userId: oldUserId, role: 'owner' },
                                    data: { userId: current },
                                });
                            }
                        }
                    }

                    // Step 4: create new link.
                    await tx.accountComputerLink.create({ data: { userId: current, computerId } });
                });
            } catch (err: any) {
                if (err?.code === 'TAKEOVER_RACE') {
                    return reply.code(409).send({ error: { code: 'TAKEOVER_RACE' } });
                }
                throw err;
            }

            // Post-commit, best-effort.
            invalidateAccessCache();
            notifyDisplacedAccount(oldUserId, computerId, computer.name).catch((err) =>
                console.error('[takeover] notify failed', err)
            );

            return reply.code(200).send({
                status: 'taken_over',
                computer: computerOut,
                displacedMaskedEmail,
            });
        } catch (err: any) {
            console.error('[pairing/computer] unexpected error:', err);
            return reply.code(500).send({ error: { code: 'SERVER_ERROR' } });
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    // Mac-side trial redemption (orthogonal to account pairing; KEPT).
    // Mac inputs a FREE-XXXXXXXX code, gets a trial. Auth: device JWT (Mac).
    //
    // Error envelope is stable: { error: <machine-readable-key>, message: <human> }.
    // ─────────────────────────────────────────────────────────────────────
    app.post('/v1/pairing/redeem-code', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({ code: z.string().min(1).max(50) }),
        },
    }, async (request, reply) => {
        const macDeviceId = request.deviceId!;
        const { code } = request.body as { code: string };
        const normalized = code.trim().toUpperCase();

        try {

        if (macIsRateLimited(macDeviceId)) {
            return reply.code(429).send({
                error: 'rate_limited',
                message: 'Too many failed attempts. Try again in an hour.',
            });
        }

        // Confirm the caller is a Mac. Phones can't redeem (Apple rule).
        const device = await db.device.findUnique({
            where: { id: macDeviceId },
            select: { kind: true, trialExpiresAt: true, subscriptionStatus: true },
        });
        if (!device) {
            return reply.code(401).send({ error: 'unauthorized', message: 'Device not found' });
        }
        if (device.kind !== 'mac') {
            return reply.code(403).send({
                error: 'not_a_mac',
                message: 'Only Mac devices can redeem trial codes',
            });
        }

        const redeemCode = await db.redeemCode.findUnique({ where: { code: normalized } });
        if (!redeemCode) {
            macRecordFailure(macDeviceId);
            return reply.code(404).send({ error: 'invalid_code', message: 'Invalid redeem code' });
        }

        if (redeemCode.expiresAt && redeemCode.expiresAt < new Date()) {
            return reply.code(410).send({ error: 'code_expired', message: 'This code has expired' });
        }

        // Admin-revoked codes carry maxUses=0.
        if (redeemCode.maxUses === 0) {
            return reply.code(410).send({ error: 'code_revoked', message: 'This code has been revoked' });
        }

        // Same Mac can't redeem the same code twice.
        const existingUsage = await db.redeemCodeUsage.findUnique({
            where: {
                redeemCodeId_deviceId: {
                    redeemCodeId: redeemCode.id,
                    deviceId: macDeviceId,
                },
            },
        });
        if (existingUsage) {
            return reply.code(409).send({
                error: 'already_redeemed',
                message: 'This Mac has already used this code',
            });
        }

        // Stack new duration on top of the Mac's own unexpired trial.
        const now = Date.now();
        const selfExpiry = device.trialExpiresAt ? device.trialExpiresAt.getTime() : 0;
        const baseTime = selfExpiry > now ? selfExpiry : now;
        const grantedUntil = new Date(baseTime + redeemCode.durationDays * 24 * 60 * 60 * 1000);

        // Atomic exhausted-check + bump + write inside a transaction so
        // concurrent redeems can't oversell a maxUses=N code.
        try {
            await db.$transaction(async (tx) => {
                const fresh = await tx.redeemCode.findUnique({
                    where: { id: redeemCode.id },
                    select: { usedCount: true, maxUses: true },
                });
                if (!fresh || fresh.usedCount >= fresh.maxUses) {
                    throw Object.assign(new Error('exhausted'), { code: 'code_exhausted' });
                }

                await tx.redeemCodeUsage.create({
                    data: { redeemCodeId: redeemCode.id, deviceId: macDeviceId, grantedUntil },
                });
                await tx.redeemCode.update({
                    where: { id: redeemCode.id },
                    data: { usedCount: { increment: 1 } },
                });
                await tx.device.update({
                    where: { id: macDeviceId },
                    data: {
                        subscriptionStatus: 'active',
                        trialExpiresAt: grantedUntil,
                    },
                });
            });
        } catch (err: any) {
            if (err?.code === 'code_exhausted') {
                return reply.code(410).send({
                    error: 'code_exhausted',
                    message: 'This code has been fully redeemed',
                });
            }
            throw err;
        }

        macClearFailures(macDeviceId);

        const daysLeft = Math.max(
            0,
            Math.ceil((grantedUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
        );
        const expiresAtISO = grantedUntil.toISOString();

        // Self-broadcast so the Mac's own UI reflects the new state without
        // having to re-fetch /v1/subscription/status.
        eventRouter.emitToDevice(macDeviceId, 'subscription-updated', {
            status: 'trial',
            expiresAt: expiresAtISO,
            source: 'redeem_code',
            daysLeft,
        });

        console.log(
            `[pairing-redeem] Mac ${macDeviceId} redeemed ${normalized}, granted ${redeemCode.durationDays}d`
        );

        return {
            success: true,
            durationDays: redeemCode.durationDays,
            expiresAt: expiresAtISO,
        };

        } catch (err: any) {
            console.error(`[pairing-redeem] Unexpected error for Mac ${macDeviceId}:`, err);
            return reply.code(500).send({
                error: 'server_error',
                message: err?.message || 'Internal server error',
            });
        }
    });
}
