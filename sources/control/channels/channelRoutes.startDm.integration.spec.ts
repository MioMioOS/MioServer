/**
 * "Start a Direct Message" — POST /api/v1/workrooms/:wid/dms (REAL Postgres integration).
 *
 * Find-or-create a dm channel between the caller and a target member. No schema change:
 * a dm is a ControlChannel(type='dm') + two ControlChannelMember rows.
 *
 * FAST MODE — only meaningful tests:
 *   - op_sess_ start: 201, dm wire shape, dm channel created with BOTH members (caller + target).
 *   - find-or-create idempotency: a second call with the same target returns the SAME channel id
 *     (no duplicate dm channel).
 *   - auth: dev_ctl_ → 403 (hard reject); no auth → 401.
 *   - publishes channel.created (type dm).
 *   - find-or-create does NOT match a partial-overlap dm (different member set → new channel).
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { channelRoutes } from './channelRoutes';
import { mintOperatorSession, V1_OPERATOR_COMMANDS } from '@/control/operatorSessions/operatorSessionMint';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OPERATOR_SUBJECT_ID = `pairing:${randomUUID()}`;
const PEER_ID = `pairing:${randomUUID()}`;
const OTHER_PEER_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let OP_SESS_RAW_TOKEN = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const opSessHeader = () => ({ authorization: `Bearer ${OP_SESS_RAW_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const devCtlHeader = () => ({ authorization: `Bearer ${DEV_CTL_RAW_TOKEN}` });

function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = opSessHeader()) {
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
  await db.controlDevToken.create({
    data: {
      id: randomUUID(),
      orgId: ORG_ID,
      workroomId: WORKROOM_ID,
      tokenHash: sha256(DEV_CTL_RAW_TOKEN),
      scope: 'read_only',
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'StartDmSpec WR', createdBy: randomUUID() },
  });

  const minted = await mintOperatorSession({
    orgId: ORG_ID,
    workroomId: WORKROOM_ID,
    operatorSubjectId: OPERATOR_SUBJECT_ID,
    issuedBy: 'test',
    allowedCommands: [...V1_OPERATOR_COMMANDS],
  });
  OP_SESS_RAW_TOKEN = minted.rawToken;
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlDevToken.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

describe('POST /api/v1/workrooms/:wid/dms (start a direct message)', () => {
  it('op_sess_ start: 201, dm wire shape, creates a dm channel with caller + peer as members', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, opSessHeader());
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // dm wire shape.
    expect(body).toHaveProperty('id');
    expect(body.peer_member_id).toBe(PEER_ID);
    expect(body.unread_count).toBe(0);
    expect(body).toHaveProperty('last_activity_at');

    // Channel is a real dm.
    const ch = await db.controlChannel.findUnique({
      where: { id: body.id },
      select: { type: true, visibility: true, workroomId: true, createdBy: true },
    });
    expect(ch!.type).toBe('dm');
    expect(ch!.visibility).toBe('private');
    expect(ch!.workroomId).toBe(WORKROOM_ID);
    expect(ch!.createdBy).toBe(OPERATOR_SUBJECT_ID);

    // Member set is exactly {caller, peer}.
    const members = await db.controlChannelMember.findMany({
      where: { channelId: body.id },
      select: { memberId: true },
    });
    expect(members.map((m) => m.memberId).sort()).toEqual([OPERATOR_SUBJECT_ID, PEER_ID].sort());
  });

  it('find-or-create: a second start with the same peer returns the SAME channel (no duplicate)', async () => {
    const res1 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, opSessHeader());
    const res2 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, opSessHeader());
    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    const id1 = JSON.parse(res1.body).id;
    const id2 = JSON.parse(res2.body).id;
    expect(id2).toBe(id1);

    // Exactly one dm channel exists for this {caller, peer} pair.
    const dmChannels = await db.controlChannel.findMany({
      where: { workroomId: WORKROOM_ID, type: 'dm', members: { some: { memberId: PEER_ID } } },
      include: { members: { select: { memberId: true } } },
    });
    const pairMatches = dmChannels.filter((ch) => {
      const set = new Set(ch.members.map((m) => m.memberId));
      return set.size === 2 && set.has(OPERATOR_SUBJECT_ID) && set.has(PEER_ID);
    });
    expect(pairMatches).toHaveLength(1);
  });

  it('find-or-create only matches the EXACT member set (different peer → new channel)', async () => {
    const res1 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, opSessHeader());
    const res2 = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: OTHER_PEER_ID }, opSessHeader());
    expect(JSON.parse(res2.body).id).not.toBe(JSON.parse(res1.body).id);
    expect(JSON.parse(res2.body).peer_member_id).toBe(OTHER_PEER_ID);
  });

  it('publishes channel.created event (type dm)', async () => {
    const freshPeer = `pairing:${randomUUID()}`;
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: freshPeer }, opSessHeader());
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
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, {}, opSessHeader());
    expect(res.statusCode).toBe(400);
  });

  it('dev_ctl_ → 403 hard reject', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, devCtlHeader());
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/dms`, { member_id: PEER_ID }, {});
    expect(res.statusCode).toBe(401);
  });
});
