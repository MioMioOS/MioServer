/**
 * S5 Activity feed — control plane (REAL Postgres integration).
 *
 * Covers:
 *   GET  /api/v1/workrooms/:wid/activity?filter=all|unread|mentions
 *        → { activity: [{ id, message_id, handled }] }
 *   POST /api/v1/workrooms/:wid/activity/:messageId/handled  body { handled }
 *        → upsert ControlActivityState; { ok: true }
 *
 * Auth:
 *   GET  /activity         → authorizeControlRead (machine OR dev_ctl_; dev allowlisted).
 *   POST /activity/.../handled → op_sess_('mark_reviewed') OR machine; dev_ctl_ → 403.
 *
 * Caller key (subject) for the mention match + handled join:
 *   machine → machine.id (and the machine's ControlAgent.id if one exists — both queried).
 *   dev_ctl_ → NO subject → debug view: messages with ANY non-empty mentions (disclosed).
 *
 * Behaviour verified here:
 *   - a mention to the caller appears in the activity list (machine subject)
 *   - the machine's ControlAgent.id is ALSO matched (mention to agent id → appears)
 *   - a non-mention (or mention to someone else) is excluded
 *   - reply (parentMessageId set) is excluded from the activity feed
 *   - unread filter hides handled items; all/mentions show them
 *   - POST handled then unread excludes it (and a 2nd POST is an idempotent upsert)
 *   - POST handled=false flips it back (unread shows it again)
 *   - dev_ctl_ → 403 on POST handled
 *   - POST handled on a message not in :wid → 404
 *   - dev_ctl_ GET returns any-mention debug view
 *   - GET /activity with no auth → 401
 *   - id shape is "act_" + messageId
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { messageRoutes } from './messageRoutes';
import { mintOperatorSession, V1_OPERATOR_COMMANDS } from '@/control/operatorSessions/operatorSessionMint';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID(); // ControlAgent for the machine (machineId = MACHINE_ID)
const OTHER_SUBJECT = randomUUID(); // a different caller's id (mentions to them must NOT show for the machine); mentions is uuid[]
const OPERATOR_SUBJECT_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let OP_SESS_RAW_TOKEN = '';
let CHANNEL_ID = '';
let MSG_MENTION_MACHINE = ''; // mentions MACHINE_ID
let MSG_MENTION_AGENT = '';   // mentions AGENT_ID (the machine's agent)
let MSG_NO_MENTION = '';      // mentions OTHER_SUBJECT only → excluded for the machine
let MSG_REPLY_MENTION = '';   // mentions MACHINE_ID but is a reply (parentMessageId set) → excluded
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const devCtlHeader = () => ({ authorization: `Bearer ${DEV_CTL_RAW_TOKEN}` });

function injectGet(url: string, headers: Record<string, string>) {
  return APP.inject({ method: 'GET', url, headers });
}

function injectPostJson(url: string, headers: Record<string, string>, body: unknown) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

let seq = 1;
async function seedMessage(opts: {
  mentions: string[];
  parentMessageId?: string;
}): Promise<string> {
  const row = await db.controlMessage.create({
    data: {
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      seq: BigInt(seq++),
      senderKind: 'user',
      senderId: OPERATOR_SUBJECT_ID,
      content: 'activity seed',
      mentions: opts.mentions,
      parentMessageId: opts.parentMessageId ?? null,
    },
  });
  return row.id;
}

function activityIds(body: string): string[] {
  return JSON.parse(body).activity.map((a: { message_id: string }) => a.message_id);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'ActivitySpec Org', slug: `activity-${randomUUID()}`, ownerUserId: randomUUID() },
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
  // ControlAgent bound to this machine → the activity route must ALSO match mentions to AGENT_ID.
  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      name: 'agent-for-machine',
      displayName: 'Agent For Machine',
      role: 'engineer',
      machineId: MACHINE_ID,
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'ActivitySpec WR', createdBy: randomUUID() },
  });

  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;

  MSG_MENTION_MACHINE = await seedMessage({ mentions: [MACHINE_ID] });
  MSG_MENTION_AGENT = await seedMessage({ mentions: [AGENT_ID] });
  MSG_NO_MENTION = await seedMessage({ mentions: [OTHER_SUBJECT] });
  // A reply that mentions the machine — must be excluded from the activity feed (parent set).
  MSG_REPLY_MENTION = await seedMessage({ mentions: [MACHINE_ID], parentMessageId: MSG_MENTION_MACHINE });

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
  await db.controlActivityState.deleteMany({ where: { messageId: { in: [MSG_MENTION_MACHINE, MSG_MENTION_AGENT] } } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlDevToken.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── GET /activity ───────────────────────────────────────────────────────────────

describe('S5 activity feed — GET', () => {
  it('a mention to the caller (machine.id) appears; id is act_<messageId>; handled defaults false', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, machineHeader());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const entry = body.activity.find((a: { message_id: string }) => a.message_id === MSG_MENTION_MACHINE);
    expect(entry).toBeDefined();
    expect(entry.id).toBe(`act_${MSG_MENTION_MACHINE}`);
    expect(entry.handled).toBe(false);
  });

  it("also matches the machine's ControlAgent.id (mention to agent id appears)", async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, machineHeader());
    expect(activityIds(res.body)).toContain(MSG_MENTION_AGENT);
  });

  it('a mention to a different subject is excluded for the machine caller', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, machineHeader());
    expect(activityIds(res.body)).not.toContain(MSG_NO_MENTION);
  });

  it('a reply (parentMessageId set) is excluded from the activity feed', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, machineHeader());
    expect(activityIds(res.body)).not.toContain(MSG_REPLY_MENTION);
  });

  it('filter=mentions == filter=all (MVP)', async () => {
    const all = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, machineHeader());
    const mentions = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=mentions`, machineHeader());
    expect(activityIds(all.body).sort()).toEqual(activityIds(mentions.body).sort());
  });

  it('GET /activity with no auth → 401', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, {});
    expect(res.statusCode).toBe(401);
  });

  it('dev_ctl_ GET returns the any-mention debug view (no subject)', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, devCtlHeader());
    expect(res.statusCode).toBe(200);
    const ids = activityIds(res.body);
    // dev_ctl_ sees ALL messages with any non-empty mentions in visible channels.
    expect(ids).toContain(MSG_MENTION_MACHINE);
    expect(ids).toContain(MSG_MENTION_AGENT);
    expect(ids).toContain(MSG_NO_MENTION); // mentions OTHER_SUBJECT (still a non-empty mention)
    expect(ids).not.toContain(MSG_REPLY_MENTION); // replies still excluded
  });
});

// ── POST /activity/:messageId/handled + unread filter ───────────────────────────

describe('S5 activity feed — POST handled + unread filter', () => {
  it('unread shows the mention before it is handled', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=unread`, machineHeader());
    expect(activityIds(res.body)).toContain(MSG_MENTION_MACHINE);
  });

  it('POST handled (machine) then unread excludes it; all still shows it as handled=true', async () => {
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${MSG_MENTION_MACHINE}/handled`,
      machineHeader(),
      { handled: true },
    );
    expect(post.statusCode).toBe(200);
    expect(JSON.parse(post.body).ok).toBe(true);

    // DB row exists, scoped to the machine subject.
    const row = await db.controlActivityState.findFirst({
      where: { subjectId: MACHINE_ID, messageId: MSG_MENTION_MACHINE },
    });
    expect(row?.handled).toBe(true);

    const unread = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=unread`, machineHeader());
    expect(activityIds(unread.body)).not.toContain(MSG_MENTION_MACHINE);

    const all = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, machineHeader());
    const entry = JSON.parse(all.body).activity.find((a: { message_id: string }) => a.message_id === MSG_MENTION_MACHINE);
    expect(entry.handled).toBe(true);
  });

  it('POST handled is an idempotent upsert (second POST → 200, single row)', async () => {
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${MSG_MENTION_MACHINE}/handled`,
      machineHeader(),
      { handled: true },
    );
    expect(post.statusCode).toBe(200);
    const count = await db.controlActivityState.count({
      where: { subjectId: MACHINE_ID, messageId: MSG_MENTION_MACHINE },
    });
    expect(count).toBe(1);
  });

  it('POST handled=false flips it back (unread shows it again)', async () => {
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${MSG_MENTION_MACHINE}/handled`,
      machineHeader(),
      { handled: false },
    );
    expect(post.statusCode).toBe(200);
    const unread = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=unread`, machineHeader());
    expect(activityIds(unread.body)).toContain(MSG_MENTION_MACHINE);
  });

  it('op_sess_(mark_reviewed) can POST handled', async () => {
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${MSG_MENTION_AGENT}/handled`,
      { authorization: `Bearer ${OP_SESS_RAW_TOKEN}` },
      { handled: true },
    );
    expect(post.statusCode).toBe(200);
    const row = await db.controlActivityState.findFirst({
      where: { subjectId: OPERATOR_SUBJECT_ID, messageId: MSG_MENTION_AGENT },
    });
    expect(row?.handled).toBe(true);
  });

  it('dev_ctl_ → 403 on POST handled', async () => {
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${MSG_MENTION_MACHINE}/handled`,
      devCtlHeader(),
      { handled: true },
    );
    expect(post.statusCode).toBe(403);
  });

  it('POST handled on a message not in :wid → 404', async () => {
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${randomUUID()}/handled`,
      machineHeader(),
      { handled: true },
    );
    expect(post.statusCode).toBe(404);
  });
});
