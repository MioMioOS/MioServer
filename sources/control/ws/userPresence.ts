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
// 活跃度层:仅"页面可见"的客户端每 60s 上报 activity。连接≠在线——一个后台
// 挂几小时的标签页会永远保持 socket(见 07-07 xxy 幽灵在线事故),所以在线的
// 定义 = 有 socket 且 3 分钟内有活跃心跳。
const lastActive = new Map<string, Map<string, number>>(); // wid → userId → epoch ms
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

function isActive(workroomId: string, userId: string): boolean {
  const t = lastActive.get(workroomId)?.get(userId);
  return t !== undefined && Date.now() - t < ACTIVE_WINDOW_MS;
}

/** 客户端活跃心跳(页面可见时每 60s + 变为可见时立即)。不活跃→活跃才广播。 */
export function userActivity(workroomId: string, userId: string): void {
  let m = lastActive.get(workroomId);
  if (!m) { m = new Map(); lastActive.set(workroomId, m); }
  const wasActive = isActive(workroomId, userId);
  m.set(userId, Date.now());
  const connected = (counts.get(workroomId)?.get(userId) ?? 0) > 0;
  if (!wasActive && connected) broadcast(workroomId, userId, 'online');
}

// 后台清扫:活跃窗口过期 → 广播 offline(socket 仍在,重新活跃会再上线)。
setInterval(() => {
  for (const [wid, m] of lastActive) {
    for (const [uid, t] of m) {
      if (Date.now() - t >= ACTIVE_WINDOW_MS) {
        m.delete(uid);
        if ((counts.get(wid)?.get(uid) ?? 0) > 0) broadcast(wid, uid, 'offline');
      }
    }
  }
}, 30_000).unref();

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
  // 订阅本身不再等于在线:等第一个 activity 心跳(页面可见的客户端会在
  // subscribe ack 后立即发一次)。后台幽灵标签页只订阅、不心跳 → 不上线。
}

export function userUnsubscribed(workroomId: string, userId: string): void {
  const m = counts.get(workroomId);
  if (!m) return;
  const n = (m.get(userId) ?? 0) - 1;
  if (n <= 0) {
    m.delete(userId);
    const wasActive = isActive(workroomId, userId);
    lastActive.get(workroomId)?.delete(userId);
    if (wasActive) broadcast(workroomId, userId, 'offline');
  } else m.set(userId, n);
}

export function onlineUserIds(workroomId: string): Set<string> {
  const ids = new Set<string>();
  for (const uid of counts.get(workroomId)?.keys() ?? []) {
    if (isActive(workroomId, uid)) ids.add(uid);
  }
  return ids;
}
