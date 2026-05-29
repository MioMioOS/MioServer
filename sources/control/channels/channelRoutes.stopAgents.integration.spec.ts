/**
 * Emergency stop — POST /api/v1/workrooms/:wid/channels/:cid/stop-agents
 * (REAL Postgres integration).
 *
 * Slice 7 B2-c auth: user_sess_ (workroom OWNER) OR machine_token via authorizeChannelWrite.
 *
 * FAST MODE — only meaningful tests:
 *   - user-owner → 200 {ok:true} + agents.stop event written with channel_id + stopped_by
 *   - machine → 200 {ok:true}
 *   - user non-member → 403
 *   - no auth → 401
 *   - channel not in :wid → 404
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
const OTHER_WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let APP: FastifyInstance;
let CHANNEL_ID = '';
let OTHER_CHANNEL_ID = '';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });

function postStop(url: string, headers: Record<string, string>) {
  return APP.inject({ method: 'POST', url, headers });
}

beforeAll(async () => {
  APP = fastify();
  await APP.register(channelRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'StopAgentsSpec Org', slug: `stop-agents-${randomUUID()}`, ownerUserId: randomUUID() },
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'StopAgentsSpec WR', createdBy: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: OTHER_WORKROOM_ID, orgId: ORG_ID, name: 'StopAgentsSpec OtherWR', createdBy: randomUUID() },
  });

  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'stop-target', type: 'standard', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;

  const otherCh = await db.controlChannel.create({
    data: { workroomId: OTHER_WORKROOM_ID, name: 'stop-elsewhere', type: 'standard', visibility: 'public', createdBy: 'system' },
  });
  OTHER_CHANNEL_ID = otherCh.id;

  const owner = await db.user.create({
    data: { email: `stop-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
    data: { email: `stop-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── POST /api/v1/workrooms/:wid/channels/:cid/stop-agents ──────────────────────

describe('POST /api/v1/workrooms/:wid/channels/:cid/stop-agents', () => {
  it('user-owner stop: 200 {ok:true} + agents.stop event written with channel_id + stopped_by', async () => {
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/stop-agents`,
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'agents.stop' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.channel_id).toBe(CHANNEL_ID);
    expect(payload.stopped_by).toBe(OWNER_USER_ID);
  });

  it('machine stop: 200 {ok:true}', async () => {
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/stop-agents`,
      machineHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('user non-member → 403', async () => {
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/stop-agents`,
      nonMemberUserHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('no auth → 401', async () => {
    const res = await postStop(`/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/stop-agents`, {});
    expect(res.statusCode).toBe(401);
  });

  it('channel not in workroom → 404', async () => {
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${OTHER_CHANNEL_ID}/stop-agents`,
      ownerUserHeader(),
    );
    expect(res.statusCode).toBe(404);
  });
});
