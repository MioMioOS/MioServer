/**
 * Task lifecycle invariant regression test (Slice 5, Chunk A, Task 4).
 *
 * Asserts the §3 unified invariant: every task lifecycle transition (create / claim / status)
 * — whether triggered by operator OR agent — produces BOTH:
 *   (a) a `controlEventLog` row with the expected topic (`task.created` or `task.updated`)
 *       and a 4-field payload, AND
 *   (b) a `controlMessage` row in the channel with `senderKind='system'` containing the
 *       expected reference string.
 *
 * Invariant scope: create, claim, status.
 * Assignee change (PATCH assignee) is explicitly OUT of scope — it emits a WS event but NOT a
 * system message. The §3 invariant text ("create / claim / status") does not include assignee;
 * assignee is not a status transition. This is documented, not a gap.
 *
 * This file registers BOTH route plugins (slockTaskRoutes for operator create/status,
 * agentApiTasks for agent claim) so all three transition kinds are exercised through
 * real handlers against real Postgres.
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/tasks/taskInvariant.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { slockTaskRoutes } from './slockTaskRoutes';
import { agentApiTasks } from '@/control/agentApi/agentApiTasks';
// Slice 7 — slockTaskRoutes operator-write paths are gated by user_sess_ + UserWorkroomMembership(owner),
// no longer op_sess_. We mint a user session below and seed the membership.
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();
const OPERATOR_SUBJECT_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let OPERATOR_USER_ID = '';
let OPERATOR_USER_TOKEN = ''; // user_sess_... raw token; operator-write auth header
let CHANNEL_ID = ''; // #sim channel — AGENT_ID is a member; operator routes use channel-id directly

let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Request helpers ────────────────────────────────────────────────────────────

/** Operator (Slice 7: user_sess_ workroom owner) auth header. */
const opSessHeader = () => ({ authorization: `Bearer ${OPERATOR_USER_TOKEN}` });

/** Agent (machine token + agent id) auth headers — for agentApi endpoints. */
const agentHeaders = () => ({
  authorization: `Bearer ${MACHINE_RAW_TOKEN}`,
  'x-mio-agent-id': AGENT_ID,
  'content-type': 'application/json',
});

/** Inject a request via the Fastify test app. */
function req(method: string, url: string, headers: Record<string, string>, body?: Record<string, unknown>) {
  return APP.inject({
    method: method as 'GET' | 'POST' | 'PATCH',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

/** Inject a POST to an agent-api endpoint. */
function post(url: string, body: Record<string, unknown>) {
  return APP.inject({
    method: 'POST',
    url,
    headers: agentHeaders(),
    payload: JSON.stringify(body),
  });
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(slockTaskRoutes);
  await APP.register(agentApiTasks);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  // Org
  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'TaskInvariant Org',
      slug: `task-invariant-${randomUUID()}`,
      ownerUserId: randomUUID(),
    },
  });

  // Machine (needed for operator auth + agent auth)
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

  // Workroom
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'TaskInvariant WR', createdBy: randomUUID() },
  });

  // Agent (owned by MACHINE_ID — agentApi auth requires machineId link)
  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'InvariantAgent',
      displayName: 'InvariantAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // #sim channel (name 'sim' — agentApi resolves '#sim') — AGENT_ID is a member
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

  // Slice 7: operator-write auth uses a user_sess_ token + UserWorkroomMembership(role='owner').
  // Mint a user, seed an owner membership for WORKROOM_ID, mint a session token.
  const opUser = await db.user.create({
    data: {
      email: `task-invariant-op-${randomUUID()}@example.test`,
      passwordHash: await hashPassword('p'),
    },
  });
  OPERATOR_USER_ID = opUser.id;
  await db.userWorkroomMembership.create({
    data: { userId: OPERATOR_USER_ID, workroomId: WORKROOM_ID, role: 'owner' },
  });
  OPERATOR_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: {
      userId: OPERATOR_USER_ID,
      tokenHash: hashUserSessionToken(OPERATOR_USER_TOKEN),
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    },
  });
  // Reference the historical operator subject id so the linter doesn't complain. The audit log's
  // operatorSubjectId is now the user id; OPERATOR_SUBJECT_ID is retained for traceability only.
  void OPERATOR_SUBJECT_ID;
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  // Slice 7: user_sess_ + membership rather than op_sess_. Cascades from user.
  await db.userSession.deleteMany({ where: { userId: OPERATOR_USER_ID } }).catch(() => {});
  await db.userWorkroomMembership.deleteMany({ where: { userId: OPERATOR_USER_ID } }).catch(() => {});
  await db.user.deleteMany({ where: { id: OPERATOR_USER_ID } }).catch(() => {});
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── Assertion helpers ──────────────────────────────────────────────────────────

