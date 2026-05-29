/**
 * S2 "Create Agent" — GET /workrooms/:wid/computers + POST /workrooms/:wid/agents
 * (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Slice 7 B2-b auth conversion:
 *   - GET /computers: user_sess_ (workroom member) OR machine_token. Inline resolver
 *     preserves 401/403/404 status-code matrix (cross-org → 403, missing workroom → 404).
 *   - POST /agents: user_sess_ (workroom OWNER) OR machine_token (authorizeAgentWrite).
 *
 * FAST MODE — only meaningful tests:
 *   GET /computers:
 *     - machine_token (org match) → 200, only the org's machines, name + status derived
 *     - online window: recent lastSeenAt → 'online'; stale/null → 'offline'
 *     - user_sess_ workroom member → 200; user_sess_ non-member → 403
 *     - cross-org machine → 403; non-existent workroom → 404; no token → 401
 *   POST /agents:
 *     - user-owner → 201, full wire shape, status 'offline' (not running yet)
 *     - machine_token → 201
 *     - stores model + runtime + env (capabilities.env) and appears in GET /members
 *     - MANY agents per machine: two creates on the SAME machine both 201 (no 409) — the
 *       one-agent-per-machine unique was dropped for the "Create Agent" feature.
 *     - user non-member → 403; no token → 401
 *     - empty name → 400; machine not in org → 404
 *     - publishes 'agent.created' event
 *     - runtime/model defaults (runtime='claude', model=null) when omitted
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentRoutes } from './agentRoutes';
import { memberRoutes } from '@/control/members/memberRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();        // belongs to ORG_ID
const OTHER_WORKROOM_ID = randomUUID();  // belongs to OTHER_ORG_ID

// Machines in ORG_ID
const MACHINE_ONLINE_ID = randomUUID();  // recent lastSeenAt → online, has displayName
const MACHINE_STALE_ID = randomUUID();   // stale lastSeenAt → offline
const MACHINE_NEVER_ID = randomUUID();   // null lastSeenAt → offline, no displayName
// Machine in OTHER_ORG_ID (must NOT leak / used for create-404)
const OTHER_MACHINE_ID = randomUUID();

// Dedicated ORG_ID machines for the POST tests.
const MACHINE_CREATE_USER = randomUUID();
const MACHINE_CREATE_ENV = randomUUID();
const MACHINE_CREATE_MACHINE = randomUUID();
const MACHINE_CREATE_EVENT = randomUUID();
const MACHINE_CREATE_MULTI = randomUUID(); // two agents created on THIS one machine
const MACHINE_CREATE_REASONING = randomUUID();
const POST_ONLY_MACHINE_IDS = [MACHINE_CREATE_USER, MACHINE_CREATE_ENV, MACHINE_CREATE_MACHINE, MACHINE_CREATE_EVENT, MACHINE_CREATE_MULTI, MACHINE_CREATE_REASONING];

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;       // bound to ORG_ID (MACHINE_ONLINE_ID)
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`; // bound to OTHER_ORG_ID

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const otherMachineHeader = () => ({ authorization: `Bearer ${OTHER_MACHINE_RAW_TOKEN}` });

function get(url: string, headers: Record<string, string> = machineHeader()) {
  return APP.inject({ method: 'GET', url, headers });
}
function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = ownerUserHeader()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentRoutes);
  await APP.register(memberRoutes);
  await APP.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'Agents Org', slug: `agt-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlOrg.create({ data: { id: OTHER_ORG_ID, name: 'Agents OtherOrg', slug: `agt-other-${randomUUID()}`, ownerUserId: randomUUID() } });

  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Agents WR', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM_ID, orgId: OTHER_ORG_ID, name: 'Agents OtherWR', createdBy: randomUUID() } });

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  // ORG_ID machines. MACHINE_ONLINE carries the auth token + a displayName.
  await db.controlMachine.create({
    data: {
      id: MACHINE_ONLINE_ID, orgId: ORG_ID, displayName: "Laurent's MBP",
      tokenHash: sha256(MACHINE_RAW_TOKEN), tokenExpiresAt,
      platform: 'darwin', arch: 'arm64', lastSeenAt: new Date(),
    },
  });
  await db.controlMachine.create({
    data: {
      id: MACHINE_STALE_ID, orgId: ORG_ID, displayName: 'Stale Box',
      tokenHash: sha256(`machine_${randomUUID().replace(/-/g, '')}`), tokenExpiresAt,
      platform: 'linux', arch: 'x64', lastSeenAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago → offline
    },
  });
  await db.controlMachine.create({
    data: {
      id: MACHINE_NEVER_ID, orgId: ORG_ID, displayName: null,
      tokenHash: sha256(`machine_${randomUUID().replace(/-/g, '')}`), tokenExpiresAt,
      platform: 'darwin', arch: 'arm64', lastSeenAt: null, // never seen → offline + generated name
    },
  });
  await db.controlMachine.create({
    data: {
      id: OTHER_MACHINE_ID, orgId: OTHER_ORG_ID,
      tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN), tokenExpiresAt,
      platform: 'darwin', arch: 'arm64', lastSeenAt: new Date(),
    },
  });

  // Slice 7 user fixtures.
  const owner = await db.user.create({
    data: { email: `agt-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  OWNER_USER_ID = owner.id;
  OWNER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: OWNER_USER_ID, tokenHash: hashUserSessionToken(OWNER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.userWorkroomMembership.create({
    data: { userId: OWNER_USER_ID, workroomId: WORKROOM_ID, role: 'owner' },
  });

  const nm = await db.user.create({
    data: { email: `agt-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
});

afterAll(async () => {
  const wrIds = [WORKROOM_ID, OTHER_WORKROOM_ID];
  await db.controlEventLog.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlAgent.deleteMany({ where: { orgId: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ONLINE_ID, MACHINE_STALE_ID, MACHINE_NEVER_ID, OTHER_MACHINE_ID, ...POST_ONLY_MACHINE_IDS] } } });
  await db.user.deleteMany({ where: { id: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: wrIds } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await APP.close();
  await db.$disconnect();
});

// ── GET /api/v1/workrooms/:wid/computers ───────────────────────────────────────

describe('GET /api/v1/workrooms/:wid/computers', () => {
  it('machine_token (org match) → 200, only the org machines, name + status derived', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/computers`, machineHeader());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.computers.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([MACHINE_ONLINE_ID, MACHINE_STALE_ID, MACHINE_NEVER_ID].sort());
    expect(ids).not.toContain(OTHER_MACHINE_ID);

    const online = body.computers.find((c: { id: string }) => c.id === MACHINE_ONLINE_ID);
    expect(online.name).toBe("Laurent's MBP");
    expect(online.platform).toBe('darwin');
    expect(online.arch).toBe('arm64');
    expect(online.status).toBe('online');
  });

  it('online window: stale lastSeenAt → offline; null lastSeenAt → offline + generated name', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/computers`, machineHeader());
    const body = JSON.parse(res.body);

    const stale = body.computers.find((c: { id: string }) => c.id === MACHINE_STALE_ID);
    expect(stale.status).toBe('offline');

    const never = body.computers.find((c: { id: string }) => c.id === MACHINE_NEVER_ID);
    expect(never.status).toBe('offline');
    // No displayName → 'Machine ' + id.slice(0,6).
    expect(never.name).toBe(`Machine ${MACHINE_NEVER_ID.slice(0, 6)}`);
  });

  it('user_sess_ workroom member → 200', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/computers`, ownerUserHeader());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).computers.length).toBe(3);
  });

  it('user_sess_ non-member → 403', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/computers`, nonMemberUserHeader());
    expect(res.statusCode).toBe(403);
  });

  it('machine bound to ANOTHER org → 403 (cross-org)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/computers`, otherMachineHeader());
    expect(res.statusCode).toBe(403);
  });

  it('non-existent workroom → 404', async () => {
    const res = await get(`/api/v1/workrooms/${randomUUID()}/computers`, machineHeader());
    expect(res.statusCode).toBe(404);
  });

  it('no token → 401', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/computers`, {});
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /api/v1/workrooms/:wid/agents ─────────────────────────────────────────

describe('POST /api/v1/workrooms/:wid/agents', () => {
  beforeAll(async () => {
    // Dedicated machines for the 201-expecting creates.
    const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);
    await db.controlMachine.createMany({
      data: POST_ONLY_MACHINE_IDS.map((id) => ({
        id, orgId: ORG_ID,
        tokenHash: sha256(`machine_${id}`), tokenExpiresAt,
        platform: 'darwin', arch: 'arm64', lastSeenAt: null,
      })),
    });
  });

  it('user-owner create: 201, full wire shape, status offline (NOT running yet)', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_USER, name: 'Builder', description: 'builds things', runtime: 'codex', model: 'opus', env: { FOO: 'bar' } },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Same wire shape as a GET /members item + runtime + model.
    expect(body).toHaveProperty('id');
    expect(body.kind).toBe('agent');
    expect(body.display_name).toBe('Builder');
    expect(body.role).toBe('other');
    expect(body.machine_id).toBe(MACHINE_CREATE_USER);
    expect(body.runtime).toBe('codex');
    expect(body.model).toBe('opus');
    // Honest: the row exists but the agent is not running.
    expect(body.status).toBe('offline');
  });

  it('stores model + runtime + env (capabilities.env); appears in GET /members', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_ENV, name: 'EnvAgent', runtime: 'claude', model: 'sonnet', env: { KEY: 'VALUE', SECOND: 'two' } },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);

    // Persisted columns + capabilities.env.
    const row = await db.controlAgent.findUnique({
      where: { id: created.id },
      select: { runtime: true, model: true, capabilities: true, description: true, permissions: true, status: true },
    });
    expect(row!.runtime).toBe('claude');
    expect(row!.model).toBe('sonnet');
    expect(row!.status).toBe('offline');
    expect(row!.description).toBe('');
    expect((row!.capabilities as { env: Record<string, string> }).env).toEqual({ KEY: 'VALUE', SECOND: 'two' });

    // Appears in GET /members with runtime + model surfaced.
    const members = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`, machineHeader());
    expect(members.statusCode).toBe(200);
    const found = JSON.parse(members.body).members.find((m: { id: string }) => m.id === created.id);
    expect(found).toBeDefined();
    expect(found.display_name).toBe('EnvAgent');
    expect(found.runtime).toBe('claude');
    expect(found.model).toBe('sonnet');
    expect(found.machine_id).toBe(MACHINE_CREATE_ENV);
  });

  it('codex agent with reasoning_effort persists it in capabilities', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_REASONING, name: 'CodexThinker', runtime: 'codex', model: 'gpt-5.5', reasoning_effort: 'high', env: { A: '1' } },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);

    // reasoning_effort lives in capabilities (no schema change), alongside env.
    const row = await db.controlAgent.findUnique({
      where: { id: created.id },
      select: { runtime: true, model: true, capabilities: true },
    });
    expect(row!.runtime).toBe('codex');
    expect(row!.model).toBe('gpt-5.5');
    const caps = row!.capabilities as { env: Record<string, string>; reasoning_effort: string | null };
    expect(caps.reasoning_effort).toBe('high');
    expect(caps.env).toEqual({ A: '1' });
  });

  it('agent created WITHOUT reasoning_effort stores null (claude default)', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_USER, name: 'NoReasoning', runtime: 'claude', model: 'opus' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);
    const row = await db.controlAgent.findUnique({
      where: { id: created.id },
      select: { capabilities: true },
    });
    const caps = row!.capabilities as { env: Record<string, string>; reasoning_effort: string | null };
    expect(caps.reasoning_effort).toBeNull();
  });

  it('machine_token create → 201', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_MACHINE, name: 'MachineMade' },
      machineHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // Defaults: runtime 'claude', model null when omitted.
    expect(body.runtime).toBe('claude');
    expect(body.model).toBeNull();
    expect(body.machine_id).toBe(MACHINE_CREATE_MACHINE);
  });

  it('MANY agents per machine: two creates on the SAME machine both 201 (no 409)', async () => {
    // The one-agent-per-machine unique was dropped. Creating a SECOND agent on a machine
    // that already has one must succeed (201), NOT collide with the old AGENT_EXISTS_FOR_MACHINE 409.
    const first = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_MULTI, name: 'Agent One', runtime: 'claude', model: 'opus' },
      ownerUserHeader(),
    );
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body);

    const second = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_MULTI, name: 'Agent Two', runtime: 'codex', model: 'sonnet' },
      ownerUserHeader(),
    );
    expect(second.statusCode).toBe(201); // NOT 409 — multiple agents per machine are allowed
    const secondBody = JSON.parse(second.body);

    // Two DISTINCT agents, both bound to the same machine.
    expect(secondBody.id).not.toBe(firstBody.id);
    expect(firstBody.machine_id).toBe(MACHINE_CREATE_MULTI);
    expect(secondBody.machine_id).toBe(MACHINE_CREATE_MULTI);

    // Both persisted for that one machine.
    const rows = await db.controlAgent.findMany({ where: { orgId: ORG_ID, machineId: MACHINE_CREATE_MULTI } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.displayName).sort()).toEqual(['Agent One', 'Agent Two']);

    // Both surface in GET /members (no row is hidden by a dedupe-by-machine bug).
    const members = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`, machineHeader());
    expect(members.statusCode).toBe(200);
    const ids = JSON.parse(members.body).members.map((m: { id: string }) => m.id);
    expect(ids).toContain(firstBody.id);
    expect(ids).toContain(secondBody.id);
  });

  it('empty name → 400', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_STALE_ID, name: '   ' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('machine not in workroom org → 404', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: OTHER_MACHINE_ID, name: 'CrossOrgAgent' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('non-existent machine → 404', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: randomUUID(), name: 'GhostMachineAgent' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('user non-member → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_STALE_ID, name: 'Denied' },
      nonMemberUserHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/agents`, { machine_id: MACHINE_STALE_ID, name: 'x' }, {});
    expect(res.statusCode).toBe(401);
  });

  it('publishes agent.created event', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/agents`,
      { machine_id: MACHINE_CREATE_EVENT, name: 'Evented', runtime: 'kimi', model: 'k2' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'agent.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.agent_id).toBe(body.id);
    expect(payload.machine_id).toBe(MACHINE_CREATE_EVENT);
    expect(payload.runtime).toBe('kimi');
    expect(payload.model).toBe('k2');
  });
});
