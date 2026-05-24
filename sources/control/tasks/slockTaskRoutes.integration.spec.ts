/**
 * S3 Slock Task routes — REAL Postgres integration.
 *
 * FAST MODE: only the meaningful cases —
 *   - auth: dev_ctl_ → 403 on writes; reads accept dev_ctl_ (allowlist) + machine.
 *   - channel scoping: GET channel tasks returns only that channel's tasks; cross-workroom 404.
 *   - create / setStatus / assign happy-path (+ status translation at the boundary).
 *   - one key error each: create on foreign channel → 404; setStatus bad vocab → 400;
 *     setStatus on foreign task → 404.
 *   - event: task.created / task.updated written (write-before-broadcast).
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { slockTaskRoutes } from './slockTaskRoutes';
import { taskRoutes } from './taskRoutes';
import { mintOperatorSession, V1_OPERATOR_COMMANDS } from '@/control/operatorSessions/operatorSessionMint';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();
const OPERATOR_SUBJECT_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let OP_SESS_RAW_TOKEN = '';
let CHANNEL_A = '';
let CHANNEL_B = '';
let OTHER_CHANNEL = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const opSessHeader = () => ({ authorization: `Bearer ${OP_SESS_RAW_TOKEN}` });
const devCtlHeader = () => ({ authorization: `Bearer ${DEV_CTL_RAW_TOKEN}` });

function req(method: string, url: string, headers: Record<string, string>, body?: Record<string, unknown>) {
  return APP.inject({
    method: method as 'GET' | 'POST' | 'PATCH',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  APP = fastify();
  await APP.register(slockTaskRoutes);
  await APP.register(taskRoutes); // workroom-aggregate GET lives here (S3 wire shape)
  await APP.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'SlockTask Org', slug: `slock-task-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlMachine.create({
    data: { id: MACHINE_ID, orgId: ORG_ID, tokenHash: sha256(MACHINE_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000), platform: 'darwin', arch: 'arm64' },
  });
  await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, name: 'slock-agent', displayName: 'Slock Agent', role: 'ops' } });
  await db.controlDevToken.create({
    data: { id: randomUUID(), orgId: ORG_ID, workroomId: WORKROOM_ID, tokenHash: sha256(DEV_CTL_RAW_TOKEN), scope: 'read_only', expiresAt: new Date(Date.now() + 24 * 3600_000) },
  });
  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'SlockTask WR', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM_ID, orgId: ORG_ID, name: 'Other WR', createdBy: randomUUID() } });

  const chA = await db.controlChannel.create({ data: { workroomId: WORKROOM_ID, name: 'chan-a', type: 'main', visibility: 'public', createdBy: 'system' } });
  CHANNEL_A = chA.id;
  const chB = await db.controlChannel.create({ data: { workroomId: WORKROOM_ID, name: 'chan-b', type: 'standard', visibility: 'public', createdBy: 'system' } });
  CHANNEL_B = chB.id;
  const otherCh = await db.controlChannel.create({ data: { workroomId: OTHER_WORKROOM_ID, name: 'other-chan', type: 'main', visibility: 'public', createdBy: 'system' } });
  OTHER_CHANNEL = otherCh.id;

  const minted = await mintOperatorSession({
    orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: OPERATOR_SUBJECT_ID, issuedBy: 'test', allowedCommands: [...V1_OPERATOR_COMMANDS],
  });
  OP_SESS_RAW_TOKEN = minted.rawToken;
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlTask.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlChannel.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlDevToken.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── Create ──────────────────────────────────────────────────────────────────────

describe('POST /workrooms/:wid/channels/:cid/tasks', () => {
  it('op_sess_ create: 201, status TODO, channel_id set, server stores todo', async () => {
    const res = await req('POST', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, opSessHeader(), { title: 'op task' });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();
    expect(body.channel_id).toBe(CHANNEL_A);
    expect(body.title).toBe('op task');
    expect(body.status).toBe('TODO'); // Slock vocab on the wire
    expect(body.assignee_id).toBeNull();
    expect(body.creator_id).toBeNull();
    expect(body).toHaveProperty('thread_id');

    // Server stored the server-vocab status.
    const stored = await db.controlTask.findUnique({ where: { id: body.id }, select: { status: true, channelId: true } });
    expect(stored!.status).toBe('todo');
    expect(stored!.channelId).toBe(CHANNEL_A);
  });

  it('machine create: 201', async () => {
    const res = await req('POST', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, machineHeader(), { title: 'machine task' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe('TODO');
  });

  it('dev_ctl_ create → 403 hard reject', async () => {
    const res = await req('POST', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, devCtlHeader(), { title: 'nope' });
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await req('POST', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, {}, { title: 'nope' });
    expect(res.statusCode).toBe(401);
  });

  it('missing title → 400', async () => {
    const res = await req('POST', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, opSessHeader(), {});
    expect(res.statusCode).toBe(400);
  });

  it('channel not in workroom → 404', async () => {
    const res = await req('POST', `/api/v1/workrooms/${WORKROOM_ID}/channels/${OTHER_CHANNEL}/tasks`, opSessHeader(), { title: 'x' });
    expect(res.statusCode).toBe(404);
  });

  it('task.created event written (write-before-broadcast)', async () => {
    const res = await req('POST', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, opSessHeader(), { title: 'evt task' });
    expect(res.statusCode).toBe(201);
    const taskId = JSON.parse(res.body).id;
    const event = await db.controlEventLog.findFirst({ where: { workroomId: WORKROOM_ID, topic: 'task.created' }, orderBy: { createdAt: 'desc' } });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.task_id).toBe(taskId);
    expect(payload.channel_id).toBe(CHANNEL_A);
    expect(payload.status).toBe('TODO');
  });
});

// ── Channel scoping (GET channel tasks) ──────────────────────────────────────────

describe('GET /workrooms/:wid/channels/:cid/tasks — channel scoping', () => {
  it('returns only tasks in that channel (machine + dev_ctl_)', async () => {
    await db.controlTask.create({ data: { workroomId: WORKROOM_ID, channelId: CHANNEL_B, title: 'only-in-B', status: 'todo' } });

    const resA = await req('GET', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, machineHeader());
    expect(resA.statusCode).toBe(200);
    const tasksA = JSON.parse(resA.body).tasks as Array<{ channel_id: string; title: string }>;
    expect(tasksA.length).toBeGreaterThan(0);
    expect(tasksA.every((t) => t.channel_id === CHANNEL_A)).toBe(true);
    expect(tasksA.some((t) => t.title === 'only-in-B')).toBe(false);

    // dev_ctl_ is allowlisted for the channel-scoped read.
    const resDev = await req('GET', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_B}/tasks`, devCtlHeader());
    expect(resDev.statusCode).toBe(200);
    const tasksB = JSON.parse(resDev.body).tasks as Array<{ title: string }>;
    expect(tasksB.some((t) => t.title === 'only-in-B')).toBe(true);
  });

  it('no auth → 401', async () => {
    const res = await req('GET', `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_A}/tasks`, {});
    expect(res.statusCode).toBe(401);
  });
});

// ── Workroom aggregate (taskRoutes.ts, S3 wire shape additive) ───────────────────

describe('GET /workrooms/:wid/tasks — workroom aggregate carries S3 Slock shape', () => {
  it('aggregate includes id, channel_id, Slock-vocab status, assignee_id', async () => {
    const res = await req('GET', `/api/v1/workrooms/${WORKROOM_ID}/tasks`, machineHeader());
    expect(res.statusCode).toBe(200);
    const tasks = JSON.parse(res.body).tasks as Array<Record<string, unknown>>;
    expect(tasks.length).toBeGreaterThan(0);
    const t = tasks[0];
    expect(t).toHaveProperty('id');
    expect(t).toHaveProperty('channel_id');
    expect(t).toHaveProperty('assignee_id');
    // Slock vocab is exposed as `slock_status` (iOS reads this). The legacy `status`
    // field stays SERVER vocab so the attention-first Home / ControlPlaneClient is unbroken.
    expect(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CLOSED']).toContain(t.slock_status);
    expect(['todo', 'in_progress', 'waiting_approval', 'in_review', 'done', 'canceled']).toContain(t.status);
    // pre-S3 attention contract still present.
    expect(t).toHaveProperty('attention_reason');
    expect(t).toHaveProperty('task_id');
  });
});

// ── setStatus ────────────────────────────────────────────────────────────────────

describe('PATCH /workrooms/:wid/tasks/:id/status', () => {
  async function makeTask(channelId = CHANNEL_A, status = 'todo'): Promise<string> {
    const t = await db.controlTask.create({ data: { workroomId: WORKROOM_ID, channelId, title: 'status-test', status } });
    return t.id;
  }

  it('op_sess_ setStatus IN_PROGRESS: 200, translated to in_progress on server', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/status`, opSessHeader(), { status: 'IN_PROGRESS' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('IN_PROGRESS');
    const stored = await db.controlTask.findUnique({ where: { id }, select: { status: true } });
    expect(stored!.status).toBe('in_progress');
  });

  it('CLOSED → server canceled (key translation)', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/status`, machineHeader(), { status: 'CLOSED' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('CLOSED');
    const stored = await db.controlTask.findUnique({ where: { id }, select: { status: true } });
    expect(stored!.status).toBe('canceled');
  });

  it('invalid status vocab → 400', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/status`, opSessHeader(), { status: 'BOGUS' });
    expect(res.statusCode).toBe(400);
  });

  it('dev_ctl_ → 403', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/status`, devCtlHeader(), { status: 'DONE' });
    expect(res.statusCode).toBe(403);
  });

  it('task not in workroom → 404', async () => {
    const foreign = await db.controlTask.create({ data: { workroomId: OTHER_WORKROOM_ID, channelId: OTHER_CHANNEL, title: 'foreign', status: 'todo' } });
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${foreign.id}/status`, opSessHeader(), { status: 'DONE' });
    expect(res.statusCode).toBe(404);
  });

  it('task.updated event written', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/status`, opSessHeader(), { status: 'IN_REVIEW' });
    expect(res.statusCode).toBe(200);
    const event = await db.controlEventLog.findFirst({ where: { workroomId: WORKROOM_ID, topic: 'task.updated' }, orderBy: { createdAt: 'desc' } });
    expect(event).not.toBeNull();
    expect((event!.payloadJson as Record<string, unknown>).task_id).toBe(id);
  });
});

// ── assign ───────────────────────────────────────────────────────────────────────

describe('PATCH /workrooms/:wid/tasks/:id/assignee', () => {
  async function makeTask(): Promise<string> {
    const t = await db.controlTask.create({ data: { workroomId: WORKROOM_ID, channelId: CHANNEL_A, title: 'assign-test', status: 'todo' } });
    return t.id;
  }

  it('op_sess_ assign sets ownerInstanceId + resolves display name', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/assignee`, opSessHeader(), { assignee_id: AGENT_ID });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.assignee_id).toBe(AGENT_ID);
    expect(body.assignee_display_name).toBe('Slock Agent');
    const stored = await db.controlTask.findUnique({ where: { id }, select: { ownerInstanceId: true } });
    expect(stored!.ownerInstanceId).toBe(AGENT_ID);
  });

  it('assign null clears the assignee', async () => {
    const id = await makeTask();
    await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/assignee`, opSessHeader(), { assignee_id: AGENT_ID });
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/assignee`, opSessHeader(), { assignee_id: null });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.assignee_id).toBeNull();
    expect(body.assignee_display_name).toBeNull();
  });

  it('missing assignee_id key → 400', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/assignee`, opSessHeader(), {});
    expect(res.statusCode).toBe(400);
  });

  it('dev_ctl_ → 403', async () => {
    const id = await makeTask();
    const res = await req('PATCH', `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/assignee`, devCtlHeader(), { assignee_id: AGENT_ID });
    expect(res.statusCode).toBe(403);
  });
});
