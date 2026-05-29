/**
 * "Start a Direct Message" — POST /api/v1/workrooms/:wid/dms (REAL Postgres integration).
 *
 * Slice 7 B2-c auth: user_sess_ (workroom OWNER) OR machine_token via authorizeChannelWrite.
 *
 * FAST MODE — only meaningful tests:
 *   - user-owner start: 201, dm wire shape, dm channel created with BOTH members (caller + peer).
 *   - find-or-create idempotency: second call with same peer returns SAME channel id.
 *   - auth: user non-member → 403; no auth → 401.
 *   - publishes channel.created (type dm).
 *   - find-or-create only matches EXACT member set (different peer → new channel).
 *   - machine start: 201, createdBy is machine id.
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

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const PEER_ID = `pairing:${randomUUID()}`;
const OTHER_PEER_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });

function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = ownerUserHeader()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

beforeAll(async () => {
  APP = fastify();
  await APP.register(channelRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'StartDmSpec Org', slug: `start-dm-${randomUUID()}`, ownerUserId: randomUUID() },
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
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'StartDmSpec WR', createdBy: randomUUID() },
  });

  const owner = await db.user.create({
    data: { email: `start-dm-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
    data: { email: `start-dm-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.userWorkroomMembership.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.userSession.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.user.deleteMany({ where: { id: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

describe('POST /api/v1/workrooms/:wid/dms (start a direct message)', () => {
  it('user-owner start: 201, dm wire shape, creates a dm channel with caller + peer as members', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, ownerUserHeader());
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    expect(body).toHaveProperty('id');
    expect(body.peer_member_id).toBe(PEER_ID);
    expect(body.unread_count).toBe(0);
    expect(body).toHaveProperty('last_activity_at');

    const ch = await db.controlChannel.findUnique({
      where: { id: body.id },
      select: { type: true, visibility: true, workroomId: true, createdBy: true },
    });
    expect(ch!.type).toBe('dm');
    expect(ch!.visibility).toBe('private');
    expect(ch!.workroomId).toBe(WORKROOM_ID);
    expect(ch!.createdBy).toBe(OWNER_USER_ID);

    const members = await db.controlChannelMember.findMany({
      where: { channelId: body.id },
      select: { memberId: true },
    });
    expect(members.map((m) => m.memberId).sort()).toEqual([OWNER_USER_ID, PEER_ID].sort());
  });

  it('find-or-create: a second start with the same peer returns the SAME channel (no duplicate)', async () => {
    const res1 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, ownerUserHeader());
    const res2 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, ownerUserHeader());
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    const id1 = JSON.parse(res1.body).id;
    const id2 = JSON.parse(res2.body).id;
    expect(id2).toBe(id1);

    const dmChannels = await db.controlChannel.findMany({
      where: { workroomId: WORKROOM_ID, type: 'dm', members: { some: { memberId: PEER_ID } } },
      include: { members: { select: { memberId: true } } },
    });
    const pairMatches = dmChannels.filter((ch) => {
      const set = new Set(ch.members.map((m) => m.memberId));
      return set.size === 2 && set.has(OWNER_USER_ID) && set.has(PEER_ID);
    });
    expect(pairMatches).toHaveLength(1);
  });

  it('find-or-create only matches the EXACT member set (different peer → new channel)', async () => {
    const res1 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, ownerUserHeader());
    const res2 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: OTHER_PEER_ID }, ownerUserHeader());
    expect(JSON.parse(res2.body).id).not.toBe(JSON.parse(res1.body).id);
    expect(JSON.parse(res2.body).peer_member_id).toBe(OTHER_PEER_ID);
  });

  it('publishes channel.created event (type dm)', async () => {
    const freshPeer = `pairing:${randomUUID()}`;
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: freshPeer }, ownerUserHeader());
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'channel.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.channel_id).toBe(body.id);
    expect(payload.type).toBe('dm');
  });

  it('machine start: 201, createdBy is machine id, machine is a member', async () => {
    const peer = `pairing:${randomUUID()}`;
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: peer }, machineHeader());
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.peer_member_id).toBe(peer);
    const members = await db.controlChannelMember.findMany({
      where: { channelId: body.id },
      select: { memberId: true },
    });
    expect(members.map((m) => m.memberId).sort()).toEqual([MACHINE_ID, peer].sort());
  });

  it('missing member_id → 400', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, {}, ownerUserHeader());
    expect(res.statusCode).toBe(400);
  });

  it('user non-member → 403', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, nonMemberUserHeader());
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, {});
    expect(res.statusCode).toBe(401);
  });
});
