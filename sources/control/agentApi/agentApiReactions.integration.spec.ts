/**
 * A2 — Agent API reaction routes integration tests.
 *
 * Endpoint under test:
 *   POST /internal/agent-api/messages/react
 *     { target, message_id, emoji, op: 'add' | 'remove' }
 *
 * Required cases:
 *   - add → reaction row exists + reaction.added event observed
 *   - duplicate add → idempotent (still exactly 1 row, returns ok)
 *   - remove → row gone + reaction.removed event
 *   - remove non-existent → ok no-op
 *   - react to a message NOT in the target channel → 404
 *   - non-member target → 404 NOT_A_MEMBER (resolveAgentChannelTarget enforces)
 *   - cross-machine agent (agent not owned by the authed machine) → 403 AGENT_NOT_OWNED
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/agentApi/agentApiReactions.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentApiReactions } from './agentApiReactions';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();        // owned by MACHINE_ID, member of CHANNEL_ID
const OTHER_AGENT_ID = randomUUID(); // owned by OTHER_MACHINE_ID

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let CHANNEL_ID = '';       // #react-test channel — AGENT_ID is a member
let OTHER_CHANNEL_ID = ''; // a channel AGENT_ID is NOT a member of
let MESSAGE_ID = '';       // message in CHANNEL_ID
let OTHER_CHANNEL_MESSAGE_ID = ''; // message in OTHER_CHANNEL_ID

let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ────────────────────────────────────────────────────────────────────

function headers(machineToken = MACHINE_RAW_TOKEN, agentId = AGENT_ID) {
  return {
    authorization: `Bearer ${machineToken}`,
    'x-mio-agent-id': agentId,
    'content-type': 'application/json',
  };
}

function post(url: string, body: Record<string, unknown>, h = headers()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: h,
    payload: JSON.stringify(body),
  });
}

/** Count reaction.* events in the event log for our workroom. */
async function reactionEventCount(topic: string): Promise<number> {
  return db.controlEventLog.count({ where: { workroomId: WORKROOM_ID, topic } });
}

/** Count reaction rows for a given message+agent+emoji triple. */
async function reactionRowCount(messageId: string, reactorId: string, emoji: string): Promise<number> {
  return db.controlMessageReaction.count({
    where: { messageId, reactorId, emoji },
  });
}

function react(opts: {
  target?: string;
  message_id?: string;
  emoji?: string;
  op?: string;
  machineToken?: string;
  agentId?: ReturnType<typeof randomUUID>;
}) {
  const h = headers(opts.machineToken ?? MACHINE_RAW_TOKEN, opts.agentId ?? AGENT_ID);
  return post('/internal/agent-api/messages/react', {
    target: opts.target ?? '#react-test',
    message_id: opts.message_id ?? MESSAGE_ID,
    emoji: opts.emoji ?? '👍',
    op: opts.op ?? 'add',
  }, h);
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentApiReactions);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'AgentApiReactions Org',
      slug: `agent-api-reactions-${randomUUID()}`,
      ownerUserId: randomUUID(),
    },
  });

  await db.controlMachine.create({
    data: {
      id: MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(MACHINE_RAW_TOKEN),
      tokenExpiresAt,
      platform: 'darwin',
      arch: 'arm64',
    },
  });
  await db.controlMachine.create({
    data: {
      id: OTHER_MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN),
      tokenExpiresAt,
      platform: 'darwin',
      arch: 'arm64',
    },
  });

  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentApiReactions WR', createdBy: randomUUID() },
  });

  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'ReactTestAgent',
      displayName: 'ReactTestAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });
  await db.controlAgent.create({
    data: {
      id: OTHER_AGENT_ID,
      orgId: ORG_ID,
      machineId: OTHER_MACHINE_ID,
      name: 'OtherReactAgent',
      displayName: 'OtherReactAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // #react-test channel — AGENT_ID is a member
  const ch = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'react-test',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  CHANNEL_ID = ch.id;
  await db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId: AGENT_ID } });

  // Non-member channel
  const otherCh = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'no-member-reactions',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  OTHER_CHANNEL_ID = otherCh.id;

  // Seed a message in CHANNEL_ID for the agent to react to
  const msg = await db.controlMessage.create({
    data: {
      workroomId: WORKROOM_ID,
      channelId: CHANNEL_ID,
      seq: 1,
      senderKind: 'agent',
      senderId: AGENT_ID,
      content: 'Hello from setup',
      mentions: [],
    },
  });
  MESSAGE_ID = msg.id;

  // Seed a message in OTHER_CHANNEL_ID (AGENT_ID is not a member of this channel)
  const otherMsg = await db.controlMessage.create({
    data: {
      workroomId: WORKROOM_ID,
      channelId: OTHER_CHANNEL_ID,
      seq: 1,
      senderKind: 'agent',
      senderId: OTHER_AGENT_ID,
      content: 'Message in non-member channel',
      mentions: [],
    },
  });
  OTHER_CHANNEL_MESSAGE_ID = otherMsg.id;
});

