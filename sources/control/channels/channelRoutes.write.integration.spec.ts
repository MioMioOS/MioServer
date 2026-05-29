/**
 * Channel WRITE endpoints — REAL Postgres integration.
 *
 * Covers:
 *   POST   /api/v1/workrooms/:wid/channels
 *   POST   /api/v1/workrooms/:wid/channels/:cid/members
 *   DELETE /api/v1/workrooms/:wid/channels/:cid/members/:memberId
 *
 * Slice 7 B2-c auth: user_sess_ (workroom OWNER) OR machine_token (via authorizeChannelWrite).
 *
 * FAST MODE — only meaningful tests:
 *   - auth matrix: user-owner OK, machine OK, user non-member → 403, no-auth → 401,
 *                  cross-org machine → 403
 *   - create happy-path: 201, GET-channel wire shape, type 'standard', creator+members rowed
 *   - add-member happy-path: 200 {ok:true}, row exists, idempotent re-add no-op
 *   - remove-member happy-path: 200 {ok:true}, row gone, idempotent remove missing no-op
 *   - scoping: channel not in :wid → 404 (add + remove)
 *   - one key error: create empty name → 400
 *   - events: channel.created / channel.member_added / channel.member_removed written
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { channelRoutes } from './channelRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID(); // same org, different workroom (cross-workroom 404)
const MACHINE_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID(); // bound to OTHER_ORG_ID (cross-org)

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const otherMachineHeader = () => ({ authorization: `Bearer ${OTHER_MACHINE_RAW_TOKEN}` });

function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = ownerUserHeader()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

function del(url: string, headers: Record<string, string> = ownerUserHeader()) {
  return APP.inject({ method: 'DELETE', url, headers });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(channelRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'ChWriteSpec Org', slug: `ch-write-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlOrg.create({
    data: { id: OTHER_ORG_ID, name: 'ChWriteSpec OtherOrg', slug: `ch-write-other-${randomUUID()}`, ownerUserId: randomUUID() },
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
  await db.controlMachine.create({
    data: {
      id: OTHER_MACHINE_ID,
      orgId: OTHER_ORG_ID,
      tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN),
      tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin',
      arch: 'arm64',
    },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'ChWriteSpec WR', createdBy: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: OTHER_WORKROOM_ID, orgId: ORG_ID, name: 'ChWriteSpec OtherWR', createdBy: randomUUID() },
  });

  // user_sess_ fixtures: an OWNER (writes pass) + a NON-MEMBER (writes 403).
  const owner = await db.user.create({
    data: { email: `ch-write-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
    data: { email: `ch-write-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: { in: wrIds } } } });
  await db.controlChannel.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.userWorkroomMembership.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.userSession.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.user.deleteMany({ where: { id: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: wrIds } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await APP.close();
  await db.$disconnect();
});

// ── POST /api/v1/workrooms/:wid/channels ──────────────────────────────────────

describe('POST /api/v1/workrooms/:wid/channels', () => {
  it('user-owner create: 201 with GET-channel wire shape, type standard, creator+members rowed', async () => {
    const memberA = `pairing:${randomUUID()}`;
    const memberB = `pairing:${randomUUID()}`;
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'design', description: 'design talk', visibility: 'private', member_ids: [memberA, memberB] },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // GET-channel item wire shape.
    expect(body).toHaveProperty('id');
    expect(body.name).toBe('design');
    expect(body.type).toBe('standard');
    expect(body.visibility).toBe('private');
    expect(body).toHaveProperty('last_activity_at');
    expect(body).toHaveProperty('unread_count');
    expect(body).toHaveProperty('attention_count');
    // creator + 2 members = 3 unique members.
    expect(body.member_count).toBe(3);

    // Member rows: creator (user.id) + A + B.
    const members = await db.controlChannelMember.findMany({
      where: { channelId: body.id },
      select: { memberId: true },
    });
    const ids = members.map((m) => m.memberId).sort();
    expect(ids).toEqual([OWNER_USER_ID, memberA, memberB].sort());
  });

  it('machine create: 201, createdBy is machine id, machine is a member', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'machine-made', visibility: 'public' },
      machineHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('standard');
    expect(body.visibility).toBe('public');

    const ch = await db.controlChannel.findUnique({ where: { id: body.id }, select: { createdBy: true } });
    expect(ch!.createdBy).toBe(MACHINE_ID);
    expect(body.member_count).toBe(1); // just the creator
  });

  it('create dedupes a member_id equal to creator (unique skip)', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'dedupe', visibility: 'public', member_ids: [OWNER_USER_ID, OWNER_USER_ID] },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.member_count).toBe(1); // creator only, dupes skipped
  });

  it('empty name → 400', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: '   ', visibility: 'public' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('user non-member → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'denied', visibility: 'public' },
      nonMemberUserHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/channels`, { name: 'x', visibility: 'public' }, {});
    expect(res.statusCode).toBe(401);
  });

  it('cross-org machine → 403 (requireMachineAccessToWorkroom)', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'cross-org', visibility: 'public' },
      otherMachineHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('publishes channel.created event', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'evented', visibility: 'public' },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'channel.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect((event!.payloadJson as Record<string, unknown>).channel_id).toBe(body.id);
  });
});

// ── POST /api/v1/workrooms/:wid/channels/:cid/members ──────────────────────────

describe('POST /api/v1/workrooms/:wid/channels/:cid/members', () => {
  let channelId = '';

  beforeAll(async () => {
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'add-target', type: 'standard', visibility: 'private', createdBy: 'system' },
    });
    channelId = ch.id;
  });

  it('user-owner add member: 200 {ok:true}, row exists', async () => {
    const memberId = `pairing:${randomUUID()}`;
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: memberId },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const row = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId, memberId } },
    });
    expect(row).not.toBeNull();
  });

  it('idempotent re-add → 200 no-op (still one row)', async () => {
    const memberId = `pairing:${randomUUID()}`;
    const url = `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`;
    const res1 = await post(url, { member_id: memberId }, ownerUserHeader());
    const res2 = await post(url, { member_id: memberId }, ownerUserHeader());
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    const count = await db.controlChannelMember.count({ where: { channelId, memberId } });
    expect(count).toBe(1);
  });

  it('machine add member: 200 {ok:true}', async () => {
    const memberId = `pairing:${randomUUID()}`;
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: memberId },
      machineHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('user non-member → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: `pairing:${randomUUID()}` },
      nonMemberUserHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: `pairing:${randomUUID()}` },
      {},
    );
    expect(res.statusCode).toBe(401);
  });

  it('channel not in workroom → 404', async () => {
    const otherCh = await db.controlChannel.create({
      data: { workroomId: OTHER_WORKROOM_ID, name: 'elsewhere', type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${otherCh.id}/members`,
      { member_id: `pairing:${randomUUID()}` },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('publishes channel.member_added event', async () => {
    const memberId = `pairing:${randomUUID()}`;
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: memberId },
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(200);
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'channel.member_added' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.channel_id).toBe(channelId);
    expect(payload.member_id).toBe(memberId);
  });
});

// ── DELETE /api/v1/workrooms/:wid/channels/:cid/members/:memberId ───────────────

describe('DELETE /api/v1/workrooms/:wid/channels/:cid/members/:memberId', () => {
  let channelId = '';

  beforeAll(async () => {
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'remove-target', type: 'standard', visibility: 'private', createdBy: 'system' },
    });
    channelId = ch.id;
  });

  it('user-owner remove member: 200 {ok:true}, row gone', async () => {
    const memberId = `pairing:${randomUUID()}`;
    await db.controlChannelMember.create({ data: { channelId, memberId } });

    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent(memberId)}`,
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const row = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId, memberId } },
    });
    expect(row).toBeNull();
  });

  it('idempotent remove missing → 200 no-op', async () => {
    const memberId = `pairing:${randomUUID()}`;
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent(memberId)}`,
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('user non-member → 403', async () => {
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent('pairing:x')}`,
      nonMemberUserHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent('pairing:x')}`,
      {},
    );
    expect(res.statusCode).toBe(401);
  });

  it('channel not in workroom → 404', async () => {
    const otherCh = await db.controlChannel.create({
      data: { workroomId: OTHER_WORKROOM_ID, name: 'rm-elsewhere', type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${otherCh.id}/members/${encodeURIComponent('pairing:x')}`,
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('publishes channel.member_removed event', async () => {
    const memberId = `pairing:${randomUUID()}`;
    await db.controlChannelMember.create({ data: { channelId, memberId } });
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent(memberId)}`,
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(200);
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'channel.member_removed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.channel_id).toBe(channelId);
    expect(payload.member_id).toBe(memberId);
  });
});
