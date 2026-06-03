import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '@/storage/db';
import { authMiddleware } from '@/auth/middleware';
import { requireUser } from '@/auth/userSession/requireUser';
import { getAccessibleComputerIds } from '@/auth/deviceAccess';

// Charset excludes I, L, O, 0, 1 to avoid visual confusion.
const SHORT_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SHORT_CODE_LENGTH = 6;

function generateShortCode(): string {
    let code = '';
    for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
        code += SHORT_CODE_CHARSET[Math.floor(Math.random() * SHORT_CODE_CHARSET.length)];
    }
    return code;
}

/**
 * Lazily assign a permanent shortCode to a Mac device. Idempotent.
 * Returns the existing shortCode if already set, or a freshly generated unique one.
 *
 * Exported so the machine-token monitoring-auth path (`POST /v1/auth/machine`)
 * can mint a shortCode for a Mac that authenticates with its enrollment
 * machine_token instead of the legacy device keypair.
 */
export async function ensureShortCode(deviceId: string): Promise<string> {
    const existing = await db.device.findUnique({
        where: { id: deviceId },
        select: { shortCode: true },
    });
    if (existing?.shortCode) return existing.shortCode;

    // Try a few times in case of unique-constraint collision
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateShortCode();
        try {
            await db.device.update({
                where: { id: deviceId },
                data: { shortCode: code },
            });
            return code;
        } catch (err) {
            // Most likely a unique constraint collision; retry
            continue;
        }
    }
    throw new Error('Failed to allocate shortCode after 5 attempts');
}

export async function devicesRoutes(app: FastifyInstance) {
    // Update this device's name + kind. Idempotent — Mac/iOS call on every launch.
    // For Macs, also lazy-allocates a permanent shortCode used for pairing.
    app.post('/v1/devices/me', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({
                name: z.string().min(1).max(120),
                kind: z.enum(['ios', 'mac']),
            }),
        },
    }, async (request) => {
        const deviceId = request.deviceId!;
        const { name, kind } = request.body as { name: string; kind: 'ios' | 'mac' };

        await db.device.update({
            where: { id: deviceId },
            data: { name, kind },
        });

        let shortCode: string | null = null;
        if (kind === 'mac') {
            shortCode = await ensureShortCode(deviceId);
        }

        return { deviceId, name, kind, shortCode };
    });

    // ─────────────────────────── Launch presets ───────────────────────────

    // Mac uploads its current preset list (full replace).
    // The Mac MUST provide its own stable `id` per preset — this same id is
    // sent back in `session-launch` events, so the Mac's LaunchService can
    // look up the preset in its local PresetStore.
    app.put('/v1/devices/me/presets', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({
                presets: z.array(
                    z.object({
                        id: z.string().min(1).max(120),
                        name: z.string().min(1).max(120),
                        command: z.string().min(1).max(2000),
                        icon: z.string().max(60).optional(),
                        sortOrder: z.number().int().default(0),
                    })
                ),
            }),
        },
    }, async (request) => {
        const deviceId = request.deviceId!;
        const { presets } = request.body as {
            presets: Array<{ id: string; name: string; command: string; icon?: string; sortOrder: number }>;
        };

        // Full replace keyed by (deviceId, id) — use the client-provided id so
        // the Mac and server agree on preset identity.
        await db.$transaction([
            db.launchPreset.deleteMany({ where: { deviceId } }),
            ...presets.map((p) =>
                db.launchPreset.create({
                    data: {
                        id: p.id,
                        deviceId,
                        name: p.name,
                        command: p.command,
                        icon: p.icon,
                        sortOrder: p.sortOrder,
                    },
                })
            ),
        ]);

        return { ok: true, count: presets.length };
    });

    // iPhone fetches a linked computer's presets. Account-scoped (CONTRACT §2.3):
    // `:deviceId` is the mac computerId; access is gated by the account's links.
    app.get('/v1/devices/:deviceId/presets', {
        preHandler: requireUser(),
        schema: {
            params: z.object({ deviceId: z.string() }),
        },
    }, async (request, reply) => {
        const { deviceId: targetId } = request.params as { deviceId: string };

        const accessible = await getAccessibleComputerIds(request.user!.id);
        if (!accessible.includes(targetId)) {
            return reply.code(403).send({ error: { code: 'NOT_LINKED' } });
        }

        const presets = await db.launchPreset.findMany({
            where: { deviceId: targetId },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });

        return presets.map((p) => ({
            id: p.id,
            name: p.name,
            command: p.command,
            icon: p.icon,
            sortOrder: p.sortOrder,
        }));
    });

    // ─────────────────────────── Known projects ───────────────────────────

    // Mac uploads recent project paths. Upserts + bumps lastSeenAt.
    app.put('/v1/devices/me/projects', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({
                projects: z.array(
                    z.object({
                        path: z.string().min(1).max(2000),
                        name: z.string().min(1).max(240),
                    })
                ),
            }),
        },
    }, async (request) => {
        const deviceId = request.deviceId!;
        const { projects } = request.body as {
            projects: Array<{ path: string; name: string }>;
        };

        const now = new Date();
        await db.$transaction(
            projects.map((p) =>
                db.knownProject.upsert({
                    where: { deviceId_path: { deviceId, path: p.path } },
                    create: { deviceId, path: p.path, name: p.name, lastSeenAt: now },
                    update: { name: p.name, lastSeenAt: now },
                })
            )
        );

        return { ok: true, count: projects.length };
    });

    // iPhone fetches a linked computer's recent projects. Account-scoped.
    app.get('/v1/devices/:deviceId/projects', {
        preHandler: requireUser(),
        schema: {
            params: z.object({ deviceId: z.string() }),
            querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
        },
    }, async (request, reply) => {
        const { deviceId: targetId } = request.params as { deviceId: string };
        const { limit } = request.query as { limit: number };

        const accessible = await getAccessibleComputerIds(request.user!.id);
        if (!accessible.includes(targetId)) {
            return reply.code(403).send({ error: { code: 'NOT_LINKED' } });
        }

        const projects = await db.knownProject.findMany({
            where: { deviceId: targetId },
            orderBy: { lastSeenAt: 'desc' },
            take: limit,
        });

        return projects.map((p) => ({
            id: p.id,
            path: p.path,
            name: p.name,
            lastSeenAt: p.lastSeenAt.toISOString(),
        }));
    });
}
