/**
 * wsGateway — integration tests.
 *
 * Verifies that attachControlPlaneWs() binds a Socket.IO server to
 * /api/v1/ws/control, that transport works (ping/pong), and that
 * the subscribe guard is enforced end-to-end over the wire.
 *
 * Tests:
 * 1. ping → pong (transport up and reachable)
 * 2. subscribe without machine_token → MISSING_FIELDS error + disconnect
 * 3. subscribe with valid token but cross-org workroom → FORBIDDEN error + disconnect
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { attachControlPlaneWs } from './wsGateway';

// ── Controllable mocks (per-test via mockResolvedValue) ───────────────────────

const mockVerifyMachineToken = vi.fn();
const mockRequireMachineAccessToWorkroom = vi.fn();
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockUnsubscribeAll = vi.fn();

vi.mock('@/storage/db', () => ({
  db: { controlMachine: { findFirst: vi.fn() } },
}));

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: (...args: unknown[]) => mockVerifyMachineToken(...args),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: (...args: unknown[]) => mockRequireMachineAccessToWorkroom(...args),
}));

vi.mock('./workroomBroadcaster', () => ({
  workroomBroadcaster: {
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
    unsubscribe: (...args: unknown[]) => mockUnsubscribe(...args),
    unsubscribeAll: (...args: unknown[]) => mockUnsubscribeAll(...args),
  },
}));

// ── Setup: real HTTP server + WS gateway (shared across tests) ────────────────

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer();
  attachControlPlaneWs(server);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  port = (addr as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient(): ClientSocket {
  return ioClient(`http://127.0.0.1:${port}`, {
    path: '/api/v1/ws/control',
    transports: ['websocket'],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('wsGateway — /api/v1/ws/control transport', () => {

  it('ping → pong (transport up, gateway reachable)', async () => {
    const client = makeClient();

    const pongReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.disconnect();
        reject(new Error('Timed out waiting for pong'));
      }, 3000);

      client.on('connect', () => client.emit('ping'));
      client.on('pong', () => { clearTimeout(timeout); resolve(); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    await pongReceived;
    client.disconnect();
  });

  it('subscribe without machine_token → MISSING_FIELDS error + disconnect', async () => {
    const client = makeClient();

    const result = await new Promise<{ code: string; disconnected: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.disconnect();
        reject(new Error('Timed out'));
      }, 3000);

      let errorCode = '';

      client.on('connect', () => {
        client.emit('subscribe', { workroom_id: 'wroom-1' }); // missing machine_token
      });
      client.on('error', (msg: { code: string }) => { errorCode = msg.code; });
      client.on('disconnect', () => { clearTimeout(timeout); resolve({ code: errorCode, disconnected: true }); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    expect(result.code).toBe('MISSING_FIELDS');
    expect(result.disconnected).toBe(true);
    client.disconnect();
  });

  it('subscribe with valid token + cross-org workroom → FORBIDDEN error + disconnect', async () => {
    // Machine has a valid token but its org does not match the requested workroom.
    mockVerifyMachineToken.mockResolvedValue({ id: 'machine-1', orgId: 'org-A' });
    mockRequireMachineAccessToWorkroom.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'FORBIDDEN', message: 'Machine org does not match workroom org' },
    });

    const client = makeClient();

    const result = await new Promise<{ code: string; disconnected: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.disconnect();
        reject(new Error('Timed out'));
      }, 3000);

      let errorCode = '';

      client.on('connect', () => {
        client.emit('subscribe', { workroom_id: 'wroom-B', machine_token: 'valid-token' });
      });
      client.on('error', (msg: { code: string }) => { errorCode = msg.code; });
      // Gateway calls socket.disconnect(true) on 403 → client receives disconnect event
      client.on('disconnect', () => { clearTimeout(timeout); resolve({ code: errorCode, disconnected: true }); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    // Cross-org subscribe must be rejected with FORBIDDEN and socket disconnected
    expect(result.code).toBe('FORBIDDEN');
    expect(result.disconnected).toBe(true);
    // workroomBroadcaster.subscribe must NOT have been called
    expect(mockSubscribe).not.toHaveBeenCalled();
    client.disconnect();
  });
});
