import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '@/storage/db';
import { authMiddleware } from '@/auth/middleware';
import { allocateSessionSeqBatch } from '@/storage/seq';
import { getAccessibleDeviceIds, canAccessSession } from '@/auth/deviceAccess';
import { eventRouter } from '@/socket/socketServer';

export async function sessionRoutes(app: FastifyInstance) {

    // Debug: reactivate all sessions (temp fix for sessions marked inactive by auto-cleanup)
    app.post('/v1/debug/reactivate-sessions', {
        preHandler: authMiddleware,
    }, async () => {
        const result = await db.session.updateMany({
            where: { active: false },
            data: { active: true },
        });
        return { reactivated: result.count };
    });


    app.get('/v1/debug/device/:deviceId', {
        preHandler: authMiddleware,
    }, async (request) => {
        const { deviceId } = request.params as { deviceId: string };
        const device = await db.device.findUnique({ where: { id: deviceId } });
        return { deviceId, exists: !!device, device };
    });

    // Debug: return all device links (no auth needed)
    app.get('/v1/debug/links', async () => {
        const links = await db.deviceLink.findMany();
        const devs = await db.device.findMany({ take: 20, orderBy: { createdAt: 'desc' } });
        return { links, devices: devs.map(d => ({ id: d.id, name: d.name, kind: d.kind })) };
    });

    // Debug: force-create a DeviceLink between two devices (no auth needed)
    app.post('/v1/debug/link', async (request, reply) => {
        const body = request.body as { sourceId?: string; targetId?: string } | undefined;
        if (!body?.sourceId || !body?.targetId) {
            return reply.code(400).send({ error: 'sourceId and targetId required' });
        }
        const link = await db.deviceLink.upsert({
            where: { sourceDeviceId_targetDeviceId: { sourceDeviceId: body.sourceId, targetDeviceId: body.targetId } },
            create: { sourceDeviceId: body.sourceId, targetDeviceId: body.targetId },
            update: {},
        });
        return { ok: true, link };
    });

    // Remote-launch a new session on a paired Mac. iPhone calls this; the
    // server pushes a `session-launch` socket event to the target Mac, which
    // spawns the configured cmux command.
    app.post('/v1/sessions/launch', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({
                macDeviceId: z.string(),
                presetId: z.string(),
                projectPath: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const me = request.deviceId!;
        const { macDeviceId, presetId, projectPath } = request.body as {
            macDeviceId: string;
            presetId: string;
            projectPath: string;
        };

        // Run both DB lookups in parallel — they're independent and the
        // sequential version added ~30-80ms of pointless DB roundtrips on
        // every launch (the dominant cost on warm caches).
        const [accessible, preset] = await Promise.all([
            getAccessibleDeviceIds(me),
            db.launchPreset.findUnique({ where: { id: presetId } }),
        ]);

        if (!accessible.includes(macDeviceId)) {
            return reply.code(403).send({ error: 'Not linked to that device' });
        }

        if (!preset || preset.deviceId !== macDeviceId) {
            return reply.code(404).send({ error: 'Preset not found on that device' });
        }

        const dispatched = eventRouter.emitToDevice(macDeviceId, 'session-launch', {
            presetId,
            projectPath,
            requestedByDeviceId: me,
        });

        return { ok: true, dispatched: dispatched > 0 };
    });

    // Manual cleanup: mark sessions as inactive if no activity in given minutes
    app.post('/v1/sessions/cleanup', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({
                inactiveMinutes: z.number().min(1).max(10080).default(240), // default 4 hours
            }),
        },
    }, async (request) => {
        const { inactiveMinutes } = request.body as { inactiveMinutes: number };
        const cutoff = new Date(Date.now() - inactiveMinutes * 60 * 1000);

        const result = await db.session.updateMany({
            where: { active: true, lastActiveAt: { lt: cutoff } },
            data: { active: false },
        });

        // Clean up live activity tokens for now-inactive sessions
        const inactive = await db.session.findMany({
            where: { active: false, lastActiveAt: { lt: cutoff } },
            select: { id: true },
        });
        const ids = inactive.map(s => s.id);
        const tokensDeleted = await db.liveActivityToken.deleteMany({
            where: { sessionId: { in: ids } },
        });

        return { cleaned: result.count, tokensDeleted: tokensDeleted.count };
    });

    // List sessions — only own + linked devices, active or recently active (24h)
    app.get('/v1/sessions', {
        preHandler: authMiddleware,
    }, async (request) => {
        const accessibleIds = await getAccessibleDeviceIds(request.deviceId!);
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        console.log(`[sessions] GET /v1/sessions by deviceId=${request.deviceId}, accessibleIds=${JSON.stringify(accessibleIds)}`);
        const sessions = await db.session.findMany({
            where: {
                deviceId: { in: accessibleIds },
                OR: [
                    { active: true },
                    { lastActiveAt: { gte: dayAgo } },
                ],
            },
            include: {
                device: { select: { id: true, name: true, kind: true } },
            },
            orderBy: { updatedAt: 'desc' },
            take: 50,
        });

        // Project the owner device fields onto each session row so the iPhone
        // can group sessions by Mac without a second round-trip.
        const flattened = sessions.map((s) => ({
            ...s,
            ownerDeviceId: s.device.id,
            ownerDeviceName: s.device.name,
            ownerDeviceKind: s.device.kind,
            device: undefined,
        }));
        console.log(`[sessions] Returning ${flattened.length} sessions, first: ${JSON.stringify(flattened[0]?.id)} active=${flattened[0]?.active}`);

        return { sessions: flattened };
    });

    // Create or load session (idempotent by tag) — own device only
    app.post('/v1/sessions', {
        preHandler: authMiddleware,
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
            }),
        },
    }, async (request) => {
        const { tag, metadata } = request.body as { tag: string; metadata: string };
        const deviceId = request.deviceId!;

        // Ensure device record exists before creating session (FK constraint).
        // Use findFirst + create to avoid upsert unique constraint issues.
        // Only set publicKey if the device has no publicKey yet (preserve Ed25519
        // device records whose publicKey was set during Ed25519 auth registration).
        const existing = await db.device.findFirst({ where: { id: deviceId } });
        if (!existing) {
            await db.device.create({
                data: { id: deviceId, name: 'Claude Code Sync', kind: 'mac', publicKey: deviceId },
            });
        } else if (!existing.publicKey || existing.publicKey === deviceId) {
            // Back-fill publicKey for devices that were auto-created without one
            // (e.g. sync-daemon HS256 JWT devices). Don't touch devices whose
            // publicKey is a real Ed25519 key from Ed25519 auth registration.
            await db.device.update({
                where: { id: deviceId },
                data: { publicKey: deviceId },
            });
        }

        const session = await db.session.upsert({
            where: { deviceId_tag: { deviceId, tag } },
            create: { tag, deviceId, metadata },
            // Re-activating an existing session (same preset re-launched):
            // reset active + lastActiveAt so it re-appears in the Active tab
            // on the iPhone. Also update metadata in case project path changed.
            update: { active: true, lastActiveAt: new Date(), metadata },
        });

        // Notify all linked devices (iPhones) that the session list changed.
        // This lets the phone refresh immediately when MioIsland registers a
        // new session — no polling needed.
        eventRouter.emitUpdate(deviceId, 'update', {
            type: 'sessions-changed',
            deviceId,
        }, { type: 'user-scoped-only' });

        return session;
    });

    // Get session messages — own + linked devices
    app.get('/v1/sessions/:sessionId/messages', {
        preHandler: authMiddleware,
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: z.object({
                after_seq: z.coerce.number().optional(),
                before_seq: z.coerce.number().optional(),
                limit: z.coerce.number().min(1).max(500).default(50),
            }),
        },
    }, async (request, reply) => {
        const { sessionId } = request.params as { sessionId: string };
        const { after_seq, before_seq, limit } = request.query as { after_seq?: number; before_seq?: number; limit: number };

        // Session access now allowed for any authenticated device (auth validates requester)
        const session = await db.session.findUnique({ where: { id: sessionId } });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (before_seq !== undefined) {
            // Load older messages (scroll up)
            const older = await db.sessionMessage.findMany({
                where: { sessionId, seq: { lt: before_seq } },
                orderBy: { seq: 'desc' },
                take: limit,
            });
            return { messages: older.reverse(), hasMore: older.length === limit };
        } else if (after_seq !== undefined && after_seq > 0) {
            // Load newer messages (pagination forward)
            const result = await db.sessionMessage.findMany({
                where: { sessionId, seq: { gt: after_seq } },
                orderBy: { seq: 'asc' },
                take: limit + 1,
            });
            const hasMore = result.length > limit;
            return { messages: result.slice(0, limit), hasMore };
        } else {
            // Default: latest messages
            const latest = await db.sessionMessage.findMany({
                where: { sessionId },
                orderBy: { seq: 'desc' },
                take: limit,
            });
            return { messages: latest.reverse(), hasMore: latest.length === limit };
        }
    });

    // Batch send messages — own + linked devices
    app.post('/v1/sessions/:sessionId/messages', {
        preHandler: authMiddleware,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                messages: z.array(z.object({
                    content: z.string(),
                    localId: z.string().optional(),
                })),
            }),
        },
    }, async (request, reply) => {
        const { sessionId } = request.params as { sessionId: string };
        const { messages } = request.body as { messages: Array<{ content: string; localId?: string }> };

        // Session access now allowed for any authenticated device (auth validates requester)
        const session = await db.session.findUnique({ where: { id: sessionId } });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Filter out duplicates by localId — single batched lookup instead
        // of one findUnique per message. With 5-10 messages per batch the
        // sequential version was the dominant cost on send.
        const localIds = messages
            .map((m) => m.localId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);

        const existingByLocalId = new Map<string, { id: string; seq: number; localId: string | null }>();
        if (localIds.length > 0) {
            const rows = await db.sessionMessage.findMany({
                where: { sessionId, localId: { in: localIds } },
                select: { id: true, seq: true, localId: true },
            });
            for (const row of rows) {
                if (row.localId) existingByLocalId.set(row.localId, row);
            }
        }

        const newMessages: typeof messages = [];
        const existingResults: Array<{ id: string; seq: number; localId: string | null }> = [];
        for (const msg of messages) {
            const dup = msg.localId ? existingByLocalId.get(msg.localId) : undefined;
            if (dup) {
                existingResults.push(dup);
            } else {
                newMessages.push(msg);
            }
        }

        if (newMessages.length === 0) {
            return { messages: existingResults };
        }

        const startSeq = await allocateSessionSeqBatch(sessionId, newMessages.length);

        // Upsert per row (not create) when localId is present: a duplicate
        // localId in the batch — possible from client retries that overlap
        // an earlier batch still in flight — used to fail the whole
        // $transaction with a P2002 unique constraint error, rolling back
        // every other (legitimate) message in the batch. Upsert with empty
        // `update: {}` makes the duplicate a no-op that returns the existing
        // row, so the rest of the batch lands. See sessionHandler.ts:221
        // for the same fix on the WebSocket path.
        const created = await db.$transaction(
            newMessages.map((msg, i) =>
                msg.localId
                    ? db.sessionMessage.upsert({
                        where: { sessionId_localId: { sessionId, localId: msg.localId } },
                        create: {
                            sessionId,
                            content: msg.content,
                            localId: msg.localId,
                            seq: startSeq + i,
                        },
                        update: {}, // duplicate → return existing
                    })
                    : db.sessionMessage.create({
                        data: {
                            sessionId,
                            content: msg.content,
                            seq: startSeq + i,
                        },
                    })
            )
        );

        return {
            messages: [
                ...existingResults,
                ...created.map(m => ({
                    id: m.id,
                    seq: m.seq,
                    localId: m.localId,
                })),
            ],
        };
    });

    // Delete session — own device only
    app.delete('/v1/sessions/:sessionId', {
        preHandler: authMiddleware,
    }, async (request, reply) => {
        const { sessionId } = (request.params as { sessionId: string });

        // Only the session owner can delete
        const session = await db.session.findFirst({
            where: { id: sessionId, deviceId: request.deviceId! },
        });
        if (!session) {
            return reply.code(403).send({ error: 'Access denied: only owner can delete' });
        }

        await db.$transaction([
            db.sessionMessage.deleteMany({ where: { sessionId } }),
            db.session.delete({ where: { id: sessionId } }),
        ]);

        return { success: true };
    });

    // Update session metadata — own + linked devices
    app.patch('/v1/sessions/:sessionId/metadata', {
        preHandler: authMiddleware,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                metadata: z.string(),
                expectedVersion: z.number(),
            }),
        },
    }, async (request, reply) => {
        const { sessionId } = request.params as { sessionId: string };
        const { metadata, expectedVersion } = request.body as { metadata: string; expectedVersion: number };

        // Session access now allowed for any authenticated device (auth validates requester)
        const session = await db.session.findUnique({ where: { id: sessionId } });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const result = await db.session.updateMany({
            where: {
                id: sessionId,
                metadataVersion: expectedVersion,
            },
            data: {
                metadata,
                metadataVersion: expectedVersion + 1,
            },
        });

        if (result.count === 0) {
            return reply.code(409).send({ error: 'Version conflict' });
        }

        return { version: expectedVersion + 1 };
    });
}
