/**
 * Multi-agent attribution — machine-token sender posts AS a specific owned agent (REAL Postgres).
 *
 * A machine hosts MANY ControlAgent rows (the "Create Agent" feature). When a machine sends a
 * message/reply with an optional `agent_id` for an agent it OWNS, the message is stamped
 * senderKind='agent', senderId=<agent id> — so resolveSenderDisplayNames maps it to the
 * agent's name (e.g. "PM"). Without agent_id the legacy default (senderId = machine.id) holds.
 * agent_id for an agent owned by a DIFFERENT machine → 403 AGENT_NOT_OWNED.
 *
 * Covers POST /channels/:cid/messages AND POST /threads/:parentId/reply (machine path only).
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { messageRoutes } from './messageRoutes';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();

// Machine A authenticates and owns the "PM" agent.
const MACHINE_A_ID = randomUUID();
const MACHINE_A_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

// Machine B owns a different agent ("Engineer") — used for the not-owned (403) case.
const MACHINE_B_ID = randomUUID();
const MACHINE_B_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

// PM agent owned by machine A.
const PM_AGENT_ID = randomUUID();
const PM_AGENT_NAME = 'PM';
// Engineer agent owned by machine B (NOT machine A).
const ENG_AGENT_ID = randomUUID();

let PUBLIC_CHANNEL_ID = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const machineAHeader = () => ({ authorization: `Bearer ${MACHINE_A_RAW_TOKEN}` });

function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = machineAHeader()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

function get(url: string, headers: Record<string, string> = machineAHeader()) {
  return APP.inject({ method: 'GET', url, headers });
}

async function seedTopLevel(channelId: string, seq: number, content = `parent ${seq}`): Promise<string> {
  const id = randomUUID();
  await db.controlMessage.create({
    data: { id, workroomId: WORKROOM_ID, channelId, seq: BigInt(seq), senderKind: 'system', senderId: randomUUID(), content },
  });
  return id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'AgentAttrSpec Org', slug: `agent-attr-${randomUUID()}`, ownerUserId: randomUUID() },
  });

  await db.controlMachine.create({
    data: {
      id: MACHINE_A_ID, orgId: ORG_ID, boundAt: new Date(),
      tokenHash: sha256(MACHINE_A_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin', arch: 'arm64',
    },
  });
  await db.controlMachine.create({
    data: {
      id: MACHINE_B_ID, orgId: ORG_ID, boundAt: new Date(),
      tokenHash: sha256(MACHINE_B_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin', arch: 'arm64',
    },
  });

  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentAttrSpec WR', createdBy: randomUUID() },
  });

  const pubCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  PUBLIC_CHANNEL_ID = pubCh.id;

  // PM agent owned by machine A.
  await db.controlAgent.create({
    data: { id: PM_AGENT_ID, orgId: ORG_ID, machineId: MACHINE_A_ID, name: 'pm', displayName: PM_AGENT_NAME, role: 'pm', status: 'online' },
  });
  // Engineer agent owned by machine B (different owner).
  await db.controlAgent.create({
    data: { id: ENG_AGENT_ID, orgId: ORG_ID, machineId: MACHINE_B_ID, name: 'eng', displayName: 'Engineer', role: 'engineer', status: 'online' },
  });
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlThread.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── POST /channels/:cid/messages ───────────────────────────────────────────────

describe('POST /channels/:cid/messages — machine agent attribution', () => {
  it('machine + agent_id of an OWNED agent → senderKind agent, senderId=agent_id, display_name=PM', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'PM speaking', agent_id: PM_AGENT_ID },
      machineAHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.sender_kind).toBe('agent');
    expect(body.sender_id).toBe(PM_AGENT_ID);              // attributed to the agent, NOT the machine
    expect(body.sender_id).not.toBe(MACHINE_A_ID);
    expect(body.sender_display_name).toBe(PM_AGENT_NAME);  // resolves to "PM"

    // GET messages also shows the agent's name (resolveSenderDisplayNames id branch).
    const list = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?after_seq=0&limit=100`);
    const listBody = JSON.parse(list.body);
    const found = listBody.messages.find((m: { id: string }) => m.id === body.id);
    expect(found).toBeTruthy();
    expect(found.sender_kind).toBe('agent');
    expect(found.sender_id).toBe(PM_AGENT_ID);
    expect(found.sender_display_name).toBe(PM_AGENT_NAME);
  });

  it('machine + agent_id of an agent owned by a DIFFERENT machine → 403 AGENT_NOT_OWNED', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'impersonating engineer', agent_id: ENG_AGENT_ID },
      machineAHeader(), // machine A does NOT own ENG_AGENT_ID (machine B does)
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });

  it('machine + non-existent agent_id → 403 AGENT_NOT_OWNED', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'ghost agent', agent_id: randomUUID() },
      machineAHeader(),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });

  it('machine WITHOUT agent_id → unchanged legacy default (senderId = machine.id)', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'default machine send' },
      machineAHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.sender_kind).toBe('agent');
    expect(body.sender_id).toBe(MACHINE_A_ID); // legacy default — the machine's own id
  });
});

// ── POST /threads/:parentId/reply ──────────────────────────────────────────────

describe('POST /threads/:parentId/reply — machine agent attribution', () => {
  it('machine + agent_id of an OWNED agent → reply attributed to PM (senderId=agent_id, display_name=PM)', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 1000, 'parent for pm reply');

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`,
      { content: 'PM reply', agent_id: PM_AGENT_ID },
      machineAHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.parent_message_id).toBe(parentId);
    expect(body.sender_kind).toBe('agent');
    expect(body.sender_id).toBe(PM_AGENT_ID);
    expect(body.sender_display_name).toBe(PM_AGENT_NAME);

    // GET replies also shows the agent's name.
    const list = await get(`/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/replies?after_seq=0&limit=100`);
    const found = JSON.parse(list.body).messages.find((m: { id: string }) => m.id === body.id);
    expect(found).toBeTruthy();
    expect(found.sender_id).toBe(PM_AGENT_ID);
    expect(found.sender_display_name).toBe(PM_AGENT_NAME);

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlThread.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('machine + agent_id owned by a DIFFERENT machine → 403 AGENT_NOT_OWNED (no reply written)', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 1010, 'parent for not-owned reply');

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`,
      { content: 'impersonating engineer reply', agent_id: ENG_AGENT_ID },
      machineAHeader(),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');

    // No reply persisted and no thread bookkeeping.
    const replies = await db.controlMessage.findMany({ where: { parentMessageId: parentId } });
    expect(replies).toHaveLength(0);
    const thread = await db.controlThread.findUnique({ where: { parentMessageId: parentId } });
    expect(thread).toBeNull();

    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });

  it('machine reply WITHOUT agent_id → unchanged legacy default (senderId = machine.id)', async () => {
    const parentId = await seedTopLevel(PUBLIC_CHANNEL_ID, 1020, 'parent for default reply');

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/threads/${parentId}/reply`,
      { content: 'default machine reply' },
      machineAHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.sender_kind).toBe('agent');
    expect(body.sender_id).toBe(MACHINE_A_ID); // legacy default

    await db.controlMessage.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlThread.deleteMany({ where: { parentMessageId: parentId } });
    await db.controlMessage.deleteMany({ where: { id: parentId } });
  });
});
