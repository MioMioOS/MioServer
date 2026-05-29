/**
 * C2 — Agent API profile routes integration tests.
 *
 * Endpoints under test:
 *   GET  /internal/agent-api/profile?handle=   (authorizeAgentApi)
 *   PATCH /internal/agent-api/profile           (authorizeAgentApi, own-only)
 *
 * Required cases:
 *   - GET self (no handle) → own fields + avatar is generateIdenticon(name)
 *   - GET @handle of another agent in the same org → that agent's profile
 *   - GET unknown handle → 404 HANDLE_NOT_FOUND
 *   - GET ambiguous handle (two agents with same name in same org) → 409 AMBIGUOUS_HANDLE
 *   - PATCH own display_name + description → persists (re-query confirms) + returned in response
 *   - SECURITY: PATCH cannot touch another agent's row — assert the other agent's row is unchanged
 *   - Cross-machine agent → 403 AGENT_NOT_OWNED
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/profile sources/control/agentApi
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { generateIdenticon } from './identicon';
import { agentApiProfile } from './agentApiProfile';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();        // owned by MACHINE_ID
const OTHER_AGENT_ID = randomUUID();  // owned by OTHER_MACHINE_ID, different name
const AMBIG_AGENT_ID_A = randomUUID(); // same name as AMBIG_AGENT_ID_B for ambiguous test
const AMBIG_AGENT_ID_B = randomUUID(); // same name as AMBIG_AGENT_ID_A

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

const AGENT_NAME = 'ProfileTestAgent';
const OTHER_AGENT_NAME = 'OtherProfileAgent';
const AMBIG_NAME = 'AmbiguousAgent';

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

function getProfile(handle?: string, h = headers()) {
  const url = handle
    ? `/internal/agent-api/profile?handle=${encodeURIComponent(handle)}`
    : '/internal/agent-api/profile';
  return APP.inject({ method: 'GET', url, headers: h });
}

function patchProfile(body: Record<string, unknown>, h = headers()) {
  return APP.inject({
    method: 'PATCH',
    url: '/internal/agent-api/profile',
    headers: h,
    payload: JSON.stringify(body),
  });
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentApiProfile);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'AgentApiProfile Org',
      slug: `agent-api-profile-${randomUUID()}`,
      ownerUserId: randomUUID(),
    },
  });

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

  // Primary test agent
  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: AGENT_NAME,
      displayName: 'Profile Test Agent Display',
      description: 'initial description',
      role: 'engineer',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // Another agent in same org, different machine
  await db.controlAgent.create({
    data: {
      id: OTHER_AGENT_ID,
      orgId: ORG_ID,
      machineId: OTHER_MACHINE_ID,
      name: OTHER_AGENT_NAME,
      displayName: 'Other Profile Agent Display',
      description: 'other description',
      role: 'pm',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // Two agents with SAME name (for ambiguous handle test)
  await db.controlAgent.create({
    data: {
      id: AMBIG_AGENT_ID_A,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: AMBIG_NAME,
      displayName: 'Ambig A',
      description: '',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });
  await db.controlAgent.create({
    data: {
      id: AMBIG_AGENT_ID_B,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: AMBIG_NAME,
      displayName: 'Ambig B',
      description: '',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });
});

afterAll(async () => {
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── GET /internal/agent-api/profile ───────────────────────────────────────────

describe('GET /internal/agent-api/profile', () => {
  it('show self (no handle) → own fields + avatar is deterministic generateIdenticon(name)', async () => {
    const res = await getProfile();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.handle).toBe(`@${AGENT_NAME}`);
    expect(body.display_name).toBe('Profile Test Agent Display');
    expect(body.description).toBe('initial description');
    expect(body.role).toBe('engineer');
    // Avatar must equal generateIdenticon(AGENT_NAME) — deterministic
    expect(body.avatar).toBe(generateIdenticon(AGENT_NAME));
    expect(body.avatar).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('show @handle of another agent in the same org → that agent\'s profile', async () => {
    const res = await getProfile(`@${OTHER_AGENT_NAME}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.handle).toBe(`@${OTHER_AGENT_NAME}`);
    expect(body.display_name).toBe('Other Profile Agent Display');
    expect(body.role).toBe('pm');
    expect(body.avatar).toBe(generateIdenticon(OTHER_AGENT_NAME));
  });

  it('show handle without leading @ also works (@ is stripped)', async () => {
    // handle without @ prefix
    const res = await getProfile(OTHER_AGENT_NAME);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.handle).toBe(`@${OTHER_AGENT_NAME}`);
  });

  it('unknown handle → 404 HANDLE_NOT_FOUND', async () => {
    const res = await getProfile('@NonExistentAgent999');
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('HANDLE_NOT_FOUND');
  });

  it('ambiguous handle (two agents with same name in org) → 409 AMBIGUOUS_HANDLE', async () => {
    const res = await getProfile(`@${AMBIG_NAME}`);
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('AMBIGUOUS_HANDLE');
  });

  it('cross-machine agent → 403 AGENT_NOT_OWNED', async () => {
    // MACHINE_RAW_TOKEN but OTHER_AGENT_ID (owned by OTHER_MACHINE_ID)
    const res = await getProfile(undefined, headers(MACHINE_RAW_TOKEN, OTHER_AGENT_ID));
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('AGENT_NOT_OWNED');
  });
});

// ── PATCH /internal/agent-api/profile ────────────────────────────────────────

describe('PATCH /internal/agent-api/profile', () => {
  it('update own display_name + description → persists and is returned in response', async () => {
    const res = await patchProfile({
      display_name: 'Updated Display Name',
      description: 'Updated description text',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.handle).toBe(`@${AGENT_NAME}`);
    expect(body.display_name).toBe('Updated Display Name');
    expect(body.description).toBe('Updated description text');
    expect(body.avatar).toBe(generateIdenticon(AGENT_NAME));

    // Re-query DB to confirm persistence
    const stored = await db.controlAgent.findUnique({ where: { id: AGENT_ID } });
    expect(stored!.displayName).toBe('Updated Display Name');
    expect(stored!.description).toBe('Updated description text');
  });

  it('update only display_name → description unchanged', async () => {
    // First reset to known state
    await db.controlAgent.update({
      where: { id: AGENT_ID },
      data: { displayName: 'Before Only Name', description: 'keep this' },
    });

    const res = await patchProfile({ display_name: 'Only Name Changed' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.display_name).toBe('Only Name Changed');
    expect(body.description).toBe('keep this');
  });

  it('update only description → display_name unchanged', async () => {
    await db.controlAgent.update({
      where: { id: AGENT_ID },
      data: { displayName: 'keep this name', description: 'old desc' },
    });

    const res = await patchProfile({ description: 'new desc only' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.display_name).toBe('keep this name');
    expect(body.description).toBe('new desc only');
  });

  it('empty body (neither display_name nor description) → 400 INVALID_BODY', async () => {
    const res = await patchProfile({});
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('SECURITY: PATCH only writes auth.agent.id — another agent\'s row is provably unchanged', async () => {
    // Capture the OTHER agent's current state
    const otherBefore = await db.controlAgent.findUnique({ where: { id: OTHER_AGENT_ID } });
    expect(otherBefore).not.toBeNull();

    // The primary agent PATCHes their own profile
    const res = await patchProfile({
      display_name: 'Security Test Display',
      description: 'Security test desc',
    });
    expect(res.statusCode).toBe(200);

    // Confirm the OTHER agent's row is completely unchanged
    const otherAfter = await db.controlAgent.findUnique({ where: { id: OTHER_AGENT_ID } });
    expect(otherAfter!.displayName).toBe(otherBefore!.displayName);
    expect(otherAfter!.description).toBe(otherBefore!.description);
    expect(otherAfter!.updatedAt.getTime()).toBe(otherBefore!.updatedAt.getTime());
  });

  it('cross-machine agent → 403 AGENT_NOT_OWNED', async () => {
    const res = await patchProfile(
      { display_name: 'Should not update' },
      headers(MACHINE_RAW_TOKEN, OTHER_AGENT_ID),
    );
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('AGENT_NOT_OWNED');
  });
});
