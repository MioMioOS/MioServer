/**
 * S5 — Workroom search endpoint (REAL Postgres integration).
 *
 * GET /api/v1/workrooms/:wid/search?q=&scope=&time=
 *
 * Covers (meaningful tests only):
 *   - q matches messages (content ILIKE), channels (name ILIKE), members (displayName/name ILIKE)
 *   - blank / missing q → empty result set, no DB work
 *   - visibility: a message in a channel the caller cannot see is excluded
 *   - scope=MY_MESSAGES (machine) filters to senderId = machine.id
 *   - dev-token allowlist accepts the search path (and rejects POST)
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { searchRoutes } from './searchRoutes';
import { isDevTokenAllowedPath } from '@/control/devTokens/devTokenAuth';

// ── Fixture IDs ─────────────────────────────────────────────────────────────
const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();          // caller (machine token)
const OTHER_SENDER_ID = randomUUID();     // a different message sender
const AGENT_ID = randomUUID();            // searchable member
const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let PUBLIC_CHANNEL_ID = '';
let PRIVATE_CHANNEL_ID = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function authHeader() {
  return { authorization: `Bearer ${MACHINE_RAW_TOKEN}` };
}
function get(url: string, headers: Record<string, string> = authHeader()) {
  return APP.inject({ method: 'GET', url, headers });
}

async function seedMessage(opts: {
  channelId: string;
  seq: number;
  senderId: string;
  senderKind?: string;
  content: string;
}): Promise<string> {
  const id = randomUUID();
  await db.controlMessage.create({
    data: {
      id,
      workroomId: WORKROOM_ID,
      channelId: opts.channelId,
      seq: BigInt(opts.seq),
      senderKind: opts.senderKind ?? 'agent',
      senderId: opts.senderId,
      content: opts.content,
    },
  });
  return id;
}

beforeAll(async () => {
  APP = fastify();
  await APP.register(searchRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'Search Org', slug: `search-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlMachine.create({
    data: {
      id: MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(MACHINE_RAW_TOKEN),
      tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin',
      arch: 'arm64',
    },
  });
  // Searchable member: displayName 'Penguin Bot'.
  await db.controlAgent.create({
    data: { id: AGENT_ID, orgId: ORG_ID, name: 'penguin-agent', displayName: 'Penguin Bot', role: 'ops', status: 'online' },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Search WR', createdBy: randomUUID() },
  });

  // Public channel named 'penguin-pond' (so it matches q=penguin too).
  const pubCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'penguin-pond', type: 'standard', visibility: 'public', createdBy: 'system', lastActivityAt: new Date() },
  });
  PUBLIC_CHANNEL_ID = pubCh.id;

  // Private channel (no member rows → machine is NOT a member → invisible).
  const privCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'secret-room', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  PRIVATE_CHANNEL_ID = privCh.id;

  // Public-channel messages: one from the caller machine, one from someone else.
  await seedMessage({ channelId: PUBLIC_CHANNEL_ID, seq: 1, senderId: MACHINE_ID, content: 'the penguin waddled away' });
  await seedMessage({ channelId: PUBLIC_CHANNEL_ID, seq: 2, senderId: OTHER_SENDER_ID, content: 'a penguin appeared' });

  // Private-channel message that contains the query term — must be excluded for non-members.
  await seedMessage({ channelId: PRIVATE_CHANNEL_ID, seq: 1, senderId: OTHER_SENDER_ID, content: 'secret penguin plans' });
});

afterAll(async () => {
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

describe('GET /api/v1/workrooms/:wid/search', () => {
  it('q matches messages, channels, and members (scope=ALL)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/search?q=penguin&scope=ALL&time=ANY_TIME`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Messages: both public-channel hits (caller + other), NOT the private one.
    expect(body.messages).toHaveLength(2);
    for (const m of body.messages) {
      expect(m.channel_id).toBe(PUBLIC_CHANNEL_ID);
      expect(m.channel_name).toBe('penguin-pond');
      expect(m.content.toLowerCase()).toContain('penguin');
    }

    // Channel: 'penguin-pond' matches by name.
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0].id).toBe(PUBLIC_CHANNEL_ID);
    expect(body.channels[0].name).toBe('penguin-pond');

    // Member: 'Penguin Bot' matches by displayName.
    expect(body.members).toHaveLength(1);
    expect(body.members[0].id).toBe(AGENT_ID);
    expect(body.members[0].kind).toBe('agent');
    expect(body.members[0].display_name).toBe('Penguin Bot');
  });

  it('blank q → empty result set', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/search?q=%20%20&scope=ALL`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ messages: [], channels: [], members: [] });
  });

  it('missing q → empty result set', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/search`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ messages: [], channels: [], members: [] });
  });

  it('message in an invisible (private, non-member) channel is excluded', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/search?q=penguin&scope=ALL`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // The private-channel message 'secret penguin plans' must NOT appear.
    const ids = body.messages.map((m: { channel_id: string }) => m.channel_id);
    expect(ids).not.toContain(PRIVATE_CHANNEL_ID);
    // And the private channel itself must not appear in channels (name doesn't match anyway,
    // but assert the visibility filter holds for any future name collision).
    const chIds = body.channels.map((c: { id: string }) => c.id);
    expect(chIds).not.toContain(PRIVATE_CHANNEL_ID);
  });

  it('scope=MY_MESSAGES (machine) filters to senderId = machine.id', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/search?q=penguin&scope=MY_MESSAGES`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Only the caller-machine's message ('the penguin waddled away').
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].sender_id).toBe(MACHINE_ID);
    expect(body.messages[0].content).toBe('the penguin waddled away');
  });

  it('401 when no token provided', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/search?q=penguin`, {});
    expect(res.statusCode).toBe(401);
  });
});

describe('dev-token allowlist for search', () => {
  it('GET /search is allowlisted; POST /search is not', () => {
    expect(isDevTokenAllowedPath('GET', `/api/v1/workrooms/${WORKROOM_ID}/search`)).toBe(true);
    expect(isDevTokenAllowedPath('GET', `/api/v1/workrooms/${WORKROOM_ID}/search?q=x&scope=ALL`)).toBe(true);
    expect(isDevTokenAllowedPath('POST', `/api/v1/workrooms/${WORKROOM_ID}/search`)).toBe(false);
  });

  it('a dev_ctl_ token can reach search end-to-end (read-only)', async () => {
    // Mint a workroom-scoped read-only dev token, then call search with it through the full
    // authorizeControlRead path (allowlist + workroom-scope + dev mode).
    await db.controlDevToken.create({
      data: {
        tokenHash: sha256(DEV_RAW_TOKEN),
        orgId: ORG_ID,
        workroomId: WORKROOM_ID,
        scope: 'read_only',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/search?q=penguin&scope=ALL`, {
      authorization: `Bearer ${DEV_RAW_TOKEN}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Dev token has no member identity, so visibility uses devToken.id → public channel visible.
    expect(body.channels.map((c: { id: string }) => c.id)).toContain(PUBLIC_CHANNEL_ID);
    expect(body.members.map((m: { id: string }) => m.id)).toContain(AGENT_ID);

    await db.controlDevToken.deleteMany({ where: { tokenHash: sha256(DEV_RAW_TOKEN) } });
  });
});
