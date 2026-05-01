import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './crypto';
import { config } from '@/config';
import { db } from '@/storage/db';

declare module 'fastify' {
    interface FastifyRequest {
        deviceId?: string;
    }
}

export function extractToken(header: string | undefined): string | null {
    if (!header || !header.startsWith('Bearer ')) return null;
    return header.slice(7) || null;
}

/// Throttle lastSeenAt writes per device to at most once per minute.
/// Without this an active iPhone fetching messages every few seconds
/// would write the column hundreds of times a minute for no benefit.
const lastSeenWriteAt = new Map<string, number>();
const LAST_SEEN_THROTTLE_MS = 60_000;

export async function bumpLastSeenAt(deviceId: string): Promise<void> {
    const now = Date.now();
    const prev = lastSeenWriteAt.get(deviceId);
    if (prev && now - prev < LAST_SEEN_THROTTLE_MS) return;
    lastSeenWriteAt.set(deviceId, now);
    // Awaited — session creation must see the device record exist first.
    await db.device.upsert({
        where: { id: deviceId },
        create: { id: deviceId, name: 'JWT Device', publicKey: deviceId, lastSeenAt: new Date() },
        update: { lastSeenAt: new Date() },
    }).catch(() => {
        lastSeenWriteAt.delete(deviceId);
    });
}

export async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const token = extractToken(request.headers.authorization);
    if (!token) {
        reply.code(401).send({ error: 'Missing authorization token' });
        return;
    }

    const payload = verifyToken(token, config.masterSecret);
    if (!payload) {
        reply.code(401).send({ error: 'Invalid token' });
        return;
    }

    request.deviceId = payload.deviceId;
    await bumpLastSeenAt(payload.deviceId);
}
