/**
 * previewRoutes — the public side of the preview reverse-tunnel (previewTunnel.ts).
 *
 *   POST /internal/agent-api/preview/register  { port }   (machine-authed)
 *     → mint a token for (this machine, port) → { url: "https://…/preview/<token>/" }
 *
 *   GET|HEAD /preview/:token/*                             (public, token = auth)
 *     → resolve token → owning machine's live socket → emitWithAck('preview:req')
 *     → relay the daemon's fetch of 127.0.0.1:PORT back to the browser.
 *
 * v1 scope: GET/HEAD only — enough to render a static/dev preview (HTML + JS +
 * CSS + images + fonts over GET). Interactive POST and HMR-over-WebSocket are
 * NOT tunneled (the page renders; live-reload won't reconnect). Response cap:
 * whatever fits Socket.IO's maxHttpBufferSize (raised where the WS is created).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeAgentApi } from '@/control/agentApi/agentApiAuth';
import {
  registerPreview,
  getPreview,
  getMachineSocket,
  type PreviewReqFrame,
  type PreviewResFrame,
} from './previewTunnel';

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://mio.wdao.chat').replace(/\/$/, '');
// Hop-by-hop headers must not be forwarded verbatim (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export async function previewRoutes(app: FastifyInstance) {
  // ── Mint a preview token (daemon calls this while rewriting a message) ──────
  app.post('/internal/agent-api/preview/register', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });

    const body = request.body as { port?: unknown } | null;
    const port = Number(body?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return reply.code(400).send({ error: { code: 'INVALID_PORT', message: 'port must be 1..65535' } });
    }
    const token = registerPreview(auth.machine.id, port);
    return reply.send({ url: `${PUBLIC_BASE}/preview/${token}/` });
  });

  // ── Public proxy: browser → server → (Socket.IO) → daemon → 127.0.0.1:PORT ──
  const proxy = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { token?: string; '*'?: string };
    const token = params.token ?? '';
    const sess = getPreview(token);
    if (!sess) return reply.code(404).type('text/plain; charset=utf-8').send('预览已过期或不存在。让 agent 重新发一次预览链接即可。');

    const socket = getMachineSocket(sess.machineId);
    if (!socket) return reply.code(502).type('text/plain; charset=utf-8').send('运行 agent 的电脑当前离线,无法打开预览。');

    // Reconstruct the sub-path + query the browser asked for.
    const rest = params['*'] ?? '';
    const qIdx = request.url.indexOf('?');
    const query = qIdx >= 0 ? request.url.slice(qIdx) : '';
    const path = `/${rest}${query}`;

    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(k) || k === 'host') continue;
      if (typeof v === 'string') fwdHeaders[k] = v;
    }

    const frame: PreviewReqFrame = { port: sess.port, method: request.method, path, headers: fwdHeaders };

    let res: PreviewResFrame;
    try {
      res = (await socket.timeout(20000).emitWithAck('preview:req', frame)) as PreviewResFrame;
    } catch {
      return reply.code(504).type('text/plain; charset=utf-8').send('预览请求超时 — 本地服务可能没在跑,或响应太大。');
    }
    if (!res || res.error) {
      return reply.code(502).type('text/plain; charset=utf-8').send(`预览后端出错:${res?.error ?? '未知'}`);
    }

    for (const [k, v] of Object.entries(res.headers ?? {})) {
      if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'content-length') continue;
      reply.header(k, v);
    }
    reply.code(res.status || 200);
    return reply.send(Buffer.from(res.body_base64 ?? '', 'base64'));
  };

  // Fastify auto-registers HEAD alongside GET, so declaring GET is enough.
  app.get('/preview/:token/*', proxy);
  // Bare token with no trailing path (e.g. /preview/<token>) — normalize to root.
  app.get('/preview/:token', proxy);
}
