/**
 * Slice 4.2 Chunk D — operator fulfill / dismiss of prepared actions (REAL Postgres).
 *
 * The HUMAN operator (user_sess_ workroom owner) approves or dismisses an agent's
 * proposed privileged action. The agent NEVER fulfills its own proposal (these are
 * /api/v1 operator routes gated by authorizeChannelWrite, not /internal/agent-api).
 *
 * Slice 7 B2-c: auth is user_sess_ (workroom OWNER) OR machine_token (via the rewritten
 * authorizeChannelWrite helper). Per-command granularity is gone — limited-command op_sess_
 * tests retired with Slice 7's auth unification.
 *
 *   POST /api/v1/workrooms/:wid/actions/:id/fulfill
 *   POST /api/v1/workrooms/:wid/actions/:id/dismiss
 *
 * Covered:
 *   - fulfill channel:create → 200; REAL channel created (created_by = operator subject);
 *     status=fulfilled, fulfilledByOperator=operator, fulfilledResultId=new channel id;
 *     ✅ result system message in the card's channel; channel.created event written.
 *   - fulfill channel:add_member → 200; member REALLY added; channel.member_added event;
 *     status=fulfilled, fulfilledResultId=stored channelId.
 *   - double fulfill → 409 ACTION_ALREADY_RESOLVED; fulfill-after-dismiss → 409.
 *   - fulfill nonexistent id → 404 ACTION_NOT_FOUND.
 *   - ROLLBACK: fulfill add_member whose channel was deleted post-prepare → 404 AND the
 *     prepared-action STAYS 'proposed' (proves atomic rollback, no phantom fulfilled).
 *   - dismiss → status=dismissed, NO channel created / member added; double dismiss → 409.
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { channelRoutes } from '@/control/channels/channelRoutes';
import { preparedActionOperatorRoutes } from './preparedActionOperatorRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();
const AGENT_ID = randomUUID();          // proposerAgentId
const MEMBER_AGENT_ID = randomUUID();   // the member to add (channel:add_member)

let CARD_CHANNEL_ID = '';  // the card surface channel (where 🔧/✅ cards land)

let OWNER_USER_ID = '';
let OWNER_USER_TOKEN = '';
let APP: FastifyInstance;

// ── Helpers ───────────────────────────────────────────────────────────────────

const fullHeader = () => ({ authorization: `Bearer ${OWNER_USER_TOKEN}` });

function post(url: string, headers: Record<string, string> = fullHeader()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({}),
  });
}

/** Seed a fresh standard channel in WORKROOM_ID. */
async function seedChannel(name: string): Promise<string> {
  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name, type: 'standard', visibility: 'public', createdBy: 'system' },
  });
  return ch.id;
}

/** Seed a prepared action (proposed) of the given type with normalized params. */
async function seedPreparedAction(
  type: 'channel:create' | 'channel:add_member',
  params: Record<string, unknown>,
): Promise<string> {
  const row = await db.controlPreparedAction.create({
    data: {
      workroomId: WORKROOM_ID,
      channelId: CARD_CHANNEL_ID,
      proposerAgentId: AGENT_ID,
      type,
      params: params as Prisma.InputJsonObject,
      status: 'proposed',
      cardMessageId: null,
    },
  });
  return row.id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(channelRoutes); // direct channel routes regression co-registration
  await APP.register(preparedActionOperatorRoutes);
  await APP.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'PrepOp Org', slug: `prep-op-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'PrepOp WR', createdBy: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: OTHER_WORKROOM_ID, orgId: ORG_ID, name: 'PrepOp OtherWR', createdBy: randomUUID() },
  });

  await db.controlAgent.create({
    data: { id: AGENT_ID, orgId: ORG_ID, name: 'proposer', displayName: 'Proposer', role: 'ops' },
  });
  await db.controlAgent.create({
    data: { id: MEMBER_AGENT_ID, orgId: ORG_ID, name: 'addme', displayName: 'AddMe', role: 'engineer' },
  });

  CARD_CHANNEL_ID = await seedChannel('cards');

  const owner = await db.user.create({
    data: { email: `prep-op-owner-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  OWNER_USER_ID = owner.id;
  OWNER_USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: OWNER_USER_ID, tokenHash: hashUserSessionToken(OWNER_USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.userWorkroomMembership.create({
    data: { userId: OWNER_USER_ID, workroomId: WORKROOM_ID, role: 'owner' },
  });
});

