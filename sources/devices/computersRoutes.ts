import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '@/storage/db';
import { requireUser } from '@/auth/userSession/requireUser';
import { invalidateAccessCache } from '@/auth/deviceAccess';
import { config } from '@/config';

/// Online = lastSeenAt within the system's heartbeat/staleness window. Reuse the
/// SAME rule the rest of the system uses (JWT TTL + 1 day grace) — do NOT invent
/// a new threshold (CONTRACT §2.2).
function getStaleThresholdMs(): number {
    const days = (config.tokenExpiryDays || 30) + 1;
    return days * 24 * 60 * 60 * 1000;
}

export async function computersRoutes(app: FastifyInstance) {
    // ─────────────────────────────────────────────────────────────────────
    // Account-scoped computer LIST (CONTRACT §2.2). Phone calls this after
    // login; a new phone auto-sees the account's computers with no scan.
    // ─────────────────────────────────────────────────────────────────────
    app.get('/v1/computers', {
        preHandler: requireUser(),
    }, async (request) => {
        const current = request.user!.id;

        const links = await db.accountComputerLink.findMany({
            where: { userId: current },
            orderBy: { createdAt: 'desc' },
        });
        if (links.length === 0) {
            return { computers: [] };
        }

        const linkedAtById = new Map(links.map((l) => [l.computerId, l.createdAt]));
        const devices = await db.device.findMany({
            where: { id: { in: links.map((l) => l.computerId) }, kind: 'mac' },
            select: { id: true, name: true, kind: true, lastSeenAt: true, shortCode: true },
        });

        const staleCutoff = Date.now() - getStaleThresholdMs();
        // Preserve the links ordering (createdAt desc); devices come back unordered.
        const byId = new Map(devices.map((d) => [d.id, d]));
        const computers = links
            .map((l) => byId.get(l.computerId))
            .filter((d): d is NonNullable<typeof d> => d != null)
            .map((d) => ({
                computerId: d.id,
                name: d.name,
                kind: d.kind,
                linkedAt: linkedAtById.get(d.id)!.toISOString(),
                lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
                online: d.lastSeenAt != null && d.lastSeenAt.getTime() >= staleCutoff,
            }));

        return { computers };
    });

    // ─────────────────────────────────────────────────────────────────────
    // Unlink one computer from the calling account (CONTRACT §2.5).
    // ─────────────────────────────────────────────────────────────────────
    app.delete('/v1/computers/:computerId', {
        preHandler: requireUser(),
        schema: {
            params: z.object({ computerId: z.string() }),
        },
    }, async (request, reply) => {
        const current = request.user!.id;
        const { computerId } = request.params as { computerId: string };

        const deleted = await db.accountComputerLink.deleteMany({
            where: { userId: current, computerId },
        });
        if (deleted.count === 0) {
            return reply.code(404).send({ error: { code: 'LINK_NOT_FOUND' } });
        }
        // No push-token cascade — computers don't receive APNs; phone push tokens
        // are unaffected by unlinking a computer.
        invalidateAccessCache();
        return { ok: true };
    });
}
