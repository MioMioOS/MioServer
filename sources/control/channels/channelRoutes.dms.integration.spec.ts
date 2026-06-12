/**
 * DM read path — GET /api/v1/workrooms/:wid/dms (REAL Postgres integration).
 *
 * Slice 7 B2-c: userOrMachine read — user_sess_ (workroom member) OR machine_token.
 * Scoping: every caller (user OR machine) sees only dm channels where their viewer id
 * is an explicit ControlChannelMember. The previous anonymous-read "all dm channels"
 * branch is gone (no anonymous read tokens exist after Slice 7).
 *
 * FAST MODE — only meaningful tests:
 *   - machine: returns ONLY dm channels the machine is a member of, peer = other member;
 *              excludes standard channels AND dm channels the machine is not in.
 *   - user-owner: only sees dm channels where user.id is a member (not all dms).
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
const OTHER_AGENT = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

const DM_WITH_MACHINE = randomUUID();
const DM_WITHOUT_MACHINE = randomUUID();
const DM_WITH_USER = randomUUID();
const STANDARD_CH = randomUUID();

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
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
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'DmReadSpec WR', createdBy: randomUUID() },
  });

  const owner = await db.user.create({
    data: { email: `dm-read-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  OWNER_USER_ID = owner.id;
  OWNER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: OWNER_USER_ID, tokenHash: hashUserSessionToken(OWNER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.userWorkroomMembership.create({
    data: { userId: OWNER_USER_ID, workroomId: WORKROOM_ID, role: 'owner' },
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

  // dm channel the machine is NOT a member of (also user not a member).
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

  // dm channel the user IS a member of (machine is not).
  await db.controlChannel.create({
    data: {
      id: DM_WITH_USER,
      workroomId: WORKROOM_ID,
      name: 'dm-with-user',
      type: 'dm',
      visibility: 'private',
      createdBy: 'system',
      lastActivityAt: new Date('2026-05-21T00:00:00.000Z'),
    },
  });
  await db.controlChannelMember.createMany({
    data: [
      { channelId: DM_WITH_USER, memberId: OWNER_USER_ID },
      { channelId: DM_WITH_USER, memberId: PEER_ID },
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
  await db.userWorkroomMembership.deleteMany({ where: { userId: OWNER_USER_ID } });
  await db.userSession.deleteMany({ where: { userId: OWNER_USER_ID } });
  await db.user.deleteMany({ where: { id: OWNER_USER_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
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
      // PEER_ID has no ControlAgent row in this fixture → identity fields resolve null.
      peer_display_name: null,
      peer_avatar: null,
      unread_count: 0,
      last_activity_at: '2026-05-23T00:00:00.000Z',
    });
  });

  it('user-owner: returns only dm channels where user.id is a member', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/dms`, OWNER_USER_TOKEN);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.dms).toHaveLength(1);
    expect(body.dms[0]).toEqual({
      id: DM_WITH_USER,
      peer_member_id: PEER_ID,
      peer_display_name: null,
      peer_avatar: null,
      unread_count: 0,
      last_activity_at: '2026-05-21T00:00:00.000Z',
    });
  });
});
