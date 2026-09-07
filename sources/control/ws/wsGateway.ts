/**
 * Control Plane WebSocket Gateway
 *
 * Handles client WS connections for real-time event delivery.
 * Each client subscribes to one or more workrooms; the server pushes
 * new events via workroomBroadcaster after they are committed to DB.
 *
 * Protocol (client → server):
 *   { type: 'subscribe',   workroom_id: string, token: string }
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
 *   Generic `token` field in subscribe message. Accepted token classes:
 *     - machine_token  (machine daemon)
 *     - dev_ctl_       (CodeLight phone, read-only — Slice 7 transitional)
 *     - op_sess_       (operator session, phone write-capable — Slice 7 transitional)
 *     - user_sess_     (Slice 7 B2-e: iOS sends user_sess_ in the same `token` field;
 *                       wire protocol unchanged. Validated via UserWorkroomMembership.)
 *   All classes are validated via tokenInWorkroom() which checks token validity
 *   AND workroom scope. If auth fails: error + socket disconnect.
 *
 * INVARIANTS:
 * 1. Gateway only calls workroomBroadcaster.subscribe AFTER auth succeeds.
 * 2. All subscriptions are cleaned up on disconnect (unsubscribeAll).
 * 3. This file contains NO DB writes. It is a pure fanout path.
 */

import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { tokenInWorkroom } from '@/control/auth/workroomScopeForToken';
import { registerMachineSocket, unregisterMachineSocket } from '@/control/preview/previewTunnel';
import { userSubscribed, userUnsubscribed, userActivity } from './userPresence';
import { workroomBroadcaster, WorkroomSubscriber } from './workroomBroadcaster';

export function attachControlPlaneWs(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: '/api/v1/ws/control',
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // Preview reverse-tunnel carries base64 HTML/JS/CSS/image frames over ack;
    // 12 MiB covers typical dev-server assets (default is only 1 MiB).
    maxHttpBufferSize: 12 * 1024 * 1024,
  });

  io.on('connection', (socket: Socket) => {
    console.log(`[WS] client connected: ${socket.id}`);

    // Track subscriber handle for cleanup
    const subscriber: WorkroomSubscriber = { socket, context: socket.id };
    // Human presence: (workroomId → userId) pairs this socket contributes to.
    const userSubs = new Map<string, string>();
    // Preview reverse-tunnel: when a MACHINE (daemon) subscribes, remember its
    // socket so /preview/* can proxy HTTP into that machine's localhost.
    let boundMachineId: string | null = null;

    // ── subscribe ────────────────────────────────────────────────────────────
    socket.on('subscribe', async (msg: { workroom_id?: string; token?: string }) => {
      if (!msg.workroom_id || !msg.token) {
        socket.emit('error', { code: 'MISSING_FIELDS', message: 'workroom_id and token required' });
        return;
      }

      // Authenticate and verify workroom scope in one step.
      // tokenInWorkroom accepts machine_token / dev_ctl_ / op_sess_ / user_sess_ tokens.
      const scope = await tokenInWorkroom(msg.token, msg.workroom_id);
      if (!scope) {
        socket.emit('error', { code: 'FORBIDDEN', message: 'Invalid token or not authorized for this workroom' });
        socket.disconnect(true);
        return;
      }

      subscriber.context = `${scope.mode}:${socket.id}`;
      // Viewer identity powers per-subscriber channel-visibility filtering for
      // content-bearing events (message previews must not leak across private
      // channels to subscribers who cannot read them via REST).
      subscriber.viewer = { kind: scope.mode, id: scope.viewerId };
      workroomBroadcaster.subscribe(msg.workroom_id, subscriber);
      if (scope.mode === 'user' && !userSubs.has(msg.workroom_id)) {
        userSubs.set(msg.workroom_id, scope.viewerId);
        userSubscribed(msg.workroom_id, scope.viewerId);
      }
      if (scope.mode === 'machine') {
        boundMachineId = scope.viewerId;
        registerMachineSocket(scope.viewerId, socket);
      }
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
      const uid = userSubs.get(msg.workroom_id);
      if (uid) { userSubs.delete(msg.workroom_id); userUnsubscribed(msg.workroom_id, uid); }
      socket.emit('unsubscribed', { workroom_id: msg.workroom_id });
    });

    // ── activity(可见页面的活跃心跳;见 userPresence.ts)──────────────────
    socket.on('activity', (msg: { workroom_id?: string }) => {
      const wid = msg?.workroom_id;
      if (!wid) return;
      const uid = userSubs.get(wid);
      if (uid) userActivity(wid, uid);
    });

    // ── ping ─────────────────────────────────────────────────────────────────
    socket.on('ping', () => {
      socket.emit('pong');
    });

    // ── disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      workroomBroadcaster.unsubscribeAll(subscriber);
      for (const [widKey, uid] of userSubs) userUnsubscribed(widKey, uid);
      userSubs.clear();
      if (boundMachineId) unregisterMachineSocket(boundMachineId, socket);
      console.log(`[WS] client disconnected: ${socket.id} reason=${reason}`);
    });
  });

  console.log('[WS] Control plane WebSocket gateway attached at /api/v1/ws/control');
  return io;
}
