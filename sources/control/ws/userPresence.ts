/**
 * userPresence.ts — real human online tracking from live WS subscriptions.
 *
 * A human is "online" in a workroom while at least one of their authenticated
 * WS sockets is subscribed to it (web tab, phone app — anything on the control
 * WS). Ref-counted per (workroom, user) so multiple tabs don't flap the state.
 * On 0↔1 transitions an ephemeral `user.status` event is broadcast (synthetic
 * seq '0', same convention as agent.status — clients must not advance their
 * lastSeenSeq on it). The humans list endpoint reads onlineUserIds() for the
 * initial snapshot; the WS event keeps clients fresh afterwards.
 */

import { randomUUID } from 'node:crypto';
import { workroomBroadcaster } from './workroomBroadcaster';
import { db } from '@/storage/db';

const counts = new Map<string, Map<string, number>>(); // wid → userId → socket refcount

function broadcast(workroomId: string, userId: string, state: 'online' | 'offline'): void {
  const now = new Date();
  workroomBroadcaster.broadcast(workroomId, {
    event_id: randomUUID(),
    workroom_id: workroomId,
    seq: '0', // synthetic — clients MUST NOT advance lastSeenSeq on this topic
    topic: 'user.status',
    payload: { user_id: userId, state, last_seen_at: now.toISOString() },
    created_at: now.toISOString(),
  });
  // Persist "last seen" on BOTH transitions (online stamps activity; offline
  // stamps departure) so 「最后在线 X 前」 survives server restarts.
  void db.user.update({ where: { id: userId }, data: { lastSeenAt: now } })
    .catch((err: unknown) => console.warn('[userPresence] lastSeenAt update failed', err instanceof Error ? err.message : err));
  console.info(`[userPresence] ${userId.slice(0, 8)} ${state} in workroom=${workroomId.slice(0, 8)}`);
}

export function userSubscribed(workroomId: string, userId: string): void {
  let m = counts.get(workroomId);
  if (!m) { m = new Map(); counts.set(workroomId, m); }
  const n = (m.get(userId) ?? 0) + 1;
  m.set(userId, n);
  if (n === 1) broadcast(workroomId, userId, 'online');
}

export function userUnsubscribed(workroomId: string, userId: string): void {
  const m = counts.get(workroomId);
  if (!m) return;
  const n = (m.get(userId) ?? 0) - 1;
  if (n <= 0) { m.delete(userId); broadcast(workroomId, userId, 'offline'); }
  else m.set(userId, n);
}

export function onlineUserIds(workroomId: string): Set<string> {
  return new Set(counts.get(workroomId)?.keys() ?? []);
}
