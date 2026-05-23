/**
 * #186 — per-task ATTENTION signal on GET /workrooms/:id/tasks (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Pins the action-driven bucketing contract the attention-first Home depends on:
 *   - a task with a needs_human action  -> attention_reason:['needs_human'], pending_attention_count≥1
 *   - a task with only in-flight (non-terminal, non-needs_human) actions -> Active (no attention, pending_action_count>0)
 *   - a task with only terminal actions / no actions -> Recent (empty/0)
 *   - dedupe: multiple needs_human actions -> one 'needs_human' reason, count = N
 *   - isolation: actions from another task don't bleed across task_id
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { taskRoutes } from './taskRoutes';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const AGENT_ID = randomUUID();
const SESSION_ID = randomUUID();
const MACHINE_ID = randomUUID();
const MACHINE_RAW_TOKEN = `machine_raw_${randomUUID()}`;

let app: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function makeTask(title: string, status = 'todo'): Promise<string> {
  const id = randomUUID();
  await db.controlTask.create({ data: { id, workroomId: WORKROOM_ID, title, status, ownerInstanceId: AGENT_ID } });
  return id;
}

async function makeAction(taskId: string, status: string): Promise<void> {
  await db.controlAction.create({
    data: {
      id: randomUUID(), sessionId: SESSION_ID, workroomId: WORKROOM_ID, taskId, actorAgentId: AGENT_ID,
      kind: 'other', summary: 'attn test action', reversibility: 'reversible', riskLevel: 'low',
      requiresApproval: false, status, clientIdempotencyKey: `attn-${randomUUID()}`,
    },
  });
}

async function listTasks() {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/workrooms/${WORKROOM_ID}/tasks`,
    headers: { authorization: `Bearer ${MACHINE_RAW_TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body).tasks as Array<{
    task_id: string; attention_reason: string[]; pending_attention_count: number; pending_action_count: number;
    owner_instance_id: string | null; owner_display_name: string | null;
  }>);
}

beforeAll(async () => {
  app = fastify();
  await app.register(taskRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'Attn Org', slug: `attn-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlMachine.create({
    data: { id: MACHINE_ID, orgId: ORG_ID, tokenHash: sha256(MACHINE_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000), platform: 'darwin', arch: 'arm64' },
  });
  await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, name: 'attn-agent', displayName: 'Attn Agent', role: 'ops' } });
  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Attn WR', createdBy: randomUUID() } });
  await db.controlSession.create({
    data: { id: SESSION_ID, orgId: ORG_ID, workroomId: WORKROOM_ID, machineId: MACHINE_ID, mode: 'daemon', runtime: 'claude', displayName: 'attn-session' },
  });
});

afterAll(async () => {
  await db.controlAction.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await app.close();
  await db.$disconnect();
});

describe('#186 per-task attention signal (GET /workrooms/:id/tasks)', () => {
  it('task with a needs_human action -> Attention (attention_reason:[needs_human])', async () => {
    const taskId = await makeTask('attn-needs-human', 'in_progress');
    await makeAction(taskId, 'needs_human');
    const t = (await listTasks()).find((x) => x.task_id === taskId)!;
    expect(t.attention_reason).toEqual(['needs_human']);
    expect(t.pending_attention_count).toBe(1);
    expect(t.pending_action_count).toBeGreaterThanOrEqual(1); // needs_human is non-terminal -> in-flight
  });

  it('task with only an in-flight (fired) action -> Active (no attention, pending_action_count>0)', async () => {
    const taskId = await makeTask('attn-active', 'in_progress');
    await makeAction(taskId, 'fired');
    const t = (await listTasks()).find((x) => x.task_id === taskId)!;
    expect(t.attention_reason).toEqual([]);
    expect(t.pending_attention_count).toBe(0);
    expect(t.pending_action_count).toBe(1);
  });

  it('task with only a terminal (succeeded) action -> Recent (empty/0)', async () => {
    const taskId = await makeTask('attn-recent', 'in_review');
    await makeAction(taskId, 'succeeded');
    const t = (await listTasks()).find((x) => x.task_id === taskId)!;
    expect(t.attention_reason).toEqual([]);
    expect(t.pending_attention_count).toBe(0);
    expect(t.pending_action_count).toBe(0); // succeeded is terminal -> not in-flight
  });

  it('task with NO actions -> empty/0 (no attention)', async () => {
    const taskId = await makeTask('attn-noactions', 'todo');
    const t = (await listTasks()).find((x) => x.task_id === taskId)!;
    expect(t.attention_reason).toEqual([]);
    expect(t.pending_attention_count).toBe(0);
    expect(t.pending_action_count).toBe(0);
  });

  it('multiple needs_human actions -> reason deduped, count = N', async () => {
    const taskId = await makeTask('attn-multi', 'in_progress');
    await makeAction(taskId, 'needs_human');
    await makeAction(taskId, 'needs_human');
    const t = (await listTasks()).find((x) => x.task_id === taskId)!;
    expect(t.attention_reason).toEqual(['needs_human']); // set semantics: deduped
    expect(t.pending_attention_count).toBe(2);             // but counts each action
  });

  it('isolation: another task\'s needs_human action does not bleed across task_id', async () => {
    const attnTask = await makeTask('attn-iso-attn', 'in_progress');
    const cleanTask = await makeTask('attn-iso-clean', 'in_progress');
    await makeAction(attnTask, 'needs_human');
    await makeAction(cleanTask, 'fired');
    const list = await listTasks();
    const a = list.find((x) => x.task_id === attnTask)!;
    const c = list.find((x) => x.task_id === cleanTask)!;
    expect(a.attention_reason).toEqual(['needs_human']);
    expect(c.attention_reason).toEqual([]); // clean task unaffected
  });
});

describe('#188① owner_display_name resolution (GET /workrooms/:id/tasks)', () => {
  it('owner_instance_id resolves to the agent display name (not the raw UUID)', async () => {
    const taskId = await makeTask('own-resolved', 'in_progress'); // makeTask sets owner = AGENT_ID
    const t = (await listTasks()).find((x) => x.task_id === taskId)!;
    expect(t.owner_instance_id).toBe(AGENT_ID);
    expect(t.owner_display_name).toBe('Attn Agent'); // ControlAgent.displayName, never the id
    expect(t.owner_display_name).not.toBe(AGENT_ID);
  });

  // Note: ownerInstanceId has an FK → ControlAgent and ControlAgent.displayName is required, so a
  // non-null owner always resolves to a name; owner_display_name is null only for an unowned task.
  // The `?? null` in the route is defense-in-depth (e.g. future onDelete=SetNull races).

  it('unowned task -> owner_display_name null', async () => {
    const id = randomUUID();
    await db.controlTask.create({ data: { id, workroomId: WORKROOM_ID, title: 'own-none', status: 'todo', ownerInstanceId: null } });
    const t = (await listTasks()).find((x) => x.task_id === id)!;
    expect(t.owner_instance_id).toBeNull();
    expect(t.owner_display_name).toBeNull();
  });
});
