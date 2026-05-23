/**
 * wsGateway — integration tests.
 *
 * Verifies that attachControlPlaneWs() binds a Socket.IO server to
 * /api/v1/ws/control, that transport works (ping/pong), and that
 * the subscribe guard is enforced end-to-end over the wire.
 *
 * Wire protocol (S1 Chunk 5): subscribe uses { workroom_id, token } — a generic
 * `token` field replacing the old machine_token-only field.  All three token
 * classes (machine / dev_ctl_ / op_sess_) are accepted here.
 *
 * Tests:
 *  1. ping → pong (transport up and reachable)
 *  2. subscribe missing token → MISSING_FIELDS  (migrated from old machine_token case)
 *  3. subscribe missing workroom_id → MISSING_FIELDS
 *  4. machine token in correct workroom → subscribed
 *  5. dev_ctl_ token in correct workroom → subscribed
 *  6. op_sess_ token in correct workroom → subscribed
 *  7. invalid/expired token → FORBIDDEN + disconnect
 *  8. cross-workroom (token scoped to other workroom) → FORBIDDEN + disconnect
 *     (migrated from old cross-org FORBIDDEN case)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { attachControlPlaneWs } from './wsGateway';

// ── Controllable mocks (per-test via mockResolvedValue) ───────────────────────

const mockTokenInWorkroom = vi.fn();
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockUnsubscribeAll = vi.fn();

vi.mock('@/control/auth/workroomScopeForToken', () => ({
  tokenInWorkroom: (...args: unknown[]) => mockTokenInWorkroom(...args),
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

/** Wait for an error event + disconnect, return the error code. */
function waitForErrorAndDisconnect(client: ClientSocket): Promise<{ code: string; disconnected: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timed out waiting for error+disconnect'));
    }, 3000);

    let errorCode = '';

    client.on('error', (msg: { code: string }) => { errorCode = msg.code; });
    client.on('disconnect', () => { clearTimeout(timeout); resolve({ code: errorCode, disconnected: true }); });
    client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
  });
}

