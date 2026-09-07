/**
 * previewTunnel — expose an agent's LOCAL preview server (e.g. a Vite dev server
 * the agent spun up on the Mac's localhost:PORT for a design decision) to the
 * user's browser through a public URL, by reverse-proxying HTTP over the daemon's
 * existing Socket.IO control connection.
 *
 * Flow:
 *   1. Daemon rewrites "http://localhost:50440" in an agent message → asks the
 *      server to mint a preview session (registerPreview) → gets a public URL.
 *   2. User opens https://mio.wdao.chat/preview/<token>/<path>.
 *   3. previewRoutes looks up the token → the owning machine's live socket →
 *      emitWithAck('preview:req', …) → the daemon fetches 127.0.0.1:PORT/<path>
 *      and acks back {status, headers, body_base64} → server streams it to the
 *      browser.
 *
 * Security (per product decision): unguessable random token + TTL. Anyone with
 * the link can view while it's alive (the link only appears in the channel).
 * The daemon side restricts proxying to loopback (127.0.0.1) — never arbitrary
 * hosts. Sessions are in-memory (previews are transient; a server restart just
 * means the agent re-registers on its next message).
 */

import type { Socket } from 'socket.io';
import { randomBytes } from 'node:crypto';

// ── machineId → live control socket ─────────────────────────────────────────
// Registered by wsGateway when a MACHINE subscribes; cleared on disconnect.
const machineSockets = new Map<string, Socket>();

export function registerMachineSocket(machineId: string, socket: Socket): void {
  machineSockets.set(machineId, socket);
}
export function unregisterMachineSocket(machineId: string, socket: Socket): void {
  // Only clear if the current entry is THIS socket (avoid a stale disconnect
  // wiping a fresh reconnect that already re-registered).
  if (machineSockets.get(machineId) === socket) machineSockets.delete(machineId);
}
export function getMachineSocket(machineId: string): Socket | undefined {
  return machineSockets.get(machineId);
}

// ── preview sessions: token → (machineId, port) ─────────────────────────────
interface PreviewSession {
  machineId: string;
  port: number;
  expiresAt: number;
}
const sessions = new Map<string, PreviewSession>();
const TTL_MS = 12 * 60 * 60 * 1000; // 12h
// Reuse an existing live token for the same (machine, port) so re-registering the
// same preview keeps a stable URL instead of leaking a new token per message.
const byMachinePort = new Map<string, string>(); // `${machineId}:${port}` → token

function sweep(): void {
  const now = Date.now();
  for (const [tok, s] of sessions) {
    if (s.expiresAt <= now) {
      sessions.delete(tok);
      byMachinePort.delete(`${s.machineId}:${s.port}`);
    }
  }
}

/** Mint (or reuse) a preview token for a machine's local port. Returns the token
 *  only — the caller builds the public URL from its own request origin. */
export function registerPreview(machineId: string, port: number): string {
  sweep();
  const key = `${machineId}:${port}`;
  const existing = byMachinePort.get(key);
  if (existing) {
    const s = sessions.get(existing);
    if (s) { s.expiresAt = Date.now() + TTL_MS; return existing; }
  }
  const token = randomBytes(24).toString('base64url');
  sessions.set(token, { machineId, port, expiresAt: Date.now() + TTL_MS });
  byMachinePort.set(key, token);
  return token;
}

export function getPreview(token: string): { machineId: string; port: number } | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { sessions.delete(token); byMachinePort.delete(`${s.machineId}:${s.port}`); return null; }
  return { machineId: s.machineId, port: s.port };
}

// ── the request/response frames carried over Socket.IO ──────────────────────
export interface PreviewReqFrame {
  port: number;
  method: string;
  path: string; // path + query, starting with '/'
  headers: Record<string, string>;
  body_base64?: string;
}
export interface PreviewResFrame {
  status: number;
  headers: Record<string, string>;
  body_base64: string;
  error?: string;
}
