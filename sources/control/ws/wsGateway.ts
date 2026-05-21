/**
 * Control Plane WebSocket Gateway
 *
 * Handles client WS connections for real-time event delivery.
 * Each client subscribes to one or more workrooms; the server pushes
 * new events via workroomBroadcaster after they are committed to DB.
 *
 * Protocol (client → server):
 *   { type: 'subscribe',   workroom_id: string, machine_token: string }
 *   { type: 'unsubscribe', workroom_id: string }
 *   { type: 'ping' }
 *
 * Protocol (server → client):
 *   { type: 'subscribed',   workroom_id: string }
 *   { type: 'unsubscribed', workroom_id: string }
 *   { type: 'error',        code: string, message: string }
 *   { type: 'pong' }
 *
 * Real-time event delivery:
 *   topic='workroom:event' → WorkroomEventPayload (see workroomBroadcaster.ts)
 *
 * Catch-up on reconnect:
 *   Client re-subscribes and calls GET /events?after_seq=<last_seen_seq>.
 *   This gateway does NOT replay history — catch-up is HTTP-only.
 *
 * Auth:
 *   machine_token sent in subscribe message; validated via SHA-256 lookup.
 *   If auth fails: error + socket disconnect.
 *
 * INVARIANTS:
 * 1. Gateway only calls workroomBroadcaster.subscribe AFTER machine auth succeeds.
 * 2. All subscriptions are cleaned up on disconnect (unsubscribeAll).
 * 3. This file contains NO DB writes. It is a pure fanout path.
 */

import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { workroomBroadcaster, WorkroomSubscriber } from './workroomBroadcaster';

export function attachControlPlaneWs(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: '/api/v1/ws/control',
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket: Socket) => {
    console.log(`[WS] client connected: ${socket.id}`);

    // Track subscriber handle for cleanup
    const subscriber: WorkroomSubscriber = { socket, context: socket.id };
    // Track which workrooms this connection subscribed to (for auth guard)
    const authenticatedMachineId: { value: string | null } = { value: null };

    // ── subscribe ────────────────────────────────────────────────────────────
    socket.on('subscribe', async (msg: { workroom_id?: string; machine_token?: string }) => {
      if (!msg.workroom_id || !msg.machine_token) {
        socket.emit('error', { code: 'MISSING_FIELDS', message: 'workroom_id and machine_token required' });
        return;
      }

      // Authenticate on first subscribe (or re-authenticate).
      // verifyMachineToken expects "Bearer <token>" format.
      const machine = await verifyMachineToken(`Bearer ${msg.machine_token}`);
      if (!machine) {
        socket.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' });
        socket.disconnect(true);
        return;
      }
      authenticatedMachineId.value = machine.id;
      subscriber.context = `machine:${machine.id}`;

      // Verify workroom exists
      const workroom = await db.controlWorkroom.findUnique({
        where: { id: msg.workroom_id },
        select: { id: true },
      });
      if (!workroom) {
        socket.emit('error', { code: 'WORKROOM_NOT_FOUND', message: `Workroom ${msg.workroom_id} not found` });
        return;
      }

      workroomBroadcaster.subscribe(msg.workroom_id, subscriber);
      socket.emit('subscribed', { workroom_id: msg.workroom_id });
      console.log(`[WS] ${subscriber.context} subscribed to workroom=${msg.workroom_id}`);
    });

    // ── unsubscribe ──────────────────────────────────────────────────────────
    socket.on('unsubscribe', (msg: { workroom_id?: string }) => {
      if (!msg.workroom_id) {
        socket.emit('error', { code: 'MISSING_FIELDS', message: 'workroom_id required' });
        return;
      }
      workroomBroadcaster.unsubscribe(msg.workroom_id, subscriber);
      socket.emit('unsubscribed', { workroom_id: msg.workroom_id });
    });

    // ── ping ─────────────────────────────────────────────────────────────────
    socket.on('ping', () => {
      socket.emit('pong');
    });

    // ── disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      workroomBroadcaster.unsubscribeAll(subscriber);
      console.log(`[WS] client disconnected: ${socket.id} reason=${reason}`);
    });
  });

  console.log('[WS] Control plane WebSocket gateway attached at /api/v1/ws/control');
  return io;
}
