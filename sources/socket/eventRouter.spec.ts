import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventRouter, invalidateOwnersCache, type ClientConnection } from './eventRouter';

// emitUpdate resolves computer→owners via Prisma (db.accountComputerLink). Mock
// it so tests run without a live DB. The mock maps the sender mac deviceId to a
// single owning account 'user-1'.
vi.mock('@/storage/db', () => ({
    db: {
        accountComputerLink: {
            findMany: vi.fn(async ({ where }: { where: { computerId: string } }) =>
                where.computerId === 'device-1' ? [{ userId: 'user-1' }] : []
            ),
        },
    },
}));

function mockSubscriber(overrides: Partial<ClientConnection> = {}): ClientConnection {
    return {
        connectionType: 'user-scoped',
        socket: { emit: vi.fn() } as any,
        userId: 'user-1',
        sessionId: undefined,
        ...overrides,
    };
}

describe('EventRouter', () => {
    beforeEach(() => {
        invalidateOwnersCache();
    });

    it('should add and remove publisher connections', () => {
        const router = new EventRouter();
        const conn: ClientConnection = {
            connectionType: 'user-scoped',
            socket: { emit: vi.fn() } as any,
            deviceId: 'device-1',
        };
        router.addConnection(conn);
        expect(router.getConnections('device-1')).toHaveLength(1);
        router.removeConnection(conn);
        expect(router.getConnections('device-1')).toHaveLength(0);
    });

    it('should emit to all user-scoped subscribers of the owning account', async () => {
        const router = new EventRouter();
        const conn1 = mockSubscriber();
        const conn2 = mockSubscriber({ connectionType: 'session-scoped', sessionId: 'sess-1' });
        router.addConnection(conn1);
        router.addConnection(conn2);

        await router.emitUpdate('device-1', 'update', { type: 'test' }, { type: 'user-scoped-only' });

        expect(conn1.socket.emit).toHaveBeenCalledWith('update', { type: 'test' });
        expect(conn2.socket.emit).not.toHaveBeenCalled();
    });

    it('should emit to session-scoped + user-scoped for session filter', async () => {
        const router = new EventRouter();
        const userConn = mockSubscriber();
        const sessConn = mockSubscriber({ connectionType: 'session-scoped', sessionId: 'sess-1' });
        const otherSessConn = mockSubscriber({ connectionType: 'session-scoped', sessionId: 'sess-2' });
        router.addConnection(userConn);
        router.addConnection(sessConn);
        router.addConnection(otherSessConn);

        await router.emitUpdate('device-1', 'update', { type: 'test' }, {
            type: 'all-interested-in-session',
            sessionId: 'sess-1',
        });

        expect(userConn.socket.emit).toHaveBeenCalled();
        expect(sessConn.socket.emit).toHaveBeenCalled();
        expect(otherSessConn.socket.emit).not.toHaveBeenCalled();
    });

    it('should not emit to subscribers of a different account', async () => {
        const router = new EventRouter();
        const otherAccount = mockSubscriber({ userId: 'user-2' });
        router.addConnection(otherAccount);

        await router.emitUpdate('device-1', 'update', { type: 'test' }, { type: 'all' });

        expect(otherAccount.socket.emit).not.toHaveBeenCalled();
    });

    it('should skip specified socket', async () => {
        const router = new EventRouter();
        const conn = mockSubscriber();
        router.addConnection(conn);

        await router.emitUpdate('device-1', 'update', { type: 'test' }, { type: 'all' }, conn.socket);

        expect(conn.socket.emit).not.toHaveBeenCalled();
    });
});