/** Count `controlEventLog` rows for WORKROOM_ID with the given topic. */
async function eventCount(topic: string): Promise<number> {
  return db.controlEventLog.count({ where: { workroomId: WORKROOM_ID, topic } });
}

/** Return true if a `system` message in CHANNEL_ID contains `ref`. */
async function systemMsgContaining(ref: string): Promise<boolean> {
  const m = await db.controlMessage.findFirst({
    where: { channelId: CHANNEL_ID, senderKind: 'system', content: { contains: ref } },
  });
  return m !== null;
}

/** Seed a numbered task directly into the DB (bypasses routes; used for claim/status transitions). */
async function makeNumberedTask(status = 'todo', ownerInstanceId?: string): Promise<{ id: string; number: number }> {
  let task!: { id: string; number: number | null };
  await db.$transaction(async (tx) => {
    const { nextChannelTaskNumber } = await import('./nextChannelTaskNumber');
    const num = await nextChannelTaskNumber(tx, CHANNEL_ID);
    task = await tx.controlTask.create({
      data: {
        workroomId: WORKROOM_ID,
        channelId: CHANNEL_ID,
        title: `inv-task-${randomUUID().slice(0, 8)}`,
        status,
        number: num,
        ...(ownerInstanceId !== undefined ? { ownerInstanceId } : {}),
      },
      select: { id: true, number: true },
    });
  });
  return { id: task.id, number: task.number! };
}

// ── Invariant tests ────────────────────────────────────────────────────────────

