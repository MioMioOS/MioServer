/**
 * cliRoutes — "CLI mode": a live, terminal-style view of what the runtimes
 * (Claude Code / Codex) are actually doing in a channel, plus a way for the
 * workspace OWNER to type straight into a session or run a shell command on
 * the agent's computer.
 *
 * Daemon side (machine token + X-Mio-Agent-Id):
 *   POST /internal/agent-api/cli/events   — append a batch of stream events
 *   POST /internal/agent-api/cli/inputs   — claim the owner's pending inputs
 *   POST /internal/agent-api/cli/files    — hand over a file from the machine (owner asked to open it)
 *
 * Owner side (user_sess_, workroom OWNER only — the stream shows file contents
 * and command output, and the input can run commands on a machine):
 *   GET  /api/v1/workrooms/:wid/channels/:cid/cli?after=<id>
 *   POST /api/v1/workrooms/:wid/channels/:cid/cli/input
 *
 * Delivery is tick-and-fetch, like messages: the WS events `agent.stream` and
 * `agent.cli_input` carry ids only. Every member's socket receives workroom
 * broadcasts, so content never rides on them.
 *
 * Retention: both tables are purged of rows older than 2 days.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { authorizeAgentApi } from '@/control/agentApi/agentApiAuth';
import { resolveActor } from '@/auth/userOrMachine/resolveActor';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

const RETENTION_MS = 2 * 24 * 3600 * 1000;
const PURGE_EVERY_MS = 10 * 60 * 1000;
const MAX_BATCH = 200;
const MAX_PAYLOAD_CHARS = 20_000;
const MAX_INPUT_CHARS = 20_000;
const EVENT_KINDS = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'input', 'shell_cmd', 'shell_out', 'shell_exit', 'system', 'turn', 'file']);
const INPUT_KINDS = new Set(['prompt', 'shell', 'command', 'file']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_ATTACHMENTS = 10;

let lastPurgeAt = 0;
async function purgeOld(): Promise<void> {
  const now = Date.now();
  if (now - lastPurgeAt < PURGE_EVERY_MS) return;
  lastPurgeAt = now;
  const cutoff = new Date(now - RETENTION_MS);
  try {
    await db.controlCliEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await db.controlCliInput.deleteMany({ where: { createdAt: { lt: cutoff } } });
  } catch (err) {
    console.error('[cli] purge failed', err);
  }
}

function tick(workroomId: string, topic: 'agent.stream' | 'agent.cli_input', payload: Record<string, unknown>): void {
  const nowIso = new Date().toISOString();
  workroomBroadcaster.broadcast(workroomId, {
    event_id: randomUUID(),
    workroom_id: workroomId,
    seq: '0', // synthetic, ephemeral — clients must not advance their cursor on it
    topic,
    payload: { ...payload, workroom_id: workroomId },
    created_at: nowIso,
  });
}

type OwnerResult = { ok: true; userId: string } | { ok: false; status: number; code: string; message: string };

/** user_sess_ + workroom OWNER. Machines and non-owner members are refused. */
async function requireOwner(request: FastifyRequest, workroomId: string): Promise<OwnerResult> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || !authHeader.slice(7).startsWith(USER_SESSION_TOKEN_PREFIX)) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
  }
  const session = await resolveUserSession(authHeader);
  if (!session) return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'Invalid or expired session' };
  const actor = await resolveActor(request, { workroomId });
  if (!actor || actor.kind !== 'user' || actor.workroomRole !== 'owner') {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Workspace owner only' };
  }
  return { ok: true, userId: actor.userId };
}

async function channelInWorkroom(channelId: string, workroomId?: string): Promise<{ id: string; workroomId: string } | null> {
  try {
    const ch = await db.controlChannel.findUnique({ where: { id: channelId }, select: { id: true, workroomId: true } });
    if (!ch || (workroomId && ch.workroomId !== workroomId)) return null;
    return ch;
  } catch {
    return null; // malformed uuid
  }
}

const wire = (e: { id: bigint; agentId: string; kind: string; payload: unknown; createdAt: Date }) => ({
  id: e.id.toString(), agent_id: e.agentId, kind: e.kind, payload: e.payload, created_at: e.createdAt.toISOString(),
});

