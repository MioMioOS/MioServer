/**
 * A5 — Agent API task routes integration tests.
 *
 * Endpoints under test (all behind authorizeAgentApi + resolveAgentChannelTarget):
 *   GET  /internal/agent-api/tasks/list?channel=#name
 *   POST /internal/agent-api/tasks/create  { channel, title | titles }
 *   POST /internal/agent-api/tasks/claim   { channel, number }
 *   POST /internal/agent-api/tasks/unclaim { channel, number }
 *   POST /internal/agent-api/tasks/update-status { channel, number, status }
 *
 * Required cases:
 *   - create → row + number + 📋 message emitted
 *   - claim happy + self-idempotent + other agent → 409
 *   - update-status legal + illegal (400 INVALID_TASK_TRANSITION)
 *   - list returns seeded tasks
 *   - not-a-member → 404
 *   - agent not owner on unclaim → 403
 *   - unknown #number → 404 TASK_NOT_FOUND
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/agentApi/agentApiTasks.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentApiTasks } from './agentApiTasks';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();        // owned by MACHINE_ID, member of CHANNEL_ID
const OTHER_AGENT_ID = randomUUID(); // owned by OTHER_MACHINE_ID (for ownership tests)

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let CHANNEL_ID = '';      // #sim channel — AGENT_ID is a member
let OTHER_CHANNEL_ID = ''; // a channel AGENT_ID is NOT a member of

let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ────────────────────────────────────────────────────────────────────

function headers(machineToken = MACHINE_RAW_TOKEN, agentId = AGENT_ID) {
  return {
    authorization: `Bearer ${machineToken}`,
    'x-mio-agent-id': agentId,
    'content-type': 'application/json',
  };
}

function get(url: string, h = headers()) {
  return APP.inject({ method: 'GET', url, headers: h });
}

function post(url: string, body: Record<string, unknown>, h = headers()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: h,
    payload: JSON.stringify(body),
  });
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentApiTasks);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  // Org
  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'AgentApiTasks Org',
      slug: `agent-api-tasks-${randomUUID()}`,
      ownerUserId: randomUUID(),
    },
  });

  // Machines
  await db.controlMachine.create({
    data: {
      id: MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(MACHINE_RAW_TOKEN),
      tokenExpiresAt,
      platform: 'darwin',
      arch: 'arm64',
    },
  });
  await db.controlMachine.create({
    data: {
      id: OTHER_MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN),
      tokenExpiresAt,
      platform: 'darwin',
      arch: 'arm64',
    },
  });

  // Workroom
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentApiTasks WR', createdBy: randomUUID() },
  });

  // Agents
  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'TaskTestAgent',
      displayName: 'TaskTestAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });
  await db.controlAgent.create({
    data: {
      id: OTHER_AGENT_ID,
      orgId: ORG_ID,
      machineId: OTHER_MACHINE_ID,
      name: 'OtherTaskAgent',
      displayName: 'OtherTaskAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // #sim channel — AGENT_ID is a member
  const ch = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'sim',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  CHANNEL_ID = ch.id;
  await db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId: AGENT_ID } });

  // Non-member channel (AGENT_ID has no row)
  const otherCh = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'no-member-tasks',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  OTHER_CHANNEL_ID = otherCh.id;
});

afterAll(async () => {
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── POST /internal/agent-api/tasks/create ─────────────────────────────────────

describe('POST /internal/agent-api/tasks/create', () => {
  it('single title: creates task with status todo, allocates number, emits 📋 message', async () => {
    const res = await post('/internal/agent-api/tasks/create', {
      channel: '#sim',
      title: 'First task',
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('tasks');
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBe(1);

    const t = body.tasks[0];
    expect(t).toHaveProperty('id');
    expect(t).toHaveProperty('number');
    expect(typeof t.number).toBe('number');
    expect(t.number).toBeGreaterThan(0);
    expect(t.creator_instance_id).toBe(AGENT_ID);
    expect(t.creator_display_name).toBe('TaskTestAgent');
    expect(typeof t.created_at).toBe('string');

    // Verify DB row
    const stored = await db.controlTask.findUnique({
      where: { id: t.id },
      select: { status: true, channelId: true, number: true, title: true },
    });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('todo');
    expect(stored!.channelId).toBe(CHANNEL_ID);
    expect(stored!.number).toBe(t.number);
    expect(stored!.title).toBe('First task');

    // Verify 📋 system message emitted
    const msg = await db.controlMessage.findFirst({
      where: { channelId: CHANNEL_ID, senderKind: 'system' },
      orderBy: { createdAt: 'desc' },
    });
    expect(msg).not.toBeNull();
    expect(msg!.content).toContain('📋');
    expect(msg!.content).toContain(`#${t.number}`);
    expect(msg!.content).toContain('First task');
  });

  it('single title: task list exposes creator, owner, and created_at for reports/UI', async () => {
    const createRes = await post('/internal/agent-api/tasks/create', {
      channel: '#sim',
      title: 'Creator fields task',
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body).tasks[0];

    const listRes = await get('/internal/agent-api/tasks/list?channel=%23sim');
    expect(listRes.statusCode).toBe(200);
    const listed = JSON.parse(listRes.body).tasks.find((t: { id: string }) => t.id === created.id);
    expect(listed).toBeTruthy();
    expect(listed.creator_instance_id).toBe(AGENT_ID);
    expect(listed.creator_display_name).toBe('TaskTestAgent');
    expect(listed.owner_instance_id).toBeNull();
    expect(listed.owner_display_name).toBeNull();
    expect(typeof listed.created_at).toBe('string');
  });

  it('titles array: creates multiple tasks, allocates sequential numbers, emits 📋 message', async () => {
    const res = await post('/internal/agent-api/tasks/create', {
      channel: '#sim',
      titles: ['Batch A', 'Batch B', 'Batch C'],
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.tasks.length).toBe(3);

    // Numbers should be distinct and all > 0
    const numbers = body.tasks.map((t: { number: number }) => t.number) as number[];
    const uniqueNumbers = new Set(numbers);
    expect(uniqueNumbers.size).toBe(3);
    for (const n of numbers) {
      expect(typeof n).toBe('number');
      expect(n).toBeGreaterThan(0);
    }

    // Bridge message should reference multiple tasks
    const msg = await db.controlMessage.findFirst({
      where: { channelId: CHANNEL_ID, senderKind: 'system' },
      orderBy: { createdAt: 'desc' },
    });
    expect(msg).not.toBeNull();
    expect(msg!.content).toContain('📋');
    expect(msg!.content).toContain('3');
  });

  it('not-a-member channel → 404 NOT_A_MEMBER', async () => {
    const res = await post('/internal/agent-api/tasks/create', {
      channel: '#no-member-tasks',
      title: 'Should fail',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it('missing title and titles → 400 INVALID_BODY', async () => {
    const res = await post('/internal/agent-api/tasks/create', { channel: '#sim' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_BODY');
  });

  it('missing channel → 400 INVALID_BODY', async () => {
    const res = await post('/internal/agent-api/tasks/create', { title: 'No channel' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_BODY');
  });

  it('both title and titles provided → 400 INVALID_BODY (mutually exclusive)', async () => {
    const res = await post('/internal/agent-api/tasks/create', {
      channel: '#sim',
      title: 'Single',
      titles: ['Array A', 'Array B'],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_BODY');
  });
});

// ── GET /internal/agent-api/tasks/list ────────────────────────────────────────

describe('GET /internal/agent-api/tasks/list', () => {
  it('returns seeded tasks for the channel', async () => {
    // Seed a task directly so we know it's there
    await db.controlTask.create({
      data: { workroomId: WORKROOM_ID, channelId: CHANNEL_ID, title: 'list-test-task', status: 'todo' },
    });

    const res = await get('/internal/agent-api/tasks/list?channel=%23sim');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('tasks');
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBeGreaterThan(0);

    // All tasks should have the expected fields
    const t = body.tasks[0];
    expect(t).toHaveProperty('id');
    expect(t).toHaveProperty('title');
    expect(t).toHaveProperty('status');
    expect(t).toHaveProperty('assignee_id');
    expect(t).toHaveProperty('owner_instance_id');
    expect(t).toHaveProperty('owner_display_name');
    expect(t).toHaveProperty('creator_instance_id');
    expect(t).toHaveProperty('creator_display_name');
    expect(t).toHaveProperty('created_at');
    // number may be null for tasks created without nextChannelTaskNumber
    expect(t).toHaveProperty('number');
  });

  it('not-a-member channel → 404 NOT_A_MEMBER', async () => {
    const res = await get('/internal/agent-api/tasks/list?channel=%23no-member-tasks');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it('missing channel param → 400 INVALID_QUERY', async () => {
    const res = await get('/internal/agent-api/tasks/list');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_QUERY');
  });
});

// ── POST /internal/agent-api/tasks/claim ──────────────────────────────────────

describe('POST /internal/agent-api/tasks/claim', () => {
  async function makeNumberedTask(status = 'todo', ownerInstanceId?: string): Promise<{ id: string; number: number }> {
    let task: { id: string; number: number | null };
    await db.$transaction(async (tx) => {
      const { nextChannelTaskNumber } = await import('@/control/tasks/nextChannelTaskNumber');
      const num = await nextChannelTaskNumber(tx, CHANNEL_ID);
      task = await tx.controlTask.create({
        data: {
          workroomId: WORKROOM_ID,
          channelId: CHANNEL_ID,
          title: `claim-test-${randomUUID()}`,
          status,
          number: num,
          ...(ownerInstanceId !== undefined ? { ownerInstanceId } : {}),
        },
        select: { id: true, number: true },
      });
    });
    return { id: task!.id, number: task!.number! };
  }

  it('happy path: claim unclaimed task → ok, status in_progress, ownerInstanceId = agent', async () => {
    const { number } = await makeNumberedTask('todo');

    const res = await post('/internal/agent-api/tasks/claim', {
      channel: '#sim',
      number,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);

    // Verify DB row
    const stored = await db.controlTask.findFirst({
      where: { channelId: CHANNEL_ID, number },
      select: { status: true, ownerInstanceId: true },
    });
    expect(stored!.status).toBe('in_progress');
    expect(stored!.ownerInstanceId).toBe(AGENT_ID);

    // The emitted bridge message must reflect the in_progress status (catches a regression
    // where the route's newStatus status-source decision silently emits the wrong status
    // even though the DB row is correct).
    const msg = await db.controlMessage.findFirst({
      where: { channelId: CHANNEL_ID, senderKind: 'system', content: { contains: `#${number}` } },
      orderBy: { createdAt: 'desc' },
    });
    expect(msg).not.toBeNull();
    expect(msg!.content).toContain('in_progress');
  });

  it('self-idempotent: claim a task already owned by this agent → 200 ok', async () => {
    const { number } = await makeNumberedTask('in_progress', AGENT_ID);

    const res = await post('/internal/agent-api/tasks/claim', {
      channel: '#sim',
      number,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it('task owned by other agent → 409 TASK_CLAIM_CONFLICT', async () => {
    const { number } = await makeNumberedTask('in_progress', OTHER_AGENT_ID);

    const res = await post('/internal/agent-api/tasks/claim', {
      channel: '#sim',
      number,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('TASK_CLAIM_CONFLICT');
  });

  it('unknown number → 404 TASK_NOT_FOUND', async () => {
    const res = await post('/internal/agent-api/tasks/claim', {
      channel: '#sim',
      number: 999999,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('TASK_NOT_FOUND');
  });

  it('not-a-member channel → 404 NOT_A_MEMBER', async () => {
    const res = await post('/internal/agent-api/tasks/claim', {
      channel: '#no-member-tasks',
      number: 1,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it('Fix A: claim emits a task.updated event row with IN_PROGRESS payload', async () => {
    const { id, number } = await makeNumberedTask('todo');
    const res = await post('/internal/agent-api/tasks/claim', { channel: '#sim', number });
    expect(res.statusCode).toBe(200);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'task.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.task_id).toBe(id);
    expect(payload.status).toBe('IN_PROGRESS');   // Slock vocab on the wire
    expect(payload.assignee_id).toBe(AGENT_ID);
  });
});

// ── POST /internal/agent-api/tasks/unclaim ────────────────────────────────────

describe('POST /internal/agent-api/tasks/unclaim', () => {
  async function makeNumberedTask(status: string, ownerInstanceId?: string): Promise<{ id: string; number: number }> {
    let task: { id: string; number: number | null };
    await db.$transaction(async (tx) => {
      const { nextChannelTaskNumber } = await import('@/control/tasks/nextChannelTaskNumber');
      const num = await nextChannelTaskNumber(tx, CHANNEL_ID);
      task = await tx.controlTask.create({
        data: {
          workroomId: WORKROOM_ID,
          channelId: CHANNEL_ID,
          title: `unclaim-test-${randomUUID()}`,
          status,
          number: num,
          ...(ownerInstanceId !== undefined ? { ownerInstanceId } : {}),
        },
        select: { id: true, number: true },
      });
    });
    return { id: task!.id, number: task!.number! };
  }

  it('owner unclaims own task → 200, ownerInstanceId cleared, status back to todo', async () => {
    const { number } = await makeNumberedTask('in_progress', AGENT_ID);

    const res = await post('/internal/agent-api/tasks/unclaim', {
      channel: '#sim',
      number,
    });

    expect(res.statusCode).toBe(200);

    const stored = await db.controlTask.findFirst({
      where: { channelId: CHANNEL_ID, number },
      select: { status: true, ownerInstanceId: true },
    });
    expect(stored!.ownerInstanceId).toBeNull();
    expect(stored!.status).toBe('todo');
  });

  it('agent not owner → 403 UNCLAIM_FORBIDDEN', async () => {
    // task owned by OTHER_AGENT_ID; AGENT_ID tries to unclaim
    const { number } = await makeNumberedTask('in_progress', OTHER_AGENT_ID);

    const res = await post('/internal/agent-api/tasks/unclaim', {
      channel: '#sim',
      number,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('UNCLAIM_FORBIDDEN');
  });

  it('unknown number → 404 TASK_NOT_FOUND', async () => {
    const res = await post('/internal/agent-api/tasks/unclaim', {
      channel: '#sim',
      number: 999998,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('TASK_NOT_FOUND');
  });
});

// ── POST /internal/agent-api/tasks/update-status ──────────────────────────────

describe('POST /internal/agent-api/tasks/update-status', () => {
  async function makeNumberedTask(status: string, ownerInstanceId?: string): Promise<{ id: string; number: number }> {
    let task: { id: string; number: number | null };
    await db.$transaction(async (tx) => {
      const { nextChannelTaskNumber } = await import('@/control/tasks/nextChannelTaskNumber');
      const num = await nextChannelTaskNumber(tx, CHANNEL_ID);
      task = await tx.controlTask.create({
        data: {
          workroomId: WORKROOM_ID,
          channelId: CHANNEL_ID,
          title: `status-test-${randomUUID()}`,
          status,
          number: num,
          ...(ownerInstanceId !== undefined ? { ownerInstanceId } : {}),
        },
        select: { id: true, number: true },
      });
    });
    return { id: task!.id, number: task!.number! };
  }

  it('legal transition todo → in_progress: 200, status updated, bridge message emitted', async () => {
    const { id, number } = await makeNumberedTask('todo');

    const res = await post('/internal/agent-api/tasks/update-status', {
      channel: '#sim',
      number,
      status: 'in_progress',
    });

    expect(res.statusCode).toBe(200);

    const stored = await db.controlTask.findUnique({
      where: { id },
      select: { status: true },
    });
    expect(stored!.status).toBe('in_progress');

    // Bridge message emitted: "task #N → in_progress"
    const msg = await db.controlMessage.findFirst({
      where: { channelId: CHANNEL_ID, senderKind: 'system', content: { contains: `#${number}` } },
      orderBy: { createdAt: 'desc' },
    });
    expect(msg).not.toBeNull();
    expect(msg!.content).toContain('in_progress');
  });

  it('legal transition in_progress → done: 200', async () => {
    const { number } = await makeNumberedTask('in_progress');

    const res = await post('/internal/agent-api/tasks/update-status', {
      channel: '#sim',
      number,
      status: 'done',
    });

    expect(res.statusCode).toBe(200);
  });

  it('illegal transition (done → in_progress) → 400 INVALID_TASK_TRANSITION', async () => {
    const { number } = await makeNumberedTask('done');

    const res = await post('/internal/agent-api/tasks/update-status', {
      channel: '#sim',
      number,
      status: 'in_progress',
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_TASK_TRANSITION');
  });

  it('illegal transition (todo → done) → 400 INVALID_TASK_TRANSITION', async () => {
    const { number } = await makeNumberedTask('todo');

    const res = await post('/internal/agent-api/tasks/update-status', {
      channel: '#sim',
      number,
      status: 'done',
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_TASK_TRANSITION');
  });

  it('unknown number → 404 TASK_NOT_FOUND', async () => {
    const res = await post('/internal/agent-api/tasks/update-status', {
      channel: '#sim',
      number: 999997,
      status: 'in_progress',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('TASK_NOT_FOUND');
  });

  it('not-a-member channel → 404 NOT_A_MEMBER', async () => {
    const res = await post('/internal/agent-api/tasks/update-status', {
      channel: '#no-member-tasks',
      number: 1,
      status: 'in_progress',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it('Fix A: update-status emits a task.updated event row with translated status', async () => {
    // Seed with a real ownerInstanceId so the task.ownerInstanceId → assignee_id wiring
    // is exercised against a concrete value (not just null).
    const { id, number } = await makeNumberedTask('in_progress', AGENT_ID);
    const res = await post('/internal/agent-api/tasks/update-status', { channel: '#sim', number, status: 'done' });
    expect(res.statusCode).toBe(200);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'task.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.task_id).toBe(id);
    expect(payload.channel_id).toBe(CHANNEL_ID);
    expect(payload.status).toBe('DONE');
    expect(payload).toHaveProperty('assignee_id');
    expect(payload.assignee_id).toBe(AGENT_ID);
  });

  // ── P3 reviewer-gate ───────────────────────────────────────────────────────
  describe('P3 reviewer-gate (update-status divert + /tasks/review)', () => {
    // Fresh channel per test, with BOTH agents as members so an independent
    // reviewer exists (the seed's #sim only has AGENT_ID).
    async function makeReviewerChannel(withOther: boolean): Promise<{ id: string; name: string }> {
      const name = `rev-${randomUUID().slice(0, 8)}`;
      const ch = await db.controlChannel.create({
        data: { workroomId: WORKROOM_ID, name, type: 'standard', visibility: 'private', createdBy: 'system' },
      });
      await db.controlChannelMember.create({ data: { channelId: ch.id, memberId: AGENT_ID } });
      if (withOther) await db.controlChannelMember.create({ data: { channelId: ch.id, memberId: OTHER_AGENT_ID } });
      // REGRESSION GUARD: every real channel has a HUMAN member whose member_id is
      // a cuid (NOT a uuid). resolveTaskReviewer must filter these out before the
      // ControlAgent uuid query — otherwise Postgres rejects the cast and the whole
      // update-status throws (the live-e2e bug). Adding it here means the divert
      // test below exercises the realistic mixed-membership case.
      await db.controlChannelMember.create({ data: { channelId: ch.id, memberId: 'cmtesthuman0000wklz9tlxh0rn' } });
      return { id: ch.id, name: `#${name}` };
    }
    async function makeTask(channelId: string, status: string, reviewRound = 0) {
      return db.controlTask.create({
        data: {
          workroomId: WORKROOM_ID, channelId, number: 1, title: 'P3 deliverable',
          status, ownerInstanceId: AGENT_ID, reviewRound,
        },
      });
    }

    it('owner done WITH an independent reviewer → diverted to in_review (+ reviewRound 0→1, review_requested event)', async () => {
      const ch = await makeReviewerChannel(true);
      const task = await makeTask(ch.id, 'in_progress');

      const res = await post('/internal/agent-api/tasks/update-status', { channel: ch.name, number: 1, status: 'done' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.diverted_to_review).toBe(true);
      expect(body.status).toBe('IN_REVIEW');

      const after = await db.controlTask.findUnique({ where: { id: task.id } });
      expect(after?.status).toBe('in_review');
      expect(after?.reviewRound).toBe(1);

      const ev = await db.controlEventLog.findFirst({ where: { workroomId: WORKROOM_ID, topic: 'task.review_requested' }, orderBy: { createdAt: 'desc' } });
      expect(ev).toBeTruthy();
      expect((ev?.payloadJson as Record<string, unknown>)?.reviewer_id).toBe(OTHER_AGENT_ID);
    });

    it('owner done with NO other agent member → closes immediately (graceful fall-through)', async () => {
      const ch = await makeReviewerChannel(false);
      const task = await makeTask(ch.id, 'in_progress');

      const res = await post('/internal/agent-api/tasks/update-status', { channel: ch.name, number: 1, status: 'done' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.diverted_to_review).toBe(false);
      expect(body.status).toBe('DONE');
      expect((await db.controlTask.findUnique({ where: { id: task.id } }))?.status).toBe('done');
    });

    it('bounce cap: a re-submit at reviewRound>=MAX closes WITHOUT a second divert (even with reviewer present)', async () => {
      const ch = await makeReviewerChannel(true);
      const task = await makeTask(ch.id, 'in_progress', 1); // already bounced once

      const res = await post('/internal/agent-api/tasks/update-status', { channel: ch.name, number: 1, status: 'done' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).diverted_to_review).toBe(false);
      expect((await db.controlTask.findUnique({ where: { id: task.id } }))?.status).toBe('done');
    });

    it('reviewer --pass on an in_review task → done', async () => {
      const ch = await makeReviewerChannel(true);
      const task = await makeTask(ch.id, 'in_review', 1);

      // OTHER_AGENT_ID is the independent reviewer (member of the channel, not the owner).
      const res = await post('/internal/agent-api/tasks/review',
        { channel: ch.name, number: 1, verdict: 'pass' },
        headers(OTHER_MACHINE_RAW_TOKEN, OTHER_AGENT_ID));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('DONE');
      expect((await db.controlTask.findUnique({ where: { id: task.id } }))?.status).toBe('done');
    });

    it('reviewer --bounce on an in_review task → back to in_progress', async () => {
      const ch = await makeReviewerChannel(true);
      const task = await makeTask(ch.id, 'in_review', 1);

      const res = await post('/internal/agent-api/tasks/review',
        { channel: ch.name, number: 1, verdict: 'bounce', feedback: 'unary-minus has no test' },
        headers(OTHER_MACHINE_RAW_TOKEN, OTHER_AGENT_ID));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('IN_PROGRESS');
      expect((await db.controlTask.findUnique({ where: { id: task.id } }))?.status).toBe('in_progress');
    });

    it('owner CANNOT review their own task (self-pass blocked) → 403', async () => {
      const ch = await makeReviewerChannel(true);
      await makeTask(ch.id, 'in_review', 1);

      // AGENT_ID owns the task; trying to review it themselves must be rejected.
      const res = await post('/internal/agent-api/tasks/review', { channel: ch.name, number: 1, verdict: 'pass' });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('CANNOT_REVIEW_OWN_TASK');
    });

    it('review on a task that is NOT in_review → 409', async () => {
      const ch = await makeReviewerChannel(true);
      await makeTask(ch.id, 'in_progress', 0);

      const res = await post('/internal/agent-api/tasks/review',
        { channel: ch.name, number: 1, verdict: 'pass' },
        headers(OTHER_MACHINE_RAW_TOKEN, OTHER_AGENT_ID));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe('TASK_NOT_IN_REVIEW');
    });
  });
});
