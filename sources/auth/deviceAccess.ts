import { db } from '@/storage/db';

// Hot-path cache for canAccessSession. Every socket message hits it (phase
// events, tool events, content). Without caching that's 2 DB queries per
// message — for an active Claude session that's 50-100 wasted roundtrips
// per minute. Pairings change rarely; a 30s TTL is safe.
type CacheEntry = { allowed: boolean; expiresAt: number };
const accessCache = new Map<string, CacheEntry>();
const ACCESS_CACHE_TTL_MS = 30_000;

// Hot-path cache for getAccessibleDeviceIds. Called on EVERY socket emit
// (EventRouter.emitUpdate → deviceLink.findMany). With N devices online doing
// active sessions, this fires multiple times per second per device. The Rust
// query-engine IPC dominated CPU on a 2 vCPU box (~52% in tokio threads).
// DeviceLink rarely changes; 30s TTL is safe (invalidated by linkDevices).
type DeviceIdsEntry = { ids: string[]; expiresAt: number };
const deviceIdsCache = new Map<string, DeviceIdsEntry>();
const DEVICE_IDS_CACHE_TTL_MS = 30_000;

function accessKey(deviceId: string, sessionId: string): string {
    return `${deviceId}:${sessionId}`;
}

/** Drop cached access decisions. Call when pairings change or sessions are deleted. */
export function invalidateAccessCache(): void {
    accessCache.clear();
    deviceIdsCache.clear();
}

/**
 * Get all device IDs that a device has access to (itself + linked devices).
 * Used for ownership checks — a device can access its own sessions
 * AND sessions belonging to devices it has been paired with.
 */
export async function getAccessibleDeviceIds(deviceId: string): Promise<string[]> {
    // Cache hit: skip the Prisma round-trip entirely. This is the hot path.
    const now = Date.now();
    const cached = deviceIdsCache.get(deviceId);
    if (cached && cached.expiresAt > now) {
        return cached.ids;
    }

    // Wrap Prisma call: pool-exhaustion / DB hiccups must not crash the Node process.
    // Falling back to [deviceId] degrades broadcast to "self only" instead of killing
    // the entire socket layer (was the root cause of message loss + pm2 restart loops).
    try {
        const links = await db.deviceLink.findMany({
            where: {
                OR: [
                    { sourceDeviceId: deviceId },
                    { targetDeviceId: deviceId },
                ],
            },
            select: {
                sourceDeviceId: true,
                targetDeviceId: true,
            },
        });

        const ids = new Set<string>([deviceId]);
        for (const link of links) {
            ids.add(link.sourceDeviceId);
            ids.add(link.targetDeviceId);
        }

        const result = Array.from(ids);
        deviceIdsCache.set(deviceId, { ids: result, expiresAt: now + DEVICE_IDS_CACHE_TTL_MS });
        return result;
    } catch (err) {
        console.error('[deviceAccess] getAccessibleDeviceIds failed, falling back to self-only:', (err as Error)?.message);
        // Don't cache the fallback — retry on next call.
        return [deviceId];
    }
}

/**
 * Check if a device can access a specific session.
 * Cached for 30s — see accessCache notes above.
 */
export async function canAccessSession(deviceId: string, sessionId: string): Promise<boolean> {
    const key = accessKey(deviceId, sessionId);
    const now = Date.now();
    const cached = accessCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.allowed;
    }

    // Wrap Prisma calls: pool-exhaustion / DB hiccups must not crash the process.
    // Fail-closed (return false) is safer than crashing — the caller will treat
    // the user as unauthorized for one request, which the client can retry.
    try {
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { deviceId: true },
        });
        if (!session) {
            return false;
        }
        let allowed = session.deviceId === deviceId;
        if (!allowed) {
            const linked = await db.deviceLink.findFirst({
                where: {
                    OR: [
                        { sourceDeviceId: deviceId, targetDeviceId: session.deviceId },
                        { sourceDeviceId: session.deviceId, targetDeviceId: deviceId },
                    ],
                },
                select: { id: true },
            });
            allowed = linked !== null;
        }
        accessCache.set(key, { allowed, expiresAt: now + ACCESS_CACHE_TTL_MS });
        return allowed;
    } catch (err) {
        console.error('[deviceAccess] canAccessSession failed, denying access for one request:', (err as Error)?.message);
        return false;
    }
}

/**
 * Link two devices together (bidirectional).
 */
export async function linkDevices(deviceId1: string, deviceId2: string): Promise<void> {
    await db.deviceLink.upsert({
        where: {
            sourceDeviceId_targetDeviceId: {
                sourceDeviceId: deviceId1,
                targetDeviceId: deviceId2,
            },
        },
        create: {
            sourceDeviceId: deviceId1,
            targetDeviceId: deviceId2,
        },
        update: {},
    });
    // Drop cached access decisions so newly-paired devices see access right away.
    invalidateAccessCache();
}
