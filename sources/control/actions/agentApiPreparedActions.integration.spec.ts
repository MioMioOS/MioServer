/**
 * Slice 4.2 Chunk C — Agent API prepared-action routes integration tests.
 *
 * Endpoints under test (all behind authorizeAgentApi; prepare also resolves the target channel):
 *   POST /internal/agent-api/actions/prepare  { target, type, params }
 *   GET  /internal/agent-api/actions/list?status=&channel=
 *
 * This is the AGENT-FACING proposal side. fulfill/dismiss are operator routes (Chunk D),
 * not covered here.
 *
 * Required cases:
 *   - prepare channel:create {target:#sim, params:{name:'#foo',visibility:'public'}}
 *       → ControlPreparedAction(status proposed, cardMessageId set)
 *       + a 🔧 system message in #sim (sender_kind=system) — CARD FIRST so cardMessageId is never null
 *   - prepare channel:add_member {target:#sim, params:{channel:'#sim', member_id:<seeded>}}
 *       → proposed + card; params normalized (channelId + member_id resolved)
 *   - prepare channel:add_member with member_handle → resolved to member_id
 *   - validation: bad type → 400 INVALID_ACTION_TYPE
 *   - channel:create missing name → 400 INVALID_PARAMS
 *   - channel:add_member missing channel/member → 400 INVALID_PARAMS
 *   - channel:add_member unknown member → 400 INVALID_PARAMS
 *   - list → only own actions (author-anchored); status + channel filters
 *   - non-member target → 404 NOT_A_MEMBER
 *   - cross-machine agent → 403 AGENT_NOT_OWNED
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/actions/agentApiPreparedActions.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentApiPreparedActions } from './agentApiPreparedActions';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();        // owned by MACHINE_ID, member of CHANNEL_ID
const OTHER_AGENT_ID = randomUUID();  // owned by OTHER_MACHINE_ID
const TARGET_MEMBER_ID = randomUUID(); // an agent to add via channel:add_member

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let CHANNEL_ID = '';        // #sim channel — AGENT_ID is a member
let OTHER_CHANNEL_ID = '';  // a channel AGENT_ID is NOT a member of

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
  return APP.inject({ method: 'POST', url, headers: h, payload: JSON.stringify(body) });
}

function prepare(body: Record<string, unknown>, h = headers()) {
  return post('/internal/agent-api/actions/prepare', body, h);
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentApiPreparedActions);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'AgentApiPreparedActions Org',
      slug: `agent-api-prepared-${randomUUID()}`,
      ownerUserId: randomUUID(),
    },
  });

  await db.controlMachine.create({
    data: { id: MACHINE_ID, orgId: ORG_ID, tokenHash: sha256(MACHINE_RAW_TOKEN), tokenExpiresAt, platform: 'darwin', arch: 'arm64' },
  });
  await db.controlMachine.create({
    data: { id: OTHER_MACHINE_ID, orgId: ORG_ID, tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN), tokenExpiresAt, platform: 'darwin', arch: 'arm64' },
  });

  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentApiPreparedActions WR', createdBy: randomUUID() },
  });

  await db.controlAgent.create({
    data: {
      id: AGENT_ID, orgId: ORG_ID, machineId: MACHINE_ID,
      name: 'simbot', displayName: 'SimBot',
      role: 'other', status: 'offline', capabilities: {}, permissions: {},
    },
  });
  await db.controlAgent.create({
    data: {
      id: OTHER_AGENT_ID, orgId: ORG_ID, machineId: OTHER_MACHINE_ID,
      name: 'otherbot', displayName: 'OtherBot',
      role: 'other', status: 'offline', capabilities: {}, permissions: {},
    },
  });
  // Member to add via channel:add_member — addressable by handle `addme`.
  await db.controlAgent.create({
    data: {
      id: TARGET_MEMBER_ID, orgId: ORG_ID, machineId: MACHINE_ID,
      name: 'addme', displayName: 'AddMe',
      role: 'other', status: 'offline', capabilities: {}, permissions: {},
    },
  });

  // #sim channel — AGENT_ID is a member
  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'sim', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;
  await db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId: AGENT_ID } });

  // Non-member channel
  const otherCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'no-member-actions', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  OTHER_CHANNEL_ID = otherCh.id;
});

afterAll(async () => {
  await db.controlPreparedAction.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── POST /internal/agent-api/actions/prepare — channel:create ──────────────────

describe('POST /internal/agent-api/actions/prepare (channel:create)', () => {
  it('proposes a channel:create → ControlPreparedAction(proposed, cardMessageId set) + 🔧 system message in #sim', async () => {
    const res = await prepare({
      target: '#sim',
      type: 'channel:create',
      params: { name: '#foo', visibility: 'public' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('action');
    const a = body.action;
    expect(a.type).toBe('channel:create');
    expect(a.status).toBe('proposed');
    expect(a.cardMessageId).toBeTruthy(); // CARD FIRST → never null
    expect(a.channelId).toBe(CHANNEL_ID);
    expect(a.proposerAgentId).toBe(AGENT_ID);

    // DB row
    const stored = await db.controlPreparedAction.findUnique({ where: { id: a.id } });
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('proposed');
    expect(stored!.cardMessageId).toBe(a.cardMessageId);
    expect(stored!.proposerAgentId).toBe(AGENT_ID);
    expect(stored!.workroomId).toBe(WORKROOM_ID);
    // normalized params: visibility defaulted, name preserved
    const params = stored!.params as { name?: string; visibility?: string };
    expect(params.name).toBe('#foo');
    expect(params.visibility).toBe('public');

    // 🔧 card system message in #sim
    const card = await db.controlMessage.findFirst({
      where: { id: a.cardMessageId },
    });
    expect(card).not.toBeNull();
    expect(card!.channelId).toBe(CHANNEL_ID);
    expect(card!.senderKind).toBe('system');
    expect(card!.content).toContain('🔧');
    expect(card!.content).toContain('foo');
  });

  it('defaults visibility to public when omitted', async () => {
    const res = await prepare({ target: '#sim', type: 'channel:create', params: { name: '#defvis' } });
    expect(res.statusCode).toBe(200);
    const a = JSON.parse(res.body).action;
    const stored = await db.controlPreparedAction.findUnique({ where: { id: a.id } });
    expect((stored!.params as { visibility?: string }).visibility).toBe('public');
  });

  it('missing name → 400 INVALID_PARAMS', async () => {
    const res = await prepare({ target: '#sim', type: 'channel:create', params: { visibility: 'public' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('bad visibility → 400 INVALID_PARAMS', async () => {
    const res = await prepare({ target: '#sim', type: 'channel:create', params: { name: '#x', visibility: 'secret' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });
});

// ── POST /internal/agent-api/actions/prepare — channel:add_member ──────────────

describe('POST /internal/agent-api/actions/prepare (channel:add_member)', () => {
  it('proposes add_member by member_id → proposed + card, normalized channelId', async () => {
    const res = await prepare({
      target: '#sim',
      type: 'channel:add_member',
      params: { channel: '#sim', member_id: TARGET_MEMBER_ID },
    });
    expect(res.statusCode).toBe(200);
    const a = JSON.parse(res.body).action;
    expect(a.type).toBe('channel:add_member');
    expect(a.status).toBe('proposed');
    expect(a.cardMessageId).toBeTruthy();

    const stored = await db.controlPreparedAction.findUnique({ where: { id: a.id } });
    const params = stored!.params as { channelId?: string; member_id?: string };
    expect(params.channelId).toBe(CHANNEL_ID);
    expect(params.member_id).toBe(TARGET_MEMBER_ID);

    const card = await db.controlMessage.findUnique({ where: { id: a.cardMessageId } });
    expect(card!.content).toContain('🔧');
  });

  it('proposes add_member by member_handle → resolves to member_id', async () => {
    const res = await prepare({
      target: '#sim',
      type: 'channel:add_member',
      params: { channel: '#sim', member_handle: 'addme' },
    });
    expect(res.statusCode).toBe(200);
    const a = JSON.parse(res.body).action;
    const stored = await db.controlPreparedAction.findUnique({ where: { id: a.id } });
    expect((stored!.params as { member_id?: string }).member_id).toBe(TARGET_MEMBER_ID);
  });

  it('missing channel → 400 INVALID_PARAMS', async () => {
    const res = await prepare({ target: '#sim', type: 'channel:add_member', params: { member_id: TARGET_MEMBER_ID } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('missing member_id and member_handle → 400 INVALID_PARAMS', async () => {
    const res = await prepare({ target: '#sim', type: 'channel:add_member', params: { channel: '#sim' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('params.channel is a real channel the agent is NOT a member of → 400 INVALID_PARAMS', async () => {
    // #no-member-actions (OTHER_CHANNEL_ID) exists but AGENT_ID has no membership row.
    // The resolveAgentChannelTarget-fails-for-non-member arm surfaces as bad params here.
    const res = await prepare({
      target: '#sim', // the card surface IS resolvable (member)
      type: 'channel:add_member',
      params: { channel: '#no-member-actions', member_id: TARGET_MEMBER_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('unknown member_id → 400 INVALID_PARAMS', async () => {
    const res = await prepare({
      target: '#sim', type: 'channel:add_member',
      params: { channel: '#sim', member_id: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('unknown member_handle → 400 INVALID_PARAMS', async () => {
    const res = await prepare({
      target: '#sim', type: 'channel:add_member',
      params: { channel: '#sim', member_handle: 'nobody-here' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });
});

// ── prepare — type + target validation ─────────────────────────────────────────

describe('POST /internal/agent-api/actions/prepare (type + target validation)', () => {
  it('bad type → 400 INVALID_ACTION_TYPE', async () => {
    const res = await prepare({ target: '#sim', type: 'channel:nuke', params: {} });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_ACTION_TYPE');
  });

  it('non-member target → 404 NOT_A_MEMBER', async () => {
    const res = await prepare({
      target: '#no-member-actions', type: 'channel:create', params: { name: '#nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it("another machine's agent → 403 AGENT_NOT_OWNED", async () => {
    const res = await prepare(
      { target: '#sim', type: 'channel:create', params: { name: '#x' } },
      headers(MACHINE_RAW_TOKEN, OTHER_AGENT_ID),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });
});

// ── GET /internal/agent-api/actions/list ──────────────────────────────────────

describe('GET /internal/agent-api/actions/list', () => {
  it('returns only the calling agent actions (author-anchored)', async () => {
    // Own action
    const own = await prepare({ target: '#sim', type: 'channel:create', params: { name: '#ownlist' } });
    const ownId = JSON.parse(own.body).action.id;

    // Foreign action seeded directly
    const foreign = await db.controlPreparedAction.create({
      data: {
        workroomId: WORKROOM_ID,
        channelId: CHANNEL_ID,
        proposerAgentId: OTHER_AGENT_ID,
        type: 'channel:create',
        params: { name: '#foreign' },
        status: 'proposed',
        cardMessageId: randomUUID(),
      },
    });

    const res = await get('/internal/agent-api/actions/list');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('actions');
    const ids = body.actions.map((x: { id: string }) => x.id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(foreign.id);
  });

  it('status filter narrows results', async () => {
    const res = await get('/internal/agent-api/actions/list?status=proposed');
    expect(res.statusCode).toBe(200);
    for (const a of JSON.parse(res.body).actions) {
      expect(a.status).toBe('proposed');
    }
  });

  it('invalid status filter → 400 INVALID_PARAMS', async () => {
    const res = await get('/internal/agent-api/actions/list?status=bogus');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_PARAMS');
  });

  it('channel filter narrows to the resolved channel', async () => {
    const res = await get('/internal/agent-api/actions/list?channel=%23sim');
    expect(res.statusCode).toBe(200);
    for (const a of JSON.parse(res.body).actions) {
      expect(a.channelId).toBe(CHANNEL_ID);
    }
  });

  it('channel filter on a non-member channel → 404 NOT_A_MEMBER', async () => {
    const res = await get('/internal/agent-api/actions/list?channel=%23no-member-actions');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });
});
