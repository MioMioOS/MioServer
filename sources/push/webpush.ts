/**
 * Web Push (VAPID) for the browser / PWA client (codelight-web).
 *
 * Parallel to APNs (sources/push/apns.ts): where notify.ts fans a mention or
 * task-done out to iOS devices, it ALSO calls sendWebPushToUsers() here so an
 * installed PWA (iPhone 16.4+ / Android / desktop) buzzes even when closed.
 *
 * Enablement: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY must both be set (server
 * .env). Missing either → webPushEnabled()=false and every call is a no-op, so
 * the feature degrades cleanly on a box without keys.
 *
 * Subscriptions live in WebPushSubscription (keyed by endpoint). Sends that
 * come back 404/410 (browser dropped the subscription) self-heal by deleting
 * the dead row.
 */

import webpush from 'web-push';
import { db } from '@/storage/db';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? '';
// RFC 8292 `sub` — a mailto: or https: the push service can contact. Non-secret.
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@wdao.chat';

const enabled = !!(PUBLIC_KEY && PRIVATE_KEY);
if (enabled) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
}

export function webPushEnabled(): boolean {
  return enabled;
}

/** Public VAPID key — safe to hand to the browser (applicationServerKey). */
export function getVapidPublicKey(): string {
  return PUBLIC_KEY;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Upsert a browser subscription for a user (re-subscribe from the same
 *  endpoint just refreshes keys + lastSeenAt). */
export async function saveSubscription(
  userId: string,
  sub: BrowserSubscription,
  ua?: string,
): Promise<void> {
  await db.webPushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: {
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      ua: ua ?? null,
    },
    update: {
      userId,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      ua: ua ?? null,
      lastSeenAt: new Date(),
    },
  });
}

/** Remove a subscription by endpoint (client unsubscribe / dead-token prune). */
export async function deleteSubscription(endpoint: string): Promise<void> {
  await db.webPushSubscription.deleteMany({ where: { endpoint } });
}

export interface WebPushPayload {
  title: string;
  body: string;
  /** Deep-link data — mirrors the APNs custom payload (type/workroomId/…). */
  data?: Record<string, string>;
}

/**
 * Fan a payload out to every browser subscription of the given users.
 * Fire-and-forget per subscription; dead endpoints (404/410) are deleted.
 *
 * @param excludeUserId sender — never push someone their own message.
 */
export async function sendWebPushToUsers(
  userIds: string[],
  payload: WebPushPayload,
  excludeUserId?: string | null,
): Promise<void> {
  if (!enabled) return;
  const recipients = [...new Set(userIds)].filter((id) => id && id !== excludeUserId);
  if (recipients.length === 0) return;

  const subs = await db.webPushSubscription.findMany({
    where: { userId: { in: recipients } },
    select: { endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 * 60, urgency: 'high' },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Subscription is gone — prune so we stop trying.
          await deleteSubscription(s.endpoint).catch(() => {});
        } else {
          console.error('[webpush] send failed', status ?? '', (err as Error).message);
        }
      }
    }),
  );
  console.log(`[webpush] sent to ${subs.length} subscription(s) for ${recipients.length} user(s)`);
}
