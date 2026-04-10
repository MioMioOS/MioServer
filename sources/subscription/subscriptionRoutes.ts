import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '@/auth/middleware';
import { verifyPayment, checkAccess, getDeviceSubscription, revokeSubscription } from './subscriptionService';
import { getActiveCount } from './concurrencyGuard';
import { config } from '@/config';
import { eventRouter } from '@/socket/socketServer';

export async function subscriptionRoutes(app: FastifyInstance) {
    // ─────────────────────────────────────────────────────────────────────
    // Verify payment (iPhone calls this after StoreKit 2 purchase)
    // ─────────────────────────────────────────────────────────────────────
    app.post('/v1/subscription/verify', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({
                originalTransactionId: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const { originalTransactionId } = request.body as { originalTransactionId: string };
        const deviceId = request.deviceId!;

        const result = await verifyPayment(deviceId, originalTransactionId);

        // Notify connected sockets that subscription status changed
        eventRouter.emitToDevice(deviceId, 'subscription-updated', { status: 'active' });

        return result;
    });

    // ─────────────────────────────────────────────────────────────────────
    // Query subscription status
    // ─────────────────────────────────────────────────────────────────────
    app.get('/v1/subscription/status', {
        preHandler: authMiddleware,
    }, async (request) => {
        const deviceId = request.deviceId!;
        const access = await checkAccess(deviceId);
        const sub = await getDeviceSubscription(deviceId);

        return {
            status: access.status,
            allowed: access.allowed,
            reason: access.reason,
            daysLeft: access.daysLeft,
            maxDevices: config.maxConcurrentDevices,
            currentDevices: sub?.originalTransactionId
                ? getActiveCount(sub.originalTransactionId)
                : 0,
        };
    });

    // ─────────────────────────────────────────────────────────────────────
    // App Store Server Notifications V2 webhook (refund/revoke)
    // No auth middleware — Apple signs the payload with JWT
    // ─────────────────────────────────────────────────────────────────────
    app.post('/v1/subscription/revoke', {
        schema: {
            body: z.object({
                signedPayload: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const { signedPayload } = request.body as { signedPayload: string };

        // Apple Server Notifications V2 sends a JWS (JSON Web Signature).
        // For now, decode the payload without full Apple root cert verification.
        // Full verification requires fetching Apple's root certificate chain.
        // TODO: Add full Apple JWS verification with apple-root-ca cert chain
        try {
            // JWS format: header.payload.signature
            const parts = signedPayload.split('.');
            if (parts.length !== 3) {
                return reply.code(400).send({ error: 'Invalid JWS format' });
            }

            const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
            const payload = JSON.parse(payloadJson);

            // Extract notification type and transaction info
            const notificationType = payload.notificationType;

            // We care about REFUND and REVOKE notifications
            if (notificationType !== 'REFUND' && notificationType !== 'REVOKE') {
                // Acknowledge but ignore other notification types
                return { ok: true, handled: false };
            }

            // The transaction info is in data.signedTransactionInfo (also JWS)
            const signedTxnInfo = payload.data?.signedTransactionInfo;
            if (!signedTxnInfo) {
                return reply.code(400).send({ error: 'Missing signedTransactionInfo' });
            }

            const txnParts = signedTxnInfo.split('.');
            if (txnParts.length !== 3) {
                return reply.code(400).send({ error: 'Invalid transaction JWS' });
            }

            const txnJson = Buffer.from(txnParts[1], 'base64url').toString('utf8');
            const txnInfo = JSON.parse(txnJson);
            const originalTransactionId = txnInfo.originalTransactionId;

            if (!originalTransactionId) {
                return reply.code(400).send({ error: 'Missing originalTransactionId' });
            }

            const affected = await revokeSubscription(originalTransactionId);

            console.log(`[subscription] App Store revoke: type=${notificationType}, txn=${originalTransactionId}, affected=${affected}`);

            return { ok: true, handled: true, affected };
        } catch (err) {
            console.error('[subscription] Failed to process App Store notification:', err);
            return reply.code(400).send({ error: 'Failed to parse notification' });
        }
    });
}
