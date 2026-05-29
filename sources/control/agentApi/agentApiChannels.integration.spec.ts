/**
 * A2 — Agent API channels route integration tests.
 *
 * Endpoint under test (behind authorizeAgentApi):
 *   GET /internal/agent-api/channels
 *     → the authenticated agent's member channels { channels: [{ id, name }] }
 *
 * Required cases:
 *   - returns exactly the agent's member channels (#frontend + #general),
 *     #backend (PUBLIC but not a member) is ABSENT → proves public ≠ auto-member
 *   - missing/blank X-Mio-Agent-Id → 403 AGENT_NOT_OWNED (authorizeAgentApi)
 *   - agent not owned by this machine → 403 AGENT_NOT_OWNED
 *   - invalid/missing machine token → 401 MACHINE_TOKEN_INVALID
 *   - agent with zero memberships → 200 { channels: [] }
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/agentApi/agentApiChannels.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentApiChannels } from './agentApiChannels';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();        // owned by MACHINE_ID, member of #frontend + #general
const OTHER_AGENT_ID = randomUUID(); // owned by OTHER_MACHINE_ID (for ownership tests)
const NO_MEMBER_AGENT_ID = randomUUID(); // owned by MACHINE_ID, zero memberships

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let FRONTEND_CHANNEL_ID = ''; // #frontend — AGENT_ID is a member
let GENERAL_CHANNEL_ID = '';  // #general — AGENT_ID is a member
let BACKEND_CHANNEL_ID = '';  // #backend — PUBLIC but AGENT_ID is NOT a member

let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ────────────────────────────────────────────────────────────────────

// Sentinel so callers can OMIT the X-Mio-Agent-Id header entirely. Passing
// `undefined` to a defaulted param would resolve to AGENT_ID, so we use a
// distinct OMIT marker to mean "do not set the header at all".
const OMIT = Symbol('omit-agent-id');

function headers(machineToken = MACHINE_RAW_TOKEN, agentId: string | typeof OMIT = AGENT_ID) {
  const h: Record<string, string> = {
    authorization: `Bearer ${machineToken}`,
    'content-type': 'application/json',
  };
  if (agentId !== OMIT) h['x-mio-agent-id'] = agentId;
  return h;
}

function get(url: string, h = headers()) {
  return APP.inject({ method: 'GET', url, headers: h });
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentApiChannels);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  // Org
  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'AgentApiChannels Org',
      slug: `agent-api-channels-${randomUUID()}`,
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentApiChannels WR', createdBy: randomUUID() },
  });

  // Agents
  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'ChannelsTestAgent',
      displayName: 'ChannelsTestAgent',
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
      name: 'OtherChannelsAgent',
      displayName: 'OtherChannelsAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });
  await db.controlAgent.create({
    data: {
      id: NO_MEMBER_AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'NoMemberChannelsAgent',
      displayName: 'NoMemberChannelsAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // #frontend — AGENT_ID is a member
  const frontend = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'frontend',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  FRONTEND_CHANNEL_ID = frontend.id;
  await db.controlChannelMember.create({ data: { channelId: FRONTEND_CHANNEL_ID, memberId: AGENT_ID } });

  // #general — AGENT_ID is a member
  const general = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'general',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  GENERAL_CHANNEL_ID = general.id;
  await db.controlChannelMember.create({ data: { channelId: GENERAL_CHANNEL_ID, memberId: AGENT_ID } });

  // #backend — PUBLIC but AGENT_ID is NOT a member (proves public ≠ auto-member)
  const backend = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'backend',
      type: 'standard',
      visibility: 'public',
      createdBy: 'system',
    },
  });
  BACKEND_CHANNEL_ID = backend.id;
});

afterAll(async () => {
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── GET /internal/agent-api/channels ───────────────────────────────────────────

describe('GET /internal/agent-api/channels', () => {
  it("returns exactly the agent's member channels (#frontend + #general); public-but-not-member #backend is absent", async () => {
    const res = await get('/internal/agent-api/channels');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('channels');
    expect(Array.isArray(body.channels)).toBe(true);

    const names = (body.channels as Array<{ id: string; name: string }>).map((c) => c.name).sort();
    expect(names).toEqual(['frontend', 'general']);

    // #backend is PUBLIC but the agent is not a member → must be absent
    expect(names).not.toContain('backend');

    // each channel carries id + name
    for (const c of body.channels as Array<{ id: string; name: string }>) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
    }

    // ids should match the seeded member channels
    const ids = (body.channels as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual([FRONTEND_CHANNEL_ID, GENERAL_CHANNEL_ID].sort());
    expect(ids).not.toContain(BACKEND_CHANNEL_ID);
  });

  it('agent with zero memberships → 200 { channels: [] }', async () => {
    const res = await get('/internal/agent-api/channels', headers(MACHINE_RAW_TOKEN, NO_MEMBER_AGENT_ID));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.channels).toEqual([]);
  });

  it('missing X-Mio-Agent-Id → 403 AGENT_NOT_OWNED', async () => {
    const res = await get('/internal/agent-api/channels', headers(MACHINE_RAW_TOKEN, OMIT));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });

  it('blank X-Mio-Agent-Id → 403 AGENT_NOT_OWNED', async () => {
    const res = await get('/internal/agent-api/channels', headers(MACHINE_RAW_TOKEN, ''));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });

  it('agent not owned by this machine → 403 AGENT_NOT_OWNED', async () => {
    // OTHER_AGENT_ID is owned by OTHER_MACHINE_ID, but we present MACHINE_RAW_TOKEN.
    const res = await get('/internal/agent-api/channels', headers(MACHINE_RAW_TOKEN, OTHER_AGENT_ID));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });

  it('invalid machine token → 401 MACHINE_TOKEN_INVALID', async () => {
    const res = await get('/internal/agent-api/channels', headers('machine_bogus_token', AGENT_ID));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('MACHINE_TOKEN_INVALID');
  });
});
