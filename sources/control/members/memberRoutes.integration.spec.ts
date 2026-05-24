/**
 * S2 Chunk 1 — GET /workrooms/:wid/members (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Covers S2 §4.1 (members = org ControlAgents):
 *   - machine_token (bound to the workroom's org) → 200 with the org's agents
 *   - dev_ctl_ (in scope) → 200
 *   - dev_ctl_ for a DIFFERENT workroom → 403 (workroom-scope, anti-enumeration)
 *   - machine bound to ANOTHER org → 403 (cross-org)
 *   - non-existent workroom → 404
 *   - no token → 401
 *   - wire shape: { members: [{ id, kind:'agent', display_name, role, status, machine_id }] }
 *   - org is derived from the workroom (not the token), and the result is scoped to that org.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { memberRoutes } from './memberRoutes';

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();        // belongs to ORG_ID
const OTHER_WORKROOM_ID = randomUUID();  // belongs to OTHER_ORG_ID

const MACHINE_ID = randomUUID();         // bound to ORG_ID
const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_ID = randomUUID();   // bound to OTHER_ORG_ID
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

const RAW_DEV = `dev_ctl_${randomUUID().replace(/-/g, '')}`; // scoped to WORKROOM_ID

// Agents in ORG_ID
const AGENT_ONLINE_ID = randomUUID();
const AGENT_OFFLINE_ID = randomUUID();
// Agent in OTHER_ORG_ID (must NOT leak into ORG_ID's members)
const OTHER_AGENT_ID = randomUUID();

let app: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const get = (url: string, token?: string) =>
  app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  app = fastify();
  await app.register(memberRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'Members Org', slug: `mem-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlOrg.create({ data: { id: OTHER_ORG_ID, name: 'Other Org', slug: `mem-other-${randomUUID()}`, ownerUserId: randomUUID() } });

  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Members WR', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM_ID, orgId: OTHER_ORG_ID, name: 'Other WR', createdBy: randomUUID() } });

  await db.controlMachine.create({
    data: {
      id: MACHINE_ID, orgId: ORG_ID, boundAt: new Date(),
      tokenHash: sha256(MACHINE_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin', arch: 'arm64',
    },
  });
  await db.controlMachine.create({
    data: {
      id: OTHER_MACHINE_ID, orgId: OTHER_ORG_ID, boundAt: new Date(),
      tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN), tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin', arch: 'arm64',
    },
  });

  // Agents in ORG_ID — one online (with machineId), one offline (no machineId).
  await db.controlAgent.create({
    data: {
      id: AGENT_ONLINE_ID, orgId: ORG_ID, machineId: MACHINE_ID,
      name: 'mio', displayName: 'Mio', role: 'ops', status: 'online',
    },
  });
  await db.controlAgent.create({
    data: {
      id: AGENT_OFFLINE_ID, orgId: ORG_ID, machineId: null,
      name: 'zelda', displayName: 'Zelda', role: 'engineer', status: 'offline',
    },
  });
  // Agent in OTHER_ORG_ID — must not appear in ORG_ID's members.
  await db.controlAgent.create({
    data: {
      id: OTHER_AGENT_ID, orgId: OTHER_ORG_ID, machineId: OTHER_MACHINE_ID,
      name: 'intruder', displayName: 'Intruder', role: 'other', status: 'online',
    },
  });

  await db.controlDevToken.create({
    data: { tokenHash: sha256(RAW_DEV), orgId: ORG_ID, workroomId: WORKROOM_ID, scope: 'read_only', expiresAt: new Date(Date.now() + 3600_000) },
  });
});

afterAll(async () => {
  await db.controlDevToken.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlAgent.deleteMany({ where: { orgId: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await app.close();
  await db.$disconnect();
});

describe('GET /api/v1/workrooms/:wid/members', () => {
  it('machine_token (org match) → 200 with the org agents, scoped to the workroom org', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`, MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = body.members.map((m: { id: string }) => m.id).sort();
    expect(ids).toEqual([AGENT_ONLINE_ID, AGENT_OFFLINE_ID].sort());
    // OTHER_ORG agent must NOT leak in.
    expect(ids).not.toContain(OTHER_AGENT_ID);
  });

  it('orders online agents first (§4.1) — online Mio before offline Zelda', async () => {
    // Regression: lexicographic status sort would put 'offline' < 'online' (Zelda first).
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`, MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.members[0].id).toBe(AGENT_ONLINE_ID);
    expect(body.members[0].status).toBe('online');
  });

  it('wire shape: { members: [{ id, kind:"agent", display_name, role, status, machine_id }] }', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`, MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const online = body.members.find((m: { id: string }) => m.id === AGENT_ONLINE_ID);
    expect(online).toBeDefined();
    expect(online.kind).toBe('agent');
    expect(online.display_name).toBe('Mio');
    expect(online.role).toBe('ops');
    expect(online.status).toBe('online');
    expect(online.machine_id).toBe(MACHINE_ID);

    const offline = body.members.find((m: { id: string }) => m.id === AGENT_OFFLINE_ID);
    expect(offline.display_name).toBe('Zelda');
    expect(offline.machine_id).toBeNull();
  });

  it('dev_ctl_ in scope → 200', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`, RAW_DEV);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.members.length).toBe(2);
  });

  it('dev_ctl_ for a DIFFERENT workroom → 403 (scope)', async () => {
    const res = await get(`/api/v1/workrooms/${OTHER_WORKROOM_ID}/members`, RAW_DEV);
    expect(res.statusCode).toBe(403);
  });

  it('machine bound to ANOTHER org → 403 (cross-org)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`, OTHER_MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(403);
  });

  it('non-existent workroom → 404', async () => {
    const res = await get(`/api/v1/workrooms/${randomUUID()}/members`, MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(404);
  });

  it('no token → 401', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/members`);
    expect(res.statusCode).toBe(401);
  });
});
