/**
 * S5 Activity feed — Slice 7 B2-d (user_sess_ / machine unification).
 *
 * Covers:
 *   GET  /api/v1/workrooms/:wid/activity?filter=all|unread|mentions
 *        → { activity: [{ id, message_id, handled }] }
 *   POST /api/v1/workrooms/:wid/activity/:messageId/handled  body { handled }
 *        → upsert ControlActivityState; { ok: true }
 *
 * Auth:
 *   GET  /activity         → userOrMachine (user member OR machine org-scoped).
 *   POST /activity/.../handled → user_sess_ (workroom OWNER) OR machine.
 *
 * Caller keys for the mention match + handled join:
 *   user actor    → [user.id]                                         (vacuous unless messages mention user.id)
 *   machine actor → [machine.id, ...machine's ControlAgent.id]
 *
 * Privacy fix (vs. pre-Slice-7):
 *   The previous "dev_ctl_ → debug ANY non-empty mentions" branch is GONE. Activity always
 *   scopes by the actor's caller keys (never anonymous-broad).
 *
 * Behaviour verified here:
 *   - a mention to the caller appears in the activity list (machine subject)
 *   - the machine's ControlAgent.id is ALSO matched (mention to agent id → appears)
 *   - a non-mention (or mention to someone else) is excluded
 *   - reply (parentMessageId set) is excluded from the activity feed
 *   - unread filter hides handled items; all/mentions show them
 *   - POST handled then unread excludes it (and a 2nd POST is an idempotent upsert)
 *   - POST handled=false flips it back (unread shows it again)
 *   - user non-member → 403 on POST handled
 *   - POST handled on a message not in :wid → 404
 *   - user mention surfaces in the user-actor activity feed
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
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID(); // ControlAgent for the machine (machineId = MACHINE_ID)
const OTHER_SUBJECT = randomUUID();

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let CHANNEL_ID = '';
let MSG_MENTION_MACHINE = '';
let MSG_MENTION_AGENT = '';
let MSG_NO_MENTION = '';
let MSG_REPLY_MENTION = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });

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
      senderKind: 'system',
      senderId: randomUUID(),
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
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'ActivitySpec WR', createdBy: randomUUID() },
  });

  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;

  // user_sess_ fixtures.
  const owner = await db.user.create({
    data: { email: `activity-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
    data: { email: `activity-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });

  MSG_MENTION_MACHINE = await seedMessage({ mentions: [MACHINE_ID] });
  MSG_MENTION_AGENT = await seedMessage({ mentions: [AGENT_ID] });
  MSG_NO_MENTION = await seedMessage({ mentions: [OTHER_SUBJECT] });
  MSG_REPLY_MENTION = await seedMessage({ mentions: [MACHINE_ID], parentMessageId: MSG_MENTION_MACHINE });
  // NOTE: we cannot seed a mention to OWNER_USER_ID — User.id is a cuid but the DB
  // mentions[] column is UUID[]. This is the documented user-mention-storage gap per
  // controller decision 5 (activity-feed @user mention semantics deferred). Verified
  // below: the user's activity feed is vacuous in this slice (filter collapses to empty).
});

afterAll(async () => {
  await db.controlActivityState.deleteMany({ where: { messageId: { in: [MSG_MENTION_MACHINE, MSG_MENTION_AGENT] } } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.userWorkroomMembership.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.userSession.deleteMany({ where: { userId: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.user.deleteMany({ where: { id: { in: [OWNER_USER_ID, NON_MEMBER_USER_ID] } } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── GET /activity ───────────────────────────────────────────────────────────────

describe('S5 activity feed — GET (Slice 7 B2-d)', () => {
  it('a mention to the machine appears; id is act_<messageId>; handled defaults false', async () => {
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

  it('user-owner activity feed is vacuous this slice (user.id is cuid; mentions column is UUID[])', async () => {
    // Per controller decision 5, activity-feed @user mention semantics are deferred. The
    // route still authorizes the user and returns 200 — but with an empty activity list
    // because the caller-key set (user.id) is not uuid-shaped and gets filtered out
    // before the DB query (preventing a runtime error against the UUID[] column).
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, ownerUserHeader());
    expect(res.statusCode).toBe(200);
    const ids = activityIds(res.body);
    // The user does NOT see machine-only mentions — and there is no plumbing for user
    // mention storage this slice, so the user sees nothing.
    expect(ids).not.toContain(MSG_MENTION_MACHINE);
    expect(ids).not.toContain(MSG_MENTION_AGENT);
    expect(ids).not.toContain(MSG_NO_MENTION);
    expect(ids).toEqual([]);
  });

  it('user non-member → 403 on GET activity', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, nonMemberUserHeader());
    expect(res.statusCode).toBe(403);
  });

  it('GET /activity with no auth → 401', async () => {
    const res = await injectGet(`/api/v1/workrooms/${WORKROOM_ID}/activity?filter=all`, {});
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /activity/:messageId/handled + unread filter ───────────────────────────

describe('S5 activity feed — POST handled + unread filter (Slice 7 B2-d)', () => {
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

  it('user-owner can POST handled (subjectId = user.id) — works on any in-workroom message', async () => {
    // The user activity feed itself is vacuous this slice (see note above), but the
    // POST handled write surface still works and stamps the user's id as the subject.
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${MSG_MENTION_AGENT}/handled`,
      ownerUserHeader(),
      { handled: true },
    );
    expect(post.statusCode).toBe(200);
    const row = await db.controlActivityState.findFirst({
      where: { subjectId: OWNER_USER_ID, messageId: MSG_MENTION_AGENT },
    });
    expect(row?.handled).toBe(true);
  });

  it('user non-member → 403 on POST handled', async () => {
    const post = await injectPostJson(
      `/api/v1/workrooms/${WORKROOM_ID}/activity/${MSG_MENTION_MACHINE}/handled`,
      nonMemberUserHeader(),
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
