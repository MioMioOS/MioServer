import { db } from '@/storage/db';
import { invalidateOwnersCache } from '@/socket/eventRouter';

// Account-only identity refactor (2026-06-03; CONTRACT §2.3).
//
// Visibility is now keyed by ACCOUNT (userId), not by device. A computer
// (Device.kind='mac') is visible to whichever account holds its
// AccountComputerLink row. DeviceLink is retired — no reader touches it.
//
// Two planes coexist:
//   - Account plane (phone subscriber, user_sess_): getAccessibleComputerIds(userId)
//     and canAccessSession(userId, sessionId) — the contract core.
//   - Device-JWT plane (legacy authMiddleware routes carrying a device JWT):
//     getAccessibleDeviceIdsForDevice(deviceId) resolves the JWT's bound userId
//     to the account's computers, plus the device's own id (so a mac publisher
//     sees its own sessions and a phone sees its account's computers). This is
//     the mechanical translation of the old DeviceLink visibility — no behavior
//     gap, no new auth surface.

// Hot-path cache for canAccessSession. Every socket message hits it (phase
// events, tool events, content). Without caching that's a DB query per
// message. Links change rarely; a 30s TTL is safe (invalidated on link change).
type CacheEntry = { allowed: boolean; expiresAt: number };
const accessCache = new Map<string, CacheEntry>();
const ACCESS_CACHE_TTL_MS = 30_000;

// Hot-path cache for getAccessibleComputerIds. Called on every fan-out resolve.
// Re-keyed by userId (was deviceId). AccountComputerLink rarely changes; 30s TTL
// is safe (invalidated by invalidateAccessCache on every link create/delete).
type ComputerIdsEntry = { ids: string[]; expiresAt: number };
const computerIdsCache = new Map<string, ComputerIdsEntry>();
const COMPUTER_IDS_CACHE_TTL_MS = 30_000;

function accessKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
}

/** Drop cached access decisions. Call on every AccountComputerLink create/delete. */
export function invalidateAccessCache(): void {
    accessCache.clear();
    computerIdsCache.clear();
    // Keep the router's computer→owners fan-out cache coherent on link change.
    invalidateOwnersCache();
}

/**
 * Get the set of mac computer ids (Device.id, kind='mac') linked to an account
 * via AccountComputerLink. This is the hot visibility path for the phone
 * subscriber plane.
 *
 * Fail-open behavior (CONTRACT §2.3): on DB error return `[]` — degraded means
 * "see no computers" for one call, retried next time. We never crash the socket
 * layer over a transient pool hiccup.
 */
export async function getAccessibleComputerIds(userId: string): Promise<string[]> {
    const now = Date.now();
    const cached = computerIdsCache.get(userId);
    if (cached && cached.expiresAt > now) {
        return cached.ids;
    }

    try {
        const links = await db.accountComputerLink.findMany({
            where: { userId },
            select: { computerId: true },
        });
        const ids = links.map((l) => l.computerId);
        computerIdsCache.set(userId, { ids, expiresAt: now + COMPUTER_IDS_CACHE_TTL_MS });
        return ids;
    } catch (err) {
        console.error('[deviceAccess] getAccessibleComputerIds failed, returning []:', (err as Error)?.message);
        // Don't cache the fallback — retry on next call.
        return [];
    }
}

/**
 * Device-JWT plane visibility shim. Resolves the device row's bound userId
 * (set on phones by /v1/auth; null/ownerless on macs), maps it to the account's
 * computers, and always includes the device's own id so a mac publisher can
 * read its own sessions. Used by the legacy authMiddleware routes that still
 * authenticate with a device JWT.
 */
export async function getAccessibleDeviceIdsForDevice(deviceId: string): Promise<string[]> {
    try {
        const device = await db.device.findUnique({
            where: { id: deviceId },
            select: { userId: true },
        });
        const ids = new Set<string>([deviceId]);
        if (device?.userId) {
            for (const id of await getAccessibleComputerIds(device.userId)) {
                ids.add(id);
            }
        }
        return Array.from(ids);
    } catch (err) {
        console.error('[deviceAccess] getAccessibleDeviceIdsForDevice failed, self-only:', (err as Error)?.message);
        return [deviceId];
    }
}

/**
 * Check if an ACCOUNT can access a session (CONTRACT §2.3).
 * Accessible iff Session.deviceId ∈ getAccessibleComputerIds(userId). A phone
 * has no sessions of its own — the DeviceLink branch is gone.
 * Cached for 30s.
 */
export async function canAccessSession(userId: string, sessionId: string): Promise<boolean> {
    const key = accessKey(userId, sessionId);
    const now = Date.now();
    const cached = accessCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.allowed;
    }

    try {
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { deviceId: true },
        });
        if (!session) {
            return false;
        }
        const accessible = await getAccessibleComputerIds(userId);
        const allowed = accessible.includes(session.deviceId);
        accessCache.set(key, { allowed, expiresAt: now + ACCESS_CACHE_TTL_MS });
        return allowed;
    } catch (err) {
        console.error('[deviceAccess] canAccessSession failed, denying for one request:', (err as Error)?.message);
        return false;
    }
}

/**
 * Device-JWT plane session access. A device can access a session iff that
 * session belongs to one of its accessible computers (own id + account
 * computers). Used by legacy authMiddleware routes (mac publisher writes its
 * own sessions; phone device-JWT reads its account's mac sessions).
 */
export async function canDeviceAccessSession(deviceId: string, sessionId: string): Promise<boolean> {
    const key = accessKey(`dev:${deviceId}`, sessionId);
    const now = Date.now();
    const cached = accessCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.allowed;
    }
    try {
        const session = await db.session.findUnique({
            where: { id: sessionId },
            select: { deviceId: true },
        });
        if (!session) return false;
        let allowed = session.deviceId === deviceId;
        if (!allowed) {
            const accessible = await getAccessibleDeviceIdsForDevice(deviceId);
            allowed = accessible.includes(session.deviceId);
        }
        accessCache.set(key, { allowed, expiresAt: now + ACCESS_CACHE_TTL_MS });
        return allowed;
    } catch (err) {
        console.error('[deviceAccess] canDeviceAccessSession failed, denying for one request:', (err as Error)?.message);
        return false;
    }
}
