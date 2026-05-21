/**
 * wsGateway — minimal integration test.
 *
 * Verifies that attachControlPlaneWs() binds a Socket.IO server to
 * /api/v1/ws/control and that a connecting client receives a pong
 * response to a ping event.
 *
 * This test starts a real HTTP server on a random port, attaches the
 * control plane WS gateway, connects a Socket.IO client, and exercises
 * the ping/pong path — the simplest proof that the gateway is reachable.
 *
 * Auth (subscribe + machine_token) is covered by workroomBroadcaster.spec.ts
 * and machineAccess.spec.ts unit tests, so this file focuses on the
 * transport layer being up and responding.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { attachControlPlaneWs } from './wsGateway';

// Minimal mocks for wsGateway's internal imports
vi.mock('@/storage/db', () => ({
  db: { controlMachine: { findFirst: vi.fn() } },
}));

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: vi.fn(),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: vi.fn(),
}));

vi.mock('./workroomBroadcaster', () => ({
  workroomBroadcaster: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
  },
}));

// ── Setup: real HTTP server + WS gateway ──────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('wsGateway — /api/v1/ws/control transport', () => {
  it('client can connect and receive pong from ping', async () => {
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
      path: '/api/v1/ws/control',
      transports: ['websocket'],
    });

    const pongReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.disconnect();
        reject(new Error('Timed out waiting for pong'));
      }, 3000);

      client.on('connect', () => {
        client.emit('ping');
      });

      client.on('pong', () => {
        clearTimeout(timeout);
        resolve();
      });

      client.on('connect_error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    await pongReceived;
    client.disconnect();
  });

  it('client receives error and is disconnected on subscribe without machine_token', async () => {
    const client: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
      path: '/api/v1/ws/control',
      transports: ['websocket'],
    });

    const result = await new Promise<{ code: string; disconnected: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.disconnect();
        reject(new Error('Timed out waiting for error event'));
      }, 3000);

      let errorCode = '';

      client.on('connect', () => {
        // Send subscribe without machine_token — gateway must reject
        client.emit('subscribe', { workroom_id: 'wroom-1' });
      });

      client.on('error', (msg: { code: string }) => {
        errorCode = msg.code;
      });

      client.on('disconnect', () => {
        clearTimeout(timeout);
        resolve({ code: errorCode, disconnected: true });
      });

      client.on('connect_error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(result.code).toBe('MISSING_FIELDS');
    expect(result.disconnected).toBe(true);
    client.disconnect();
  });
});
