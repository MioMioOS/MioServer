/**
 * S4 DM — read path. GET /api/v1/workrooms/:wid/dms (REAL Postgres integration).
 *
 * Unit coverage (channelRoutes.dms.spec.ts) mocks Prisma. This spec proves the REAL query
 * against Postgres: the `type='dm'` + `members.some(memberId=caller)` WHERE clause, the
 * peer resolution, and the dev-token "all dm channels" scope. Without this, a wrong Prisma
 * filter (e.g. forgetting the membership join) would pass the mocked unit test but break live.
 *
 * FAST MODE — only meaningful tests:
 *   - machine: returns ONLY dm channels the machine is a member of, with peer = other member;
 *              excludes standard/main channels AND dm channels the machine is not in.
 *   - dev_ctl_: returns ALL dm channels in the workroom (no member filter).
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { channelRoutes } from './channelRoutes';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const PEER_ID = `pairing:${randomUUID()}`;
const OTHER_AGENT = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

const DM_WITH_MACHINE = randomUUID();   // dm: [MACHINE_ID, PEER_ID]
const DM_WITHOUT_MACHINE = randomUUID(); // dm: [OTHER_AGENT, PEER_ID]  (machine not a member)
const STANDARD_CH = randomUUID();        // type='standard' (must be excluded)

let APP: FastifyInstance;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const get = (url: string, token: string) =>
  APP.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  APP = fastify();
  await APP.register(channelRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'DmReadSpec Org', slug: `dm-read-${randomUUID()}`, ownerUserId: randomUUID() },
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'DmReadSpec WR', createdBy: randomUUID() },
  });

  // dm channel the machine IS a member of.
  await db.controlChannel.create({
    data: {
      id: DM_WITH_MACHINE,
      workroomId: WORKROOM_ID,
      name: 'dm-with-machine',
      type: 'dm',
      visibility: 'private',
      createdBy: 'system',
      lastActivityAt: new Date('2026-05-23T00:00:00.000Z'),
    },
  });
  await db.controlChannelMember.createMany({
    data: [
      { channelId: DM_WITH_MACHINE, memberId: MACHINE_ID },
      { channelId: DM_WITH_MACHINE, memberId: PEER_ID },
    ],
  });

  // dm channel the machine is NOT a member of.
  await db.controlChannel.create({
    data: {
      id: DM_WITHOUT_MACHINE,
      workroomId: WORKROOM_ID,
      name: 'dm-without-machine',
      type: 'dm',
      visibility: 'private',
      createdBy: 'system',
      lastActivityAt: new Date('2026-05-22T00:00:00.000Z'),
    },
  });
  await db.controlChannelMember.createMany({
    data: [
      { channelId: DM_WITHOUT_MACHINE, memberId: OTHER_AGENT },
      { channelId: DM_WITHOUT_MACHINE, memberId: PEER_ID },
    ],
  });

  // a non-dm channel (must never appear in /dms).
  await db.controlChannel.create({
    data: {
      id: STANDARD_CH,
      workroomId: WORKROOM_ID,
      name: 'general',
      type: 'standard',
      visibility: 'public',
      createdBy: 'system',
      lastActivityAt: new Date('2026-05-24T00:00:00.000Z'),
    },
  });
  await db.controlChannelMember.create({ data: { channelId: STANDARD_CH, memberId: MACHINE_ID } });
});

afterAll(async () => {
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlDevToken.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

describe('GET /api/v1/workrooms/:wid/dms (real DB)', () => {
  it('machine: returns only its own dm channels, peer = other member, excludes standard + non-member dm', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/dms`, MACHINE_RAW_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.dms).toHaveLength(1);
    expect(body.dms[0]).toEqual({
      id: DM_WITH_MACHINE,
      peer_member_id: PEER_ID,
      unread_count: 0,
      last_activity_at: '2026-05-23T00:00:00.000Z',
    });
  });

  it('dev_ctl_: returns ALL dm channels in the workroom (no member filter), excludes standard', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/dms`, DEV_CTL_RAW_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const ids = body.dms.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual([DM_WITH_MACHINE, DM_WITHOUT_MACHINE].sort());
    // standard channel never appears.
    expect(ids).not.toContain(STANDARD_CH);
    // every entry has the honest unread_count = 0.
    for (const d of body.dms) expect(d.unread_count).toBe(0);
  });
});