export async function cliRoutes(app: FastifyInstance) {
  // ── daemon → server: stream events ─────────────────────────────────────────
  app.post('/internal/agent-api/cli/events', { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    const body = request.body as { channel_id?: unknown; events?: unknown } | null;
    if (!body || typeof body.channel_id !== 'string' || !Array.isArray(body.events)) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel_id and events[] are required' } });
    }
    const channel = await channelInWorkroom(body.channel_id);
    if (!channel) return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });

    const rows = (body.events as Array<{ kind?: unknown; payload?: unknown }>)
      .slice(0, MAX_BATCH)
      .filter((e) => e && typeof e.kind === 'string' && EVENT_KINDS.has(e.kind) && e.payload && typeof e.payload === 'object')
      .filter((e) => JSON.stringify(e.payload).length <= MAX_PAYLOAD_CHARS)
      .map((e) => ({ workroomId: channel.workroomId, channelId: channel.id, agentId: auth.agent.id, kind: e.kind as string, payload: e.payload as object }));
    if (rows.length > 0) {
      await db.controlCliEvent.createMany({ data: rows });
      tick(channel.workroomId, 'agent.stream', { agent_id: auth.agent.id, channel_id: channel.id });
    }
    void purgeOld();
    return reply.code(202).send({ ok: true, stored: rows.length });
  });

  // ── daemon → server: claim pending owner inputs ────────────────────────────
  app.post('/internal/agent-api/cli/inputs', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    const pending = await db.controlCliInput.findMany({
      where: { agentId: auth.agent.id, consumedAt: null, createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    if (pending.length > 0) {
      await db.controlCliInput.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { consumedAt: new Date() } });
    }
    return reply.send({
      inputs: pending.map((p) => ({
        id: p.id, channel_id: p.channelId, kind: p.kind, text: p.text, created_at: p.createdAt.toISOString(),
        attachment_ids: Array.isArray((p.meta as { attachment_ids?: unknown } | null)?.attachment_ids) ? (p.meta as { attachment_ids: string[] }).attachment_ids : [],
      })),
    });
  });

  // ── daemon → server: a file from the machine, for the owner to look at ──────
  app.post('/internal/agent-api/cli/files', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    const body = request.body as { channel_id?: unknown; path?: unknown; filename?: unknown; mime_type?: unknown; data_base64?: unknown } | null;
    if (!body || typeof body.channel_id !== 'string' || typeof body.path !== 'string' || typeof body.filename !== 'string' || typeof body.data_base64 !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel_id, path, filename and data_base64 are required' } });
    }
    const channel = await channelInWorkroom(body.channel_id);
    if (!channel) return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });
    const buf = Buffer.from(body.data_base64, 'base64');
    if (buf.length === 0 || buf.length > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: { code: 'TOO_LARGE', message: `file must be 1 byte to ${MAX_FILE_BYTES} bytes` } });
    }
    const mimeType = typeof body.mime_type === 'string' && body.mime_type.trim() ? body.mime_type : 'application/octet-stream';
    const attachment = await db.controlAttachment.create({
      data: { workroomId: channel.workroomId, channelId: channel.id, uploaderKind: 'agent', uploaderId: auth.agent.id, filename: body.filename.slice(0, 255), mimeType, sizeBytes: BigInt(buf.length), data: buf },
    });
    await db.controlCliEvent.create({
      data: {
        workroomId: channel.workroomId, channelId: channel.id, agentId: auth.agent.id, kind: 'file',
        payload: { path: body.path.slice(0, 1000), attachment: { id: attachment.id, filename: attachment.filename, mime_type: mimeType, size_bytes: buf.length } },
      },
    });
    tick(channel.workroomId, 'agent.stream', { agent_id: auth.agent.id, channel_id: channel.id });
    return reply.code(201).send({ attachment_id: attachment.id });
  });

  // ── owner: read the stream ────────────────────────────────────────────────
  app.get('/api/v1/workrooms/:wid/channels/:cid/cli', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };
    const owner = await requireOwner(request, wid);
    if (!owner.ok) return reply.code(owner.status).send({ error: { code: owner.code, message: owner.message } });
    const channel = await channelInWorkroom(cid, wid);
    if (!channel) return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });

    const q = request.query as { after?: string; before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 400, 1), 1000);
    let events;
    if (q.after && /^\d+$/.test(q.after)) {
      events = await db.controlCliEvent.findMany({ where: { channelId: cid, id: { gt: BigInt(q.after) } }, orderBy: { id: 'asc' }, take: limit });
    } else if (q.before && /^\d+$/.test(q.before)) {
      // older history: the `limit` rows just before the cursor, oldest-first
      events = (await db.controlCliEvent.findMany({ where: { channelId: cid, id: { lt: BigInt(q.before) } }, orderBy: { id: 'desc' }, take: limit })).reverse();
    } else {
      // first load: the newest `limit`, returned oldest-first
      events = (await db.controlCliEvent.findMany({ where: { channelId: cid }, orderBy: { id: 'desc' }, take: limit })).reverse();
    }
    return reply.send({ events: events.map(wire), retention_hours: RETENTION_MS / 3600_000 });
  });

  // ── owner: type into a session / run a shell command ───────────────────────
  app.post('/api/v1/workrooms/:wid/channels/:cid/cli/input', async (request, reply) => {
    const { wid, cid } = request.params as { wid: string; cid: string };
    const owner = await requireOwner(request, wid);
    if (!owner.ok) return reply.code(owner.status).send({ error: { code: owner.code, message: owner.message } });
    const channel = await channelInWorkroom(cid, wid);
    if (!channel) return reply.code(404).send({ error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' } });

    const body = request.body as { agent_id?: unknown; kind?: unknown; text?: unknown; attachment_ids?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!body || typeof body.agent_id !== 'string' || typeof body.kind !== 'string' || !INPUT_KINDS.has(body.kind) || !text || text.length > MAX_INPUT_CHARS) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'agent_id, kind (prompt|shell|command|file) and text are required' } });
    }
    // Files sent along with a prompt: already uploaded to this channel by the owner.
    const wantIds = Array.isArray(body.attachment_ids) ? (body.attachment_ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_INPUT_ATTACHMENTS) : [];
    let attachments: Array<{ id: string; filename: string; mime_type: string; size_bytes: number }> = [];
    if (wantIds.length > 0) {
      try {
        const found = await db.controlAttachment.findMany({ where: { id: { in: wantIds }, workroomId: wid }, select: { id: true, filename: true, mimeType: true, sizeBytes: true } });
        attachments = wantIds.map((id) => found.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => !!f)
          .map((f) => ({ id: f.id, filename: f.filename, mime_type: f.mimeType, size_bytes: Number(f.sizeBytes) }));
      } catch { /* malformed uuid in the list → treat as none */ }
    }
    let agent: { id: string; orgId: string; machineId: string | null } | null = null;
    try {
      agent = await db.controlAgent.findUnique({ where: { id: body.agent_id }, select: { id: true, orgId: true, machineId: true } });
    } catch { /* malformed uuid → 404 below */ }
    const workroom = await db.controlWorkroom.findUnique({ where: { id: wid }, select: { orgId: true } });
    if (!agent || !workroom || agent.orgId !== workroom.orgId) {
      return reply.code(404).send({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } });
    }
    if (!agent.machineId) {
      return reply.code(409).send({ error: { code: 'AGENT_NOT_RUNNING', message: 'This agent is not bound to a computer' } });
    }

    const input = await db.controlCliInput.create({
      data: {
        workroomId: wid, channelId: cid, agentId: agent.id, kind: body.kind, text, createdBy: owner.userId,
        ...(attachments.length > 0 ? { meta: { attachment_ids: attachments.map((a) => a.id) } } : {}),
      },
    });
    // Echo what was typed into the timeline so the view shows it at once.
    // (opening a file echoes nothing: the file itself is the visible result)
    if (body.kind !== 'file') {
      await db.controlCliEvent.create({
        data: {
          workroomId: wid, channelId: cid, agentId: agent.id, kind: body.kind === 'shell' ? 'shell_cmd' : 'input',
          payload: { text, input_id: input.id, ...(attachments.length > 0 ? { attachments } : {}) },
        },
      });
    }
    tick(wid, 'agent.cli_input', { agent_id: agent.id, channel_id: cid });
    tick(wid, 'agent.stream', { agent_id: agent.id, channel_id: cid });
    void purgeOld();
    return reply.code(202).send({ ok: true, input_id: input.id });
  });
}
