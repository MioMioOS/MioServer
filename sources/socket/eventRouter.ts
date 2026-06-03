import type { Socket } from 'socket.io';
import { db } from '@/storage/db';

/**
 * A live socket on /v1/updates. Two planes (account-only refactor, CONTRACT §2.7):
 *   - PUBLISHER (mac daemon): `deviceId` set (Device(mac).id). Pushes session
 *     updates, registers RPC handlers, receives self-broadcasts via emitToDevice.
 *   - SUBSCRIBER (phone): `userId` set (account). Receives fan-out for every
 *     computer its account owns via AccountComputerLink. Never publishes.
 */
export interface ClientConnection {
    connectionType: 'session-scoped' | 'user-scoped';
    socket: Socket;
    /** Publisher plane: the mac Device.id this connection pushes for. */
    deviceId?: string;
    /** Subscriber plane: the account this connection subscribes as. */
    userId?: string;
    sessionId?: string;
}

export type RecipientFilter =
    | { type: 'all-interested-in-session'; sessionId: string }
    | { type: 'user-scoped-only' }
    | { type: 'all' };

// Resolve which accounts (userIds) own a given mac computer. Single owner today
// (UNIQUE(computerId)) but modelled as a set so a future multi-share relaxation
// needs no router change. Cached 30s — fan-out is the hot path.
type OwnersEntry = { userIds: string[]; expiresAt: number };
const ownersCache = new Map<string, OwnersEntry>();
const OWNERS_CACHE_TTL_MS = 30_000;

async function resolveOwningUserIds(computerId: string): Promise<string[]> {
    const now = Date.now();
    const cached = ownersCache.get(computerId);
    if (cached && cached.expiresAt > now) return cached.userIds;
    const links = await db.accountComputerLink.findMany({
        where: { computerId },
        select: { userId: true },
    });
    const userIds = links.map((l) => l.userId);
    ownersCache.set(computerId, { userIds, expiresAt: now + OWNERS_CACHE_TTL_MS });
    return userIds;
}

/** Drop the computer→owners cache. Called on every AccountComputerLink change. */
export function invalidateOwnersCache(): void {
    ownersCache.clear();
}

export class EventRouter {
    // Publisher connections keyed by mac deviceId.
    private byDevice = new Map<string, Set<ClientConnection>>();
    // Subscriber connections keyed by account userId.
    private byUser = new Map<string, Set<ClientConnection>>();

    addConnection(connection: ClientConnection) {
        if (connection.deviceId) {
            if (!this.byDevice.has(connection.deviceId)) {
                this.byDevice.set(connection.deviceId, new Set());
            }
            this.byDevice.get(connection.deviceId)!.add(connection);
        }
        if (connection.userId) {
            if (!this.byUser.has(connection.userId)) {
                this.byUser.set(connection.userId, new Set());
            }
            this.byUser.get(connection.userId)!.add(connection);
        }
    }

    removeConnection(connection: ClientConnection) {
        if (connection.deviceId) {
            const conns = this.byDevice.get(connection.deviceId);
            if (conns) {
                conns.delete(connection);
                if (conns.size === 0) this.byDevice.delete(connection.deviceId);
            }
        }
        if (connection.userId) {
            const conns = this.byUser.get(connection.userId);
            if (conns) {
                conns.delete(connection);
                if (conns.size === 0) this.byUser.delete(connection.userId);
            }
        }
    }

    getConnections(deviceId: string): ClientConnection[] {
        return Array.from(this.byDevice.get(deviceId) || []);
    }

    /** Total number of devices currently holding at least one publisher socket. */
    getConnectionCount(): number {
        return this.byDevice.size;
    }

    /** True if the given device has any live publisher socket. */
    isDeviceConnected(deviceId: string): boolean {
        const conns = this.byDevice.get(deviceId);
        return !!conns && conns.size > 0;
    }

    /**
     * Broadcast a mac's session update to every phone subscriber whose account
     * owns that mac via AccountComputerLink (CONTRACT §2.7).
     */
    async emitUpdate(
        senderDeviceId: string,
        event: string,
        payload: unknown,
        filter: RecipientFilter,
        skipSocket?: Socket
    ) {
        // Wrap entire body: an unhandled rejection (e.g. Prisma pool timeout)
        // crashes the Node process and tears down every active socket. Better to
        // drop one broadcast than restart the whole server.
        try {
            const owningUserIds = await resolveOwningUserIds(senderDeviceId);
            let sent = 0;
            let skipped = 0;
            for (const userId of owningUserIds) {
                const conns = this.byUser.get(userId);
                if (!conns) continue;
                for (const conn of conns) {
                    if (conn.socket === skipSocket) { skipped++; continue; }
                    if (this.shouldSend(conn, filter)) {
                        conn.socket.emit(event, payload);
                        sent++;
                    } else {
                        skipped++;
                    }
                }
            }
            const type = (payload as any)?.type || event;
            console.log(`[EventRouter] ${type}: sent=${sent} skipped=${skipped} owners=${owningUserIds.length} subscribers=${this.byUser.size}`);
        } catch (err) {
            const type = (payload as any)?.type || event;
            console.error(`[EventRouter] emitUpdate(${type}) failed, dropping this broadcast:`, (err as Error)?.message);
        }
    }

    async emitEphemeral(senderDeviceId: string, event: string, payload: unknown) {
        await this.emitUpdate(senderDeviceId, event, payload, { type: 'all' });
    }

    /**
     * Emit an event to all PUBLISHER connections of a specific target device.
     * Used for self-broadcasts (e.g. subscription-updated back to the mac).
     */
    emitToDevice(targetDeviceId: string, event: string, payload: unknown): number {
        const conns = this.byDevice.get(targetDeviceId);
        if (!conns) return 0;
        let count = 0;
        for (const conn of conns) {
            conn.socket.emit(event, payload);
            count++;
        }
        return count;
    }

    private shouldSend(conn: ClientConnection, filter: RecipientFilter): boolean {
        switch (filter.type) {
            case 'all':
                return true;
            case 'user-scoped-only':
                return conn.connectionType === 'user-scoped';
            case 'all-interested-in-session':
                return conn.connectionType === 'user-scoped' ||
                    (conn.connectionType === 'session-scoped' && conn.sessionId === filter.sessionId);
        }
    }
}
