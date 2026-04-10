import { describe, it, expect, vi } from 'vitest';
import { EventRouter, type ClientConnection } from './eventRouter';

function mockConnection(overrides: Partial<ClientConnection> = {}): ClientConnection {
    return {
        connectionType: 'user-scoped',
        socket: { emit: vi.fn() } as any,
        deviceId: 'device-1',
        sessionId: undefined,
        ...overrides,
    };
}

describe('EventRouter', () => {
    it('should add and remove connections', () => {
        const router = new EventRouter();
        const conn = mockConnection();
        router.addConnection('device-1', conn);
        expect(router.getConnections('device-1')).toHaveLength(1);
        router.removeConnection('device-1', conn);
        expect(router.getConnections('device-1')).toHaveLength(0);
    });

    it('should emit to all user-scoped connections', () => {
        const router = new EventRouter();
        const conn1 = mockConnection();
        const conn2 = mockConnection({ connectionType: 'session-scoped', sessionId: 'sess-1' });
        router.addConnection('device-1', conn1);
        router.addConnection('device-1', conn2);

        router.emitUpdate('device-1', 'update', { type: 'test' }, { type: 'user-scoped-only' });

        expect(conn1.socket.emit).toHaveBeenCalledWith('update', { type: 'test' });
        expect(conn2.socket.emit).not.toHaveBeenCalled();
    });

    it('should emit to session-scoped + user-scoped for session filter', () => {
        const router = new EventRouter();
        const userConn = mockConnection();
        const sessConn = mockConnection({ connectionType: 'session-scoped', sessionId: 'sess-1' });
        const otherSessConn = mockConnection({ connectionType: 'session-scoped', sessionId: 'sess-2' });
        router.addConnection('device-1', userConn);
        router.addConnection('device-1', sessConn);
        router.addConnection('device-1', otherSessConn);

        router.emitUpdate('device-1', 'update', { type: 'test' }, {
            type: 'all-interested-in-session',
            sessionId: 'sess-1',
        });

        expect(userConn.socket.emit).toHaveBeenCalled();
        expect(sessConn.socket.emit).toHaveBeenCalled();
        expect(otherSessConn.socket.emit).not.toHaveBeenCalled();
    });

    it('should skip specified socket', () => {
        const router = new EventRouter();
        const conn = mockConnection();
        router.addConnection('device-1', conn);

        router.emitUpdate('device-1', 'update', { type: 'test' }, { type: 'all' }, conn.socket);

        expect(conn.socket.emit).not.toHaveBeenCalled();
    });
});
