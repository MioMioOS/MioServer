/**
 * S5 Saved messages — Slice 7 B2-d (user_sess_ / machine unification).
 *
 * Covers:
 *   POST   /api/v1/workrooms/:wid/messages/:id/save   → save (idempotent)
 *   DELETE /api/v1/workrooms/:wid/messages/:id/save   → unsave (idempotent)
 *   GET    /api/v1/workrooms/:wid/saved               → caller's saved list, newest first
 *
 * Auth:
 *   save/unsave: user_sess_ (workroom OWNER) OR machine. user non-member → 403.
 *   GET /saved:  userOrMachine (user member OR machine org-scoped).
 *
 * Privacy fix (vs. pre-Slice-7):
 *   The previous "dev_ctl_ no-subject → return ALL workroom saves (debug)" branch is gone.
 *   GET /saved always scopes by the actor's viewerId (user.id or machine.id). A user only
 *   sees their own saves; a machine only sees its own saves.
 *
 * Behaviour:
 *   - save then GET saved returns it (subject-scoped, per actor)
 *   - idempotent double-save → 200, single row
 *   - unsave removes it; unsave-missing → 200 no-op
 *   - user non-member → 403 on save
 *   - message-not-in-workroom → 404 on save
 *   - GET /saved requires auth (401 with no token)
 *   - GET /saved scopes by actor (user sees only their own saves; machine sees only its own)
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

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let NON_MEMBER_USER_ID = '';
let NON_MEMBER_USER_TOKEN = '';
let CHANNEL_ID = '';
let MSG_A = '';
let MSG_B = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const ownerUserHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });
const nonMemberUserHeader = () => ({ authorization: `Bearer ${NON_MEMBER_USER_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });

function inject(method: 'POST' | 'DELETE' | 'GET', url: string, headers: Record<string, string>) {
  // No JSON body for save/unsave/list — do NOT set content-type (Fastify rejects an
  // empty body with content-type: application/json as a 400 parse error).
  return APP.inject({ method, url, headers });
}

async function seedMessage(content: string): Promise<string> {
  const row = await db.controlMessage.create({
    data: {
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      seq: BigInt(Date.now() % 1_000_000) + BigInt(Math.floor(Math.random() * 1000)),
      senderKind: 'system',
      senderId: randomUUID(),
      content,
    },
  });
  return row.id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'SavedSpec Org', slug: `saved-${randomUUID()}`, ownerUserId: randomUUID() },
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'SavedSpec WR', createdBy: randomUUID() },
  });

  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;

  MSG_A = await seedMessage('Message A');
  MSG_B = await seedMessage('Message B');

  // user_sess_ fixtures.
  const owner = await db.user.create({
    data: { email: `saved-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
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
    data: { email: `saved-nm-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  NON_MEMBER_USER_ID = nm.id;
  NON_MEMBER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: NON_MEMBER_USER_ID, tokenHash: hashUserSessionToken(NON_MEMBER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
});

afterAll(async () => {
  await db.controlSavedMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
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

// ── save → GET saved ──────────────────────────────────────────────────────────

describe('S5 saved messages (Slice 7 B2-d)', () => {
  it('user-owner save then user GET saved returns it (subject-scoped, { id, message_id } shape)', async () => {
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_A}/save`, ownerUserHeader());
    expect(save.statusCode).toBe(200);
    expect(JSON.parse(save.body).ok).toBe(true);

    // Row exists scoped to the user.id subject.
    const row = await db.controlSavedMessage.findFirst({
      where: { subjectId: OWNER_USER_ID, messageId: MSG_A },
    });
    expect(row).not.toBeNull();

    // User's own GET returns it.
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, ownerUserHeader());
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body);
    expect(Array.isArray(body.saved)).toBe(true);
    const entry = body.saved.find((s: { message_id: string }) => s.message_id === MSG_A);
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('message_id');
  });

  it('idempotent double-save → 200, single row', async () => {
    const url = `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_B}/save`;
    const r1 = await inject('POST', url, ownerUserHeader());
    const r2 = await inject('POST', url, ownerUserHeader());
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await db.controlSavedMessage.count({
      where: { subjectId: OWNER_USER_ID, messageId: MSG_B },
    });
    expect(rows).toBe(1);
  });

  it('user GET /saved is newest-first', async () => {
    // MSG_B was saved after MSG_A → MSG_B should appear before MSG_A in the user's list.
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, ownerUserHeader());
    expect(list.statusCode).toBe(200);
    const ids = JSON.parse(list.body).saved.map((s: { message_id: string }) => s.message_id);
    const idxA = ids.indexOf(MSG_A);
    const idxB = ids.indexOf(MSG_B);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA); // B (saved later) is newer → earlier in list
  });

  it('unsave removes the saved message', async () => {
    const url = `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_A}/save`;
    const del = await inject('DELETE', url, ownerUserHeader());
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).ok).toBe(true);

    const row = await db.controlSavedMessage.findFirst({
      where: { subjectId: OWNER_USER_ID, messageId: MSG_A },
    });
    expect(row).toBeNull();
  });

  it('unsave missing → 200 no-op', async () => {
    const del = await inject('DELETE', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_A}/save`, ownerUserHeader());
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).ok).toBe(true);
  });

  it('machine can save (subjectId = machine.id) and machine GET is subject-scoped', async () => {
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_A}/save`, machineHeader());
    expect(save.statusCode).toBe(200);

    const row = await db.controlSavedMessage.findFirst({
      where: { subjectId: MACHINE_ID, messageId: MSG_A },
    });
    expect(row).not.toBeNull();

    // Machine's GET saved sees only machine-subject saves (subject-scoped).
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, machineHeader());
    expect(list.statusCode).toBe(200);
    const ids = JSON.parse(list.body).saved.map((s: { message_id: string }) => s.message_id);
    expect(ids).toContain(MSG_A); // machine saved this
    expect(ids).not.toContain(MSG_B); // MSG_B was a user-subject save → not visible to machine
  });

  it('user non-member → 403 on save', async () => {
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_B}/save`, nonMemberUserHeader());
    expect(save.statusCode).toBe(403);
  });

  it('user non-member → 403 on unsave', async () => {
    const del = await inject('DELETE', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_B}/save`, nonMemberUserHeader());
    expect(del.statusCode).toBe(403);
  });

  it('save message not in workroom → 404', async () => {
    const otherWr = randomUUID();
    await db.controlWorkroom.create({
      data: { id: otherWr, orgId: ORG_ID, name: 'Other WR', createdBy: randomUUID() },
    });
    const otherCh = await db.controlChannel.create({
      data: { workroomId: otherWr, name: 'other', type: 'main', visibility: 'public', createdBy: 'system' },
    });
    const otherMsg = await db.controlMessage.create({
      data: {
        workroomId: otherWr, channelId: otherCh.id, seq: 1n,
        senderKind: 'system', senderId: randomUUID(), content: 'elsewhere',
      },
    });

    // Save it under WORKROOM_ID (mismatch) → 404.
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${otherMsg.id}/save`, ownerUserHeader());
    expect(save.statusCode).toBe(404);

    await db.controlMessage.deleteMany({ where: { id: otherMsg.id } });
    await db.controlChannel.deleteMany({ where: { id: otherCh.id } });
    await db.controlWorkroom.deleteMany({ where: { id: otherWr } });
  });

  it('save nonexistent message → 404', async () => {
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${randomUUID()}/save`, ownerUserHeader());
    expect(save.statusCode).toBe(404);
  });

  it('GET /saved with no auth → 401', async () => {
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, {});
    expect(list.statusCode).toBe(401);
  });

  it('user GET /saved is scoped to the user (does NOT see the machine subject saves)', async () => {
    // At this point MACHINE saved MSG_A under its own subject (above). The user's GET must NOT
    // include MSG_A under MACHINE's subject — only the user's own saves.
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, ownerUserHeader());
    expect(list.statusCode).toBe(200);
    const ids = JSON.parse(list.body).saved.map((s: { message_id: string }) => s.message_id);
    // MSG_A was unsaved under the user subject earlier → must not appear.
    expect(ids).not.toContain(MSG_A);
    // MSG_B is still saved under the user subject.
    expect(ids).toContain(MSG_B);
  });
});
