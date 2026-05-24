/**
 * Emergency stop — POST /api/v1/workrooms/:wid/channels/:cid/stop-agents
 * (REAL Postgres integration).
 *
 * The channel-header "□ Stop all agents" emergency stop. A human operator (op_sess_)
 * — or a machine — hits this; the server writes + broadcasts an `agents.stop` event
 * scoped to the channel.
 *
 * FAST MODE — only meaningful tests:
 *   - V1_OPERATOR_COMMANDS includes 'stop_agents'
 *   - op_sess_('stop_agents') → 200 {ok:true} + agents.stop event written with channel_id
 *   - machine → 200 {ok:true}
 *   - dev_ctl_ → 403 (hard reject; POST, not on the GET allowlist)
 *   - channel not in :wid → 404
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
const OPERATOR_SUBJECT_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let OP_SESS_RAW_TOKEN = '';
let APP: FastifyInstance;
let CHANNEL_ID = '';
let OTHER_CHANNEL_ID = ''; // belongs to OTHER_WORKROOM_ID

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const opSessHeader = () => ({ authorization: `Bearer ${OP_SESS_RAW_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const devCtlHeader = () => ({ authorization: `Bearer ${DEV_CTL_RAW_TOKEN}` });

function postStop(url: string, headers: Record<string, string>) {
  return APP.inject({ method: 'POST', url, headers });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

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
  const wrIds = [WORKROOM_ID, OTHER_WORKROOM_ID];
  await db.controlEventLog.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: { in: wrIds } } } });
  await db.controlChannel.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: wrIds } } });
  await db.controlDevToken.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── V1_OPERATOR_COMMANDS includes stop_agents ─────────────────────────────────

describe('V1_OPERATOR_COMMANDS includes the emergency-stop command', () => {
  it("contains 'stop_agents'", () => {
    expect(V1_OPERATOR_COMMANDS).toContain('stop_agents');
  });
});

// ── POST /api/v1/workrooms/:wid/channels/:cid/stop-agents ──────────────────────

describe('POST /api/v1/workrooms/:wid/channels/:cid/stop-agents', () => {
  it('op_sess_ stop: 200 {ok:true} + agents.stop event written with channel_id', async () => {
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/stop-agents`,
      opSessHeader(),
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
    expect(payload.stopped_by).toBe(OPERATOR_SUBJECT_ID);
  });

  it('machine stop: 200 {ok:true}', async () => {
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/stop-agents`,
      machineHeader(),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('dev_ctl_ → 403 hard reject (POST is not on the dev GET allowlist)', async () => {
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${CHANNEL_ID}/stop-agents`,
      devCtlHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('channel not in workroom → 404', async () => {
    // OTHER_CHANNEL_ID belongs to OTHER_WORKROOM_ID but request targets WORKROOM_ID.
    const res = await postStop(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${OTHER_CHANNEL_ID}/stop-agents`,
      opSessHeader(),
    );
    expect(res.statusCode).toBe(404);
  });
});