afterAll(async () => {
  await db.controlMessageReaction.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── POST /internal/agent-api/messages/react ───────────────────────────────────

describe('POST /internal/agent-api/messages/react', () => {
  it('add → reaction row exists + reaction.added event observed', async () => {
    const before = await reactionEventCount('reaction.added');

    const res = await react({ op: 'add', emoji: '🎉' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // DB: reaction row created
    const count = await reactionRowCount(MESSAGE_ID, AGENT_ID, '🎉');
    expect(count).toBe(1);

    // Event log: reaction.added event emitted
    expect(await reactionEventCount('reaction.added')).toBe(before + 1);

    // Verify event payload
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'reaction.added' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(MESSAGE_ID);
    expect(payload.emoji).toBe('🎉');
    expect(payload.reactor_id).toBe(AGENT_ID);
    expect(payload.reactor_kind).toBe('agent');
  });

  it('duplicate add → idempotent (still exactly 1 row, returns ok, NO second event)', async () => {
    // First add (may already exist from previous test — use distinct emoji)
    await react({ op: 'add', emoji: '🔥' });
    const afterFirst = await reactionRowCount(MESSAGE_ID, AGENT_ID, '🔥');
    expect(afterFirst).toBe(1);

    // Capture reaction.added event count BEFORE the duplicate add.
    const eventsBeforeDup = await reactionEventCount('reaction.added');

    // Second add (duplicate) — should be idempotent
    const res = await react({ op: 'add', emoji: '🔥' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // Still exactly 1 row
    const afterSecond = await reactionRowCount(MESSAGE_ID, AGENT_ID, '🔥');
    expect(afterSecond).toBe(1);

    // The duplicate add (P2002 path) must NOT emit a second reaction.added event.
    expect(await reactionEventCount('reaction.added')).toBe(eventsBeforeDup);
  });

  it('remove → row gone + reaction.removed event', async () => {
    // First add the reaction
    await react({ op: 'add', emoji: '❤️' });
    expect(await reactionRowCount(MESSAGE_ID, AGENT_ID, '❤️')).toBe(1);

    const beforeRemove = await reactionEventCount('reaction.removed');

    const res = await react({ op: 'remove', emoji: '❤️' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // Row is gone
    expect(await reactionRowCount(MESSAGE_ID, AGENT_ID, '❤️')).toBe(0);

    // reaction.removed event emitted
    expect(await reactionEventCount('reaction.removed')).toBe(beforeRemove + 1);

    // Verify event payload
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'reaction.removed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(MESSAGE_ID);
    expect(payload.emoji).toBe('❤️');
    expect(payload.reactor_id).toBe(AGENT_ID);
    expect(payload.reactor_kind).toBe('agent');
  });

  it('remove non-existent → ok no-op (NO event emitted)', async () => {
    // Ensure no row exists for this emoji first
    await db.controlMessageReaction.deleteMany({
      where: { messageId: MESSAGE_ID, reactorId: AGENT_ID, emoji: '🤖' },
    });

    const beforeRemove = await reactionEventCount('reaction.removed');

    const res = await react({ op: 'remove', emoji: '🤖' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    // A remove of a non-existent reaction is a true no-op: deleteMany removed 0 rows,
    // so NO reaction.removed event must be emitted (else clients decrement a phantom).
    expect(await reactionEventCount('reaction.removed')).toBe(beforeRemove);
  });

  it('react to a message NOT in the target channel → 404', async () => {
    // OTHER_CHANNEL_MESSAGE_ID belongs to OTHER_CHANNEL_ID, not CHANNEL_ID (#react-test)
    const res = await react({
      target: '#react-test',
      message_id: OTHER_CHANNEL_MESSAGE_ID,
      op: 'add',
      emoji: '👍',
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('MESSAGE_NOT_IN_CHANNEL');
  });

  it('non-member target → 404 NOT_A_MEMBER', async () => {
    const res = await react({
      target: '#no-member-reactions',
      op: 'add',
      emoji: '👍',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it("cross-machine agent (agent not owned by the authed machine) → 403 AGENT_NOT_OWNED", async () => {
    const res = await react({
      op: 'add',
      emoji: '👍',
      machineToken: MACHINE_RAW_TOKEN,
      agentId: OTHER_AGENT_ID, // agent owned by OTHER_MACHINE, but token is MACHINE
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });
});