/** Wait for a `subscribed` event, return workroom_id. */
function waitForSubscribed(client: ClientSocket): Promise<{ workroom_id: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timed out waiting for subscribed'));
    }, 3000);

    client.on('subscribed', (msg: { workroom_id: string }) => { clearTimeout(timeout); resolve(msg); });
    client.on('error', (msg: { code: string }) => { clearTimeout(timeout); reject(new Error(`Unexpected error: ${msg.code}`)); });
    client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
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

  // ── MISSING_FIELDS ─────────────────────────────────────────────────────────

  it('subscribe missing token → MISSING_FIELDS error (no disconnect forced)', async () => {
    // tokenInWorkroom should NOT be called — the gateway short-circuits on missing fields.
    const client = makeClient();

    const result = await new Promise<{ code: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.disconnect();
        reject(new Error('Timed out'));
      }, 3000);

      client.on('connect', () => {
        client.emit('subscribe', { workroom_id: 'wroom-1' }); // missing token
      });
      client.on('error', (msg: { code: string }) => { clearTimeout(timeout); resolve({ code: msg.code }); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    expect(result.code).toBe('MISSING_FIELDS');
    expect(mockTokenInWorkroom).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('subscribe missing workroom_id → MISSING_FIELDS error (no disconnect forced)', async () => {
    const client = makeClient();

    const result = await new Promise<{ code: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.disconnect();
        reject(new Error('Timed out'));
      }, 3000);

      client.on('connect', () => {
        client.emit('subscribe', { token: 'some-token' }); // missing workroom_id
      });
      client.on('error', (msg: { code: string }) => { clearTimeout(timeout); resolve({ code: msg.code }); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    expect(result.code).toBe('MISSING_FIELDS');
    expect(mockTokenInWorkroom).not.toHaveBeenCalled();
    client.disconnect();
  });

  // ── Successful subscriptions (machine / dev / operator) ────────────────────

  it('machine token in correct workroom → subscribed', async () => {
    mockTokenInWorkroom.mockResolvedValue({ ok: true, mode: 'machine' });

    const client = makeClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.disconnect(); reject(new Error('connect timeout')); }, 3000);
      client.on('connect', () => { clearTimeout(timeout); resolve(); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    client.emit('subscribe', { workroom_id: 'wroom-1', token: 'mach_tok_valid' });
    const result = await waitForSubscribed(client);

    expect(result.workroom_id).toBe('wroom-1');
    expect(mockTokenInWorkroom).toHaveBeenCalledWith('mach_tok_valid', 'wroom-1');
    expect(mockSubscribe).toHaveBeenCalled();
    client.disconnect();
  });

  it('dev_ctl_ token in correct workroom → subscribed', async () => {
    mockTokenInWorkroom.mockResolvedValue({ ok: true, mode: 'dev' });

    const client = makeClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.disconnect(); reject(new Error('connect timeout')); }, 3000);
      client.on('connect', () => { clearTimeout(timeout); resolve(); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    client.emit('subscribe', { workroom_id: 'wroom-1', token: 'dev_ctl_valid' });
    const result = await waitForSubscribed(client);

    expect(result.workroom_id).toBe('wroom-1');
    expect(mockTokenInWorkroom).toHaveBeenCalledWith('dev_ctl_valid', 'wroom-1');
    expect(mockSubscribe).toHaveBeenCalled();
    client.disconnect();
  });

  it('op_sess_ token in correct workroom → subscribed', async () => {
    mockTokenInWorkroom.mockResolvedValue({ ok: true, mode: 'operator' });

    const client = makeClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.disconnect(); reject(new Error('connect timeout')); }, 3000);
      client.on('connect', () => { clearTimeout(timeout); resolve(); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    client.emit('subscribe', { workroom_id: 'wroom-1', token: 'op_sess_valid' });
    const result = await waitForSubscribed(client);

    expect(result.workroom_id).toBe('wroom-1');
    expect(mockTokenInWorkroom).toHaveBeenCalledWith('op_sess_valid', 'wroom-1');
    expect(mockSubscribe).toHaveBeenCalled();
    client.disconnect();
  });

  // ── Auth failures → FORBIDDEN + disconnect ─────────────────────────────────

  it('invalid/expired token → FORBIDDEN error + disconnect', async () => {
    // tokenInWorkroom returns null for any unrecognised or expired token.
    mockTokenInWorkroom.mockResolvedValue(null);

    const client = makeClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.disconnect(); reject(new Error('connect timeout')); }, 3000);
      client.on('connect', () => { clearTimeout(timeout); resolve(); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    client.emit('subscribe', { workroom_id: 'wroom-1', token: 'invalid_or_expired_token' });
    const result = await waitForErrorAndDisconnect(client);

    expect(result.code).toBe('FORBIDDEN');
    expect(result.disconnected).toBe(true);
    expect(mockSubscribe).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('cross-workroom token (scoped to different workroom) → FORBIDDEN + disconnect', async () => {
    // tokenInWorkroom returns null when the token belongs to a different workroom,
    // regardless of token class.  This mirrors the old machine_token cross-org test.
    mockTokenInWorkroom.mockResolvedValue(null);

    const client = makeClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.disconnect(); reject(new Error('connect timeout')); }, 3000);
      client.on('connect', () => { clearTimeout(timeout); resolve(); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    // Token is for wroom-A but we subscribe to wroom-B.
    client.emit('subscribe', { workroom_id: 'wroom-B', token: 'token_for_wroom_A' });
    const result = await waitForErrorAndDisconnect(client);

    expect(result.code).toBe('FORBIDDEN');
    expect(result.disconnected).toBe(true);
    // workroomBroadcaster.subscribe must NOT have been called
    expect(mockSubscribe).not.toHaveBeenCalled();
    client.disconnect();
  });

  // ── disconnect → unsubscribeAll cleanup invariant ─────────────────────────

  it('disconnect → unsubscribeAll is called (cleanup invariant)', async () => {
    mockTokenInWorkroom.mockResolvedValue({ ok: true, mode: 'machine' });

    const client = makeClient();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { client.disconnect(); reject(new Error('connect timeout')); }, 3000);
      client.on('connect', () => { clearTimeout(timeout); resolve(); });
      client.on('connect_error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });

    client.emit('subscribe', { workroom_id: 'wroom-1', token: 'mach_tok_valid' });
    await waitForSubscribed(client);

    // Disconnect and give the server a short window to process its disconnect handler.
    // We cannot simply await client 'disconnect' because the server-side handler fires
    // asynchronously after the transport close.
    await new Promise<void>((resolve) => {
      client.on('disconnect', () => {
        // Wait one tick past the client's disconnect so the server has fired its handler.
        setTimeout(resolve, 100);
      });
      client.disconnect();
    });

    expect(mockUnsubscribeAll).toHaveBeenCalled();
  });
});