afterAll(async () => {
  const wrIds = [WORKROOM_ID, OTHER_WORKROOM_ID];
  await db.controlPreparedAction.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlMessage.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlEventLog.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: { in: wrIds } } } });
  await db.controlChannel.deleteMany({ where: { workroomId: { in: wrIds } } });
  await db.controlAgent.deleteMany({ where: { id: { in: [AGENT_ID, MEMBER_AGENT_ID] } } });
  await db.userWorkroomMembership.deleteMany({ where: { userId: OWNER_USER_ID } });
  await db.userSession.deleteMany({ where: { userId: OWNER_USER_ID } });
  await db.user.deleteMany({ where: { id: OWNER_USER_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: wrIds } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── fulfill channel:create ──────────────────────────────────────────────────────

describe('POST /actions/:id/fulfill — channel:create', () => {
  it('200; REAL channel created (created_by=operator); status=fulfilled + result fields; ✅ card', async () => {
    const id = await seedPreparedAction('channel:create', { name: 'launch', visibility: 'private' });

    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/fulfill`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.action.status).toBe('fulfilled');

    // A REAL channel was created under the operator's identity.
    const newChannelId = body.action.fulfilledResultId as string;
    const ch = await db.controlChannel.findUnique({ where: { id: newChannelId } });
    expect(ch).not.toBeNull();
    expect(ch!.name).toBe('launch');
    expect(ch!.visibility).toBe('private');
    expect(ch!.createdBy).toBe(OWNER_USER_ID);

    // Prepared-action result fields.
    const updated = await db.controlPreparedAction.findUnique({ where: { id } });
    expect(updated!.status).toBe('fulfilled');
    expect(updated!.fulfilledByOperator).toBe(OWNER_USER_ID);
    expect(updated!.fulfilledResultId).toBe(newChannelId);

    // channel.created event written.
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'channel.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect((event!.payloadJson as Record<string, unknown>).channel_id).toBe(newChannelId);

    // ✅ result system message posted in the card's channel.
    const card = await db.controlMessage.findFirst({
      where: { workroomId: WORKROOM_ID, channelId: CARD_CHANNEL_ID, senderKind: 'system', content: { contains: '✅' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(card).not.toBeNull();
    expect(card!.content).toContain('launch');
  });

  it('double fulfill → 409 ACTION_ALREADY_RESOLVED', async () => {
    const id = await seedPreparedAction('channel:create', { name: 'twice', visibility: 'public' });
    const r1 = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/fulfill`);
    expect(r1.statusCode).toBe(200);
    const r2 = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/fulfill`);
    expect(r2.statusCode).toBe(409);
    expect(JSON.parse(r2.body).error.code).toBe('ACTION_ALREADY_RESOLVED');
  });

  it('nonexistent id → 404 ACTION_NOT_FOUND', async () => {
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${randomUUID()}/fulfill`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('ACTION_NOT_FOUND');
  });
});

// ── fulfill channel:add_member ──────────────────────────────────────────────────

describe('POST /actions/:id/fulfill — channel:add_member', () => {
  it('200; member REALLY added; channel.member_added event; status=fulfilled', async () => {
    const targetChannelId = await seedChannel('addtarget');
    const id = await seedPreparedAction('channel:add_member', {
      channel: '#addtarget',
      channelId: targetChannelId,
      member_id: MEMBER_AGENT_ID,
    });

    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/fulfill`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action.status).toBe('fulfilled');
    expect(body.action.fulfilledResultId).toBe(targetChannelId);
    expect(body.action.fulfilledByOperator).toBe(OWNER_USER_ID);

    // Member row really exists.
    const row = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId: targetChannelId, memberId: MEMBER_AGENT_ID } },
    });
    expect(row).not.toBeNull();

    // channel.member_added event.
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'channel.member_added' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.channel_id).toBe(targetChannelId);
    expect(payload.member_id).toBe(MEMBER_AGENT_ID);
  });

  it('ROLLBACK: channel deleted post-prepare → 404 AND status STAYS proposed', async () => {
    const goneChannelId = await seedChannel('willvanish');
    const id = await seedPreparedAction('channel:add_member', {
      channel: '#willvanish',
      channelId: goneChannelId,
      member_id: MEMBER_AGENT_ID,
    });
    // Delete the channel after the prepared-action was created.
    await db.controlChannel.delete({ where: { id: goneChannelId } });

    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/fulfill`);
    expect(res.statusCode).toBe(404);

    // The atomic rollback restored status to 'proposed' (no phantom fulfilled).
    const row = await db.controlPreparedAction.findUnique({ where: { id } });
    expect(row!.status).toBe('proposed');
    expect(row!.fulfilledByOperator).toBeNull();
    expect(row!.fulfilledResultId).toBeNull();
  });

});

// ── dismiss ─────────────────────────────────────────────────────────────────────

describe('POST /actions/:id/dismiss', () => {
  it('dismiss → status=dismissed, no channel created / member added', async () => {
    const id = await seedPreparedAction('channel:create', { name: 'nope', visibility: 'public' });
    const res = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/dismiss`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const row = await db.controlPreparedAction.findUnique({ where: { id } });
    expect(row!.status).toBe('dismissed');

    // No channel named 'nope' was created.
    const ch = await db.controlChannel.findFirst({ where: { workroomId: WORKROOM_ID, name: 'nope' } });
    expect(ch).toBeNull();

    // 🚫 dismiss card posted.
    const card = await db.controlMessage.findFirst({
      where: { workroomId: WORKROOM_ID, channelId: CARD_CHANNEL_ID, senderKind: 'system', content: { contains: '🚫' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(card).not.toBeNull();
  });

  it('double dismiss → 409 ACTION_ALREADY_RESOLVED', async () => {
    const id = await seedPreparedAction('channel:create', { name: 'dis2', visibility: 'public' });
    const r1 = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/dismiss`);
    expect(r1.statusCode).toBe(200);
    const r2 = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/dismiss`);
    expect(r2.statusCode).toBe(409);
    expect(JSON.parse(r2.body).error.code).toBe('ACTION_ALREADY_RESOLVED');
  });

  it('fulfill after dismiss → 409 ACTION_ALREADY_RESOLVED', async () => {
    const id = await seedPreparedAction('channel:create', { name: 'disfirst', visibility: 'public' });
    const rd = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/dismiss`);
    expect(rd.statusCode).toBe(200);
    const rf = await post(`/api/v1/workrooms/${WORKROOM_ID}/actions/${id}/fulfill`);
    expect(rf.statusCode).toBe(409);
    expect(JSON.parse(rf.body).error.code).toBe('ACTION_ALREADY_RESOLVED');
  });
});
