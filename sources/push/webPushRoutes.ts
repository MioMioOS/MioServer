/**
 * Web Push subscription routes for the browser / PWA client (codelight-web).
 *
 * Auth: user_sess_ Bearer via requireUser() (same as the Slock web routes).
 *   GET  /v1/webpush/vapid-public-key   → { key }         (public; used as applicationServerKey)
 *   POST /v1/webpush/subscribe          → { ok: true }    (store PushManager subscription)
 *   POST /v1/webpush/unsubscribe        → { ok: true }    (remove by endpoint)
 *
 * The public key endpoint is authed too (keeps it simple) — the key isn't a
 * secret, but the client is always logged in before it can subscribe anyway.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@/auth/userSession/requireUser';
import {
  getVapidPublicKey,
  webPushEnabled,
  saveSubscription,
  deleteSubscription,
} from './webpush';

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export async function webPushRoutes(app: FastifyInstance) {
  app.get('/v1/webpush/vapid-public-key', { preHandler: requireUser() }, async () => {
    return { key: getVapidPublicKey(), enabled: webPushEnabled() };
  });

  app.post(
    '/v1/webpush/subscribe',
    { preHandler: requireUser(), schema: { body: subscriptionSchema } },
    async (req) => {
      const sub = req.body as z.infer<typeof subscriptionSchema>;
      await saveSubscription(req.user!.id, sub, req.headers['user-agent']);
      return { ok: true };
    },
  );

  app.post(
    '/v1/webpush/unsubscribe',
    { preHandler: requireUser(), schema: { body: z.object({ endpoint: z.string() }) } },
    async (req) => {
      const { endpoint } = req.body as { endpoint: string };
      await deleteSubscription(endpoint);
      return { ok: true };
    },
  );
}
