/**
 * S6 — Channel WRITE endpoints (REAL Postgres integration).
 *
 * Covers:
 *   POST   /api/v1/workrooms/:wid/channels
 *   POST   /api/v1/workrooms/:wid/channels/:cid/members
 *   DELETE /api/v1/workrooms/:wid/channels/:cid/members/:memberId
 *
 * FAST MODE — only meaningful tests:
 *   - auth: op_sess_ create OK, machine create OK, dev_ctl_ → 403, no-auth → 401
 *   - create happy-path: 201, GET-channel wire shape, type 'standard', creator+members rowed
 *   - add-member happy-path: 200 {ok:true}, row exists, idempotent re-add no-op
 *   - remove-member happy-path: 200 {ok:true}, row gone, idempotent remove missing no-op
 *   - scoping: channel not in :wid → 404 (add + remove + create cross-org machine)
 *   - one key error each: create empty name → 400; manage_members in other workroom op_sess_ → 403
 *   - events: channel.created / channel.member_added / channel.member_removed written
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { channelRoutes } from './channelRoutes';
import { mintOperatorSession, V1_OPERATOR_COMMANDS } from '@/control/operatorSessions/operatorSessionMint';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID(); // same org, different workroom
const MACHINE_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID(); // bound to OTHER_ORG_ID (cross-org)
const OPERATOR_SUBJECT_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let OP_SESS_RAW_TOKEN = '';
// op_sess_ scoped to OTHER_WORKROOM_ID (used to prove wrong-workroom → 403)
let OP_SESS_OTHER_WR_TOKEN = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const opSessHeader = () => ({ authorization: `Bearer ${OP_SESS_RAW_TOKEN}` });
const opSessOtherWrHeader = () => ({ authorization: `Bearer ${OP_SESS_OTHER_WR_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const otherMachineHeader = () => ({ authorization: `Bearer ${OTHER_MACHINE_RAW_TOKEN}` });
const devCtlHeader = () => ({ authorization: `Bearer ${DEV_CTL_RAW_TOKEN}` });

function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = opSessHeader()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

function del(url: string, headers: Record<string, string> = opSessHeader()) {
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'ChWriteSpec WR', createdBy: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: OTHER_WORKROOM_ID, orgId: ORG_ID, name: 'ChWriteSpec OtherWR', createdBy: randomUUID() },
  });

  const minted = await mintOperatorSession({
    orgId: ORG_ID,
    workroomId: WORKROOM_ID,
    operatorSubjectId: OPERATOR_SUBJECT_ID,
    issuedBy: 'test',
    allowedCommands: [...V1_OPERATOR_COMMANDS],
  });
  OP_SESS_RAW_TOKEN = minted.rawToken;

  const mintedOther = await mintOperatorSession({
    orgId: ORG_ID,
    workroomId: OTHER_WORKROOM_ID,
    operatorSubjectId: OPERATOR_SUBJECT_ID,
    issuedBy: 'test',
    allowedCommands: [...V1_OPERATOR_COMMANDS],
  });
  OP_SESS_OTHER_WR_TOKEN = mintedOther.rawToken;
});

afterAll(async () => {
  const wrIds = [WORKROOM_ID, OTHER_WORKROOM_ID];
  await db.controlEventLog.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: { in: wrIds } } } });
  await db.controlChannel.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: wrIds } } });
  await db.controlDevToken.deleteMany({ where: { orgId: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await APP.close();
  await db.$disconnect();
});

// ── V1_OPERATOR_COMMANDS includes the S6 commands ─────────────────────────────

describe('V1_OPERATOR_COMMANDS includes S6 channel commands', () => {
  it('contains create_channel and manage_members', () => {
    expect(V1_OPERATOR_COMMANDS).toContain('create_channel');
    expect(V1_OPERATOR_COMMANDS).toContain('manage_members');
  });
});

// ── POST /api/v1/workrooms/:wid/channels ──────────────────────────────────────

describe('POST /api/v1/workrooms/:wid/channels', () => {
  it('op_sess_ create: 201 with GET-channel wire shape, type standard, creator+members rowed', async () => {
    const memberA = `pairing:${randomUUID()}`;
    const memberB = `pairing:${randomUUID()}`;
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'design', description: 'design talk', visibility: 'private', member_ids: [memberA, memberB] },
      opSessHeader(),
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

    // Member rows: creator (operator subject) + A + B.
    const members = await db.controlChannelMember.findMany({
      where: { channelId: body.id },
      select: { memberId: true },
    });
    const ids = members.map((m) => m.memberId).sort();
    expect(ids).toEqual([OPERATOR_SUBJECT_ID, memberA, memberB].sort());
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
      { name: 'dedupe', visibility: 'public', member_ids: [OPERATOR_SUBJECT_ID, OPERATOR_SUBJECT_ID] },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.member_count).toBe(1); // creator only, dupes skipped
  });

  it('empty name → 400', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: '   ', visibility: 'public' },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('dev_ctl_ → 403 hard reject', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels`,
      { name: 'denied', visibility: 'public' },
      devCtlHeader(),
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
      opSessHeader(),
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

  it('op_sess_ add member: 200 {ok:true}, row exists', async () => {
    const memberId = `pairing:${randomUUID()}`;
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: memberId },
      opSessHeader(),
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
    const res1 = await post(url, { member_id: memberId }, opSessHeader());
    const res2 = await post(url, { member_id: memberId }, opSessHeader());
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

  it('dev_ctl_ → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: `pairing:${randomUUID()}` },
      devCtlHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('op_sess_ scoped to other workroom → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: `pairing:${randomUUID()}` },
      opSessOtherWrHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('channel not in workroom → 404', async () => {
    // channel belongs to OTHER_WORKROOM_ID but request targets WORKROOM_ID.
    const otherCh = await db.controlChannel.create({
      data: { workroomId: OTHER_WORKROOM_ID, name: 'elsewhere', type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${otherCh.id}/members`,
      { member_id: `pairing:${randomUUID()}` },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('publishes channel.member_added event', async () => {
    const memberId = `pairing:${randomUUID()}`;
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members`,
      { member_id: memberId },
      opSessHeader(),
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

  it('op_sess_ remove member: 200 {ok:true}, row gone', async () => {
    const memberId = `pairing:${randomUUID()}`;
    await db.controlChannelMember.create({ data: { channelId, memberId } });

    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent(memberId)}`,
      opSessHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const row = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId, memberId } },
    });
    expect(row).toBeNull();
  });

  it('idempotent remove missing → 200 no-op', async () => {
    const memberId = `pairing:${randomUUID()}`; // never added
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent(memberId)}`,
      opSessHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('dev_ctl_ → 403', async () => {
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent('pairing:x')}`,
      devCtlHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('channel not in workroom → 404', async () => {
    const otherCh = await db.controlChannel.create({
      data: { workroomId: OTHER_WORKROOM_ID, name: 'rm-elsewhere', type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${otherCh.id}/members/${encodeURIComponent('pairing:x')}`,
      opSessHeader(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('publishes channel.member_removed event', async () => {
    const memberId = `pairing:${randomUUID()}`;
    await db.controlChannelMember.create({ data: { channelId, memberId } });
    const res = await del(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${channelId}/members/${encodeURIComponent(memberId)}`,
      opSessHeader(),
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