describe('Task lifecycle invariant: every transition double-emits', () => {
  /**
   * Case 1: Operator CREATE
   * Transition: POST .../channels/:cid/tasks
   * Expects:
   *   (a) controlEventLog row with topic='task.created' and 4-field payload
   *   (b) controlMessage system message containing the 📋 emoji and task #number
   */
  it('CREATE (operator) → task.created event + 📋 system message', async () => {
    const before = await eventCount('task.created');
    const res = await req(
      'POST',
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/tasks`,
      opSessHeader(),
      { title: 'inv-create' },
    );
    expect(res.statusCode).toBe(201);
    const taskId = JSON.parse(res.body).id;

    // (a) WS event written
    expect(await eventCount('task.created')).toBe(before + 1);

    // Also verify 4-field payload shape
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'task.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.task_id).toBe(taskId);
    expect(payload).toHaveProperty('channel_id');
    expect(payload).toHaveProperty('status');
    expect(payload).toHaveProperty('assignee_id');

    // (b) System message exists for this task's number
    const stored = await db.controlTask.findUnique({ where: { id: taskId }, select: { number: true } });
    expect(stored!.number).not.toBeNull();
    expect(await systemMsgContaining(`#${stored!.number}`)).toBe(true);
  });

  /**
   * Case 2: Agent CLAIM
   * Transition: POST /internal/agent-api/tasks/claim
   * Expects:
   *   (a) controlEventLog row with topic='task.updated', payload.status='IN_PROGRESS' (Fix A)
   *   (b) controlMessage system message containing task #number (existing bridge)
   */
  it('CLAIM (agent) → task.updated event + status system message', async () => {
    const { id, number } = await makeNumberedTask('todo');
    const beforeEv = await eventCount('task.updated');

    const res = await post('/internal/agent-api/tasks/claim', { channel: '#sim', number });
    expect(res.statusCode).toBe(200);

    // (a) WS event written
    expect(await eventCount('task.updated')).toBe(beforeEv + 1);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'task.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.task_id).toBe(id);
    expect(payload.status).toBe('IN_PROGRESS'); // Slock vocab on the wire
    expect(payload.assignee_id).toBe(AGENT_ID);
    expect(payload).toHaveProperty('channel_id');

    // (b) System message exists
    expect(await systemMsgContaining(`#${number}`)).toBe(true);
  });

  /**
   * Case 3: Operator STATUS change
   * Transition: PATCH .../tasks/:id/status
   * Expects:
   *   (a) controlEventLog row with topic='task.updated' (existing WS path)
   *   (b) controlMessage system message containing task #number (Fix B)
   */
  it('STATUS (operator) → task.updated event + status system message', async () => {
    const { id, number } = await makeNumberedTask('todo');
    const beforeEv = await eventCount('task.updated');

    const res = await req(
      'PATCH',
      `/api/v1/workrooms/${WORKROOM_ID}/tasks/${id}/status`,
      opSessHeader(),
      { status: 'IN_PROGRESS' },
    );
    expect(res.statusCode).toBe(200);

    // (a) WS event written
    expect(await eventCount('task.updated')).toBe(beforeEv + 1);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'task.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const eventPayload = event!.payloadJson as Record<string, unknown>;
    expect(eventPayload.task_id).toBe(id);
    expect(eventPayload).toHaveProperty('channel_id');
    // Pin the server→Slock-vocab translation on the operator status path. Without this
    // exact-value assertion, a silent regression (e.g. emitting server 'in_progress' instead
    // of Slock 'IN_PROGRESS') would slip through `toHaveProperty('status')`.
    expect(eventPayload.status).toBe('IN_PROGRESS');
    expect(eventPayload).toHaveProperty('assignee_id');

    // (b) System message exists
    expect(await systemMsgContaining(`#${number}`)).toBe(true);
  });

  /**
   * Case 4: Agent UPDATE-STATUS
   * Transition: POST /internal/agent-api/tasks/update-status
   * Expects:
   *   (a) controlEventLog row with topic='task.updated' and translated Slock-vocab status (Fix A)
   *   (b) controlMessage system message containing task #number (existing bridge)
   */
  it('UPDATE-STATUS (agent) → task.updated event + status system message', async () => {
    const { id, number } = await makeNumberedTask('in_progress', AGENT_ID);
    const beforeEv = await eventCount('task.updated');

    const res = await post('/internal/agent-api/tasks/update-status', {
      channel: '#sim',
      number,
      status: 'done',
    });
    expect(res.statusCode).toBe(200);

    // (a) WS event written
    expect(await eventCount('task.updated')).toBe(beforeEv + 1);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'task.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.task_id).toBe(id);
    expect(payload.status).toBe('DONE'); // Slock vocab
    expect(payload).toHaveProperty('channel_id');
    expect(payload).toHaveProperty('assignee_id');

    // (b) System message exists
    expect(await systemMsgContaining(`#${number}`)).toBe(true);
  });
});

/*
 * NOTE — Assignee change is intentionally NOT in this invariant test.
 *
 * PATCH /api/v1/workrooms/:wid/tasks/:id/assignee emits a WS `task.updated` event (present in
 * slockTaskRoutes.ts), but does NOT emit a channel system message. The §3 unified invariant
 * text scopes to "create / claim / status-change" transitions. Assignee is NOT a status
 * transition: it changes ownership metadata, not the task's lifecycle state. The existing
 * taskMessageBridge.ts has no `kind:'assignee'` variant, and extending the invariant to
 * assignee is explicitly out of scope for this task.
 *
 * Therefore: for assignee, only (a) WS event is required; (b) system message is NOT expected.
 * This is the correct behavior, not a bug.
 */
