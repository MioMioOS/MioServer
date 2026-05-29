/**
 * Task 1.2 — POST /internal/agent-api/send (REAL Postgres integration).
 * Task 1.3 — GET  /internal/agent-api/history (REAL Postgres integration).
 *
 * POST /send covers:
 *   - happy path: #channel-name → 201 { id, seq }, message row has senderId=agent.id, senderKind='agent'
 *   - agent not a member of any channel named #name → 404 NOT_A_MEMBER
 *   - two channels both named #name with agent in both → 409 AMBIGUOUS_CHANNEL
 *   - target with thread suffix (#c:abcd1234) → 400 TARGET_UNSUPPORTED
 *   - target with dm: prefix (dm:@x) → 400 TARGET_UNSUPPORTED
 *   - not-owned agent (X-Mio-Agent-Id for agent owned by DIFFERENT machine) → 403 AGENT_NOT_OWNED
 *   - public channel where agent is NOT a member → 404 NOT_A_MEMBER
 *     (route enforces its own membership gate via the resolver, not sendMessageTransaction)
 *
 * GET /history covers:
 *   - after_seq → returns only newer messages, ascending, membership enforced
 *   - non-member channel → 404 NOT_A_MEMBER
 *   - around=<shortId> → centered window
 *   - around=<unknown shortId> → 404 MESSAGE_NOT_FOUND
 *   - no anchor → latest ≤20, seq-ascending
 *   - limit param → clamped
 *   - non-#name channel (dm: / thread :) → 400 TARGET_UNSUPPORTED
 *   - not-owned agent → 403 AGENT_NOT_OWNED
 *   - wire shape: sender_id / sender_kind / seq (string) / content / id / created_at present
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/agentApi/agentApiRoutes.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentApiRoutes } from './agentApiRoutes';

// ── Fixture IDs ───────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID(); // for the not-owned-agent test
const AGENT_ID = randomUUID();         // owned by MACHINE_ID, member of CHANNEL_ID
const OTHER_AGENT_ID = randomUUID();   // owned by OTHER_MACHINE_ID (for 403 test)

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let CHANNEL_ID = '';      // the happy-path channel: agent is a member
let CHANNEL_PUB_ID = '';  // a public channel where agent is NOT a member (404 NOT_A_MEMBER)
let HISTORY_CHANNEL_ID = ''; // dedicated channel for GET /history tests

// Message ids seeded into HISTORY_CHANNEL_ID (inserted in seq order)
const HISTORY_MSG_IDS: string[] = [];

// The human sender id used for wire-shape tests (non-agent sender)
const HUMAN_SENDER_ID = `user_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentApiHeaders(machineToken = MACHINE_RAW_TOKEN, agentId = AGENT_ID) {
  return {
    authorization: `Bearer ${machineToken}`,
    'x-mio-agent-id': agentId,
    'content-type': 'application/json',
  };
}

function post(body: Record<string, unknown>, headers = agentApiHeaders()) {
  return APP.inject({
    method: 'POST',
    url: '/internal/agent-api/send',
    headers,
    payload: JSON.stringify(body),
  });
}

function getHistory(params: Record<string, string | undefined>, headers = agentApiHeaders()) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join('&');
  return APP.inject({
    method: 'GET',
    url: `/internal/agent-api/history${qs ? `?${qs}` : ''}`,
    headers: { authorization: headers.authorization, 'x-mio-agent-id': headers['x-mio-agent-id'] },
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentApiRoutes);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  // Org
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'AgentApiSend Org', slug: `agent-api-send-${randomUUID()}`, ownerUserId: randomUUID() },
  });

  // Machines
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

  // Workroom
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentApiSend WR', createdBy: randomUUID() },
  });

  // Agents
  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'TestAgent',
      displayName: 'TestAgent',
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
      name: 'OtherAgent',
      displayName: 'OtherAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // Channels
  // Channel where AGENT_ID IS a member (happy path)
  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'agent-sends', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;
  await db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId: AGENT_ID } });

  // Public channel where AGENT_ID is NOT a member (should be 404 NOT_A_MEMBER)
  const pubCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'public-no-member', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_PUB_ID = pubCh.id;
  // Intentionally no ControlChannelMember row for AGENT_ID here.

  // History channel: AGENT_ID is a member; seed 5 messages (mix of agent + human sender)
  const histCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'agent-history', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  HISTORY_CHANNEL_ID = histCh.id;
  await db.controlChannelMember.create({ data: { channelId: HISTORY_CHANNEL_ID, memberId: AGENT_ID } });

  // Seed 5 messages with explicit seq values 1..5.
  // We insert directly via DB (inside transactions) to control seq + sender cleanly.
  const { nextChannelSeq } = await import('@/control/messages/channelSeq');
  for (let i = 1; i <= 5; i++) {
    const msgId = randomUUID();
    const senderKind = i % 2 === 0 ? 'user' : 'agent';
    const senderId = i % 2 === 0 ? HUMAN_SENDER_ID : AGENT_ID;
    await db.$transaction(async (tx) => {
      const seq = await nextChannelSeq(tx, HISTORY_CHANNEL_ID);
      await tx.controlMessage.create({
        data: {
          id: msgId,
          workroomId: WORKROOM_ID,
          channelId: HISTORY_CHANNEL_ID,
          seq,
          senderKind,
          senderId,
          content: `History message ${i}`,
          mentions: [],
          attachmentIds: [],
        },
      });
    });
    HISTORY_MSG_IDS.push(msgId);
  }
});

afterAll(async () => {
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /internal/agent-api/send', () => {
  it('happy path: #channel-name → 201 { id, seq }, message row has senderId=agent.id + senderKind=agent', async () => {
    const res = await post({ target: '#agent-sends', content: 'Hello from agent' });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(typeof body.id).toBe('string');
    expect(body).toHaveProperty('seq');
    expect(typeof body.seq).toBe('string');

    // Verify the stored message row
    const stored = await db.controlMessage.findUnique({
      where: { id: body.id },
      select: { senderId: true, senderKind: true, channelId: true, content: true },
    });
    expect(stored).not.toBeNull();
    expect(stored!.senderId).toBe(AGENT_ID);
    expect(stored!.senderKind).toBe('agent');
    expect(stored!.channelId).toBe(CHANNEL_ID);
    expect(stored!.content).toBe('Hello from agent');

    // Write-before-broadcast (spec §5.7): the message.created event row MUST exist
    // in the DB after the send, referencing the created message id. Without the
    // broadcast step the socket.io gateway never delivers the message to the daemon.
    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'message.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(body.id);
    expect(payload.channel_id).toBe(CHANNEL_ID);
    expect(payload.seq).toBe(body.seq);
    expect(payload.sender_kind).toBe('agent');
    expect(payload.sender_id).toBe(AGENT_ID);
  });

  it('agent not a member of any channel named #name → 404 NOT_A_MEMBER', async () => {
    const res = await post({ target: '#no-such-channel', content: 'Should fail' });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('NOT_A_MEMBER');
  });

  it('two channels both named #name with agent in both → 409 AMBIGUOUS_CHANNEL', async () => {
    // Seed a second channel with the same name and add agent as member of both
    const dup = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'agent-sends', type: 'standard', visibility: 'private', createdBy: 'system' },
    });
    await db.controlChannelMember.create({ data: { channelId: dup.id, memberId: AGENT_ID } });

    try {
      const res = await post({ target: '#agent-sends', content: 'Ambiguous target' });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('AMBIGUOUS_CHANNEL');
    } finally {
      // Cleanup the duplicate channel
      await db.controlChannelMember.deleteMany({ where: { channelId: dup.id } });
      await db.controlChannel.deleteMany({ where: { id: dup.id } });
    }
  });

  it('target with thread suffix (#c:abcd1234) → 400 TARGET_UNSUPPORTED', async () => {
    const res = await post({ target: '#c:abcd1234', content: 'Thread attempt' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('TARGET_UNSUPPORTED');
  });

  it('target with dm: prefix (dm:@x) → 400 TARGET_UNSUPPORTED', async () => {
    const res = await post({ target: 'dm:@alice', content: 'DM attempt' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('TARGET_UNSUPPORTED');
  });

  it('not-owned agent (X-Mio-Agent-Id for agent of DIFFERENT machine) → 403', async () => {
    // MACHINE_RAW_TOKEN is for MACHINE_ID, but we supply OTHER_AGENT_ID (owned by OTHER_MACHINE_ID)
    const res = await post(
      { target: '#agent-sends', content: 'Should be denied' },
      agentApiHeaders(MACHINE_RAW_TOKEN, OTHER_AGENT_ID),
    );

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('AGENT_NOT_OWNED');
  });

  it('public channel where agent is NOT a member → 404 NOT_A_MEMBER (resolver enforces own membership gate)', async () => {
    // CHANNEL_PUB_ID is public but AGENT_ID has no ControlChannelMember row there.
    // sendMessageTransaction would let a public-channel send through (it skips the
    // membership guard for public channels), but the resolver's membership-anchor prevents
    // the channel from matching in the first place.
    const res = await post({ target: '#public-no-member', content: 'Public channel no member' });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('NOT_A_MEMBER');
  });

  it('missing Authorization → 401 MACHINE_TOKEN_INVALID', async () => {
    const res = await APP.inject({
      method: 'POST',
      url: '/internal/agent-api/send',
      headers: { 'content-type': 'application/json', 'x-mio-agent-id': AGENT_ID },
      payload: JSON.stringify({ target: '#agent-sends', content: 'No auth' }),
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('MACHINE_TOKEN_INVALID');
  });

  it('missing content → 400 INVALID_BODY', async () => {
    const res = await post({ target: '#agent-sends' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('missing target → 400 INVALID_BODY', async () => {
    const res = await post({ content: 'No target' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_BODY');
  });
});

describe('GET /internal/agent-api/history', () => {
  it('after_seq → returns only messages with seq > after_seq, ascending', async () => {
    // HISTORY_MSG_IDS has 5 messages with seq 1..5.
    // after_seq=2 → should return msgs with seq 3, 4, 5 (indices 2, 3, 4).
    const res = await getHistory({ channel: '#agent-history', after_seq: '2' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('messages');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(3);
    // Must be ascending by seq
    const seqs = body.messages.map((m: { seq: string }) => BigInt(m.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i - 1]).toBe(true);
    }
    // All seqs > 2
    for (const s of seqs) {
      expect(s > 2n).toBe(true);
    }
    // IDs should match the seeded messages 3, 4, 5
    const returnedIds = body.messages.map((m: { id: string }) => m.id);
    expect(returnedIds).toContain(HISTORY_MSG_IDS[2]);
    expect(returnedIds).toContain(HISTORY_MSG_IDS[3]);
    expect(returnedIds).toContain(HISTORY_MSG_IDS[4]);
  });

  it('after_seq with membership enforcement: non-member channel → 404 NOT_A_MEMBER', async () => {
    // public-no-member channel exists but AGENT_ID has no member row.
    const res = await getHistory({ channel: '#public-no-member', after_seq: '0' });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('NOT_A_MEMBER');
  });

  it('malformed after_seq (non-numeric) → 400 INVALID_QUERY', async () => {
    const res = await getHistory({ channel: '#agent-history', after_seq: 'abc' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_QUERY');
  });

  it('around=<shortId> → returns a centered window with messages on BOTH sides of the pivot', async () => {
    // Use the 3rd message (index 2, seq=3) as the pivot.
    const pivotId = HISTORY_MSG_IDS[2];
    const shortId = pivotId.slice(0, 8);

    const res = await getHistory({ channel: '#agent-history', around: shortId });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('messages');
    expect(Array.isArray(body.messages)).toBe(true);
    // The pivot message must be in the result
    const returnedIds = body.messages.map((m: { id: string }) => m.id);
    expect(returnedIds).toContain(pivotId);
    // 5 seeded messages, pivot seq=3, default limit=20 (windowSize=10) → all 5 returned.
    expect(body.messages.length).toBe(5);
    // Should be seq-ascending
    const seqs = body.messages.map((m: { seq: string }) => BigInt(m.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i - 1]).toBe(true);
    }
    // BOTH sides of the pivot must be present — catches an "only-after-pivot" regression.
    // pivot seq=3 → assert at least one seq < 3 (before) AND at least one seq > 3 (after).
    expect(seqs.some((s: bigint) => s < 3n)).toBe(true);  // before-pivot present
    expect(seqs.some((s: bigint) => s > 3n)).toBe(true);  // after-pivot present
    // around is a centered window, not a paginated cursor → has_more is always false.
    expect(body.has_more).toBe(false);
  });

  it('around with small limit stays monotonic: limit=1 → window includes a before AND an after', async () => {
    // Regression guard for the window-size discontinuity fix: limit=1 → windowSize=1 →
    // 1 before + pivot + 1 after. Use pivot seq=3 so both neighbours exist.
    const pivotId = HISTORY_MSG_IDS[2]; // seq=3
    const shortId = pivotId.slice(0, 8);

    const res = await getHistory({ channel: '#agent-history', around: shortId, limit: '1' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const seqs = body.messages.map((m: { seq: string }) => BigInt(m.seq));
    // windowSize=1 → before (seq<=3, take 2) = seqs 2,3 ; after (seq>3, take 1) = seq 4 → 3 rows.
    expect(body.messages.length).toBe(3);
    expect(seqs.some((s: bigint) => s < 3n)).toBe(true);  // before-pivot present
    expect(seqs.some((s: bigint) => s === 3n)).toBe(true); // pivot present
    expect(seqs.some((s: bigint) => s > 3n)).toBe(true);  // after-pivot present
  });

  it('around=<unknownShortId> → 404 MESSAGE_NOT_FOUND', async () => {
    const res = await getHistory({ channel: '#agent-history', around: '00000000' });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('no anchor → latest ≤20 messages, seq-ascending', async () => {
    const res = await getHistory({ channel: '#agent-history' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('messages');
    expect(Array.isArray(body.messages)).toBe(true);
    // We seeded 5 messages; all should be returned (≤20 default)
    expect(body.messages.length).toBe(5);
    // Must be seq-ascending
    const seqs = body.messages.map((m: { seq: string }) => BigInt(m.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i - 1]).toBe(true);
    }
  });

  it('limit param → respects limit (returns at most limit messages)', async () => {
    const res = await getHistory({ channel: '#agent-history', limit: '2' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.length).toBeLessThanOrEqual(2);
  });

  it('limit > 100 → clamped to 100 (no error)', async () => {
    const res = await getHistory({ channel: '#agent-history', limit: '9999' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Returns valid response (limit was clamped; 5 messages seeded so ≤100 returned)
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('non-#name channel (dm: prefix) → 400 TARGET_UNSUPPORTED', async () => {
    const res = await getHistory({ channel: 'dm:@alice' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('TARGET_UNSUPPORTED');
  });

  it('non-#name channel (thread suffix #c:xxx) → 400 TARGET_UNSUPPORTED', async () => {
    const res = await getHistory({ channel: '#c:abcd1234' });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('TARGET_UNSUPPORTED');
  });

  it('not-owned agent → 403 AGENT_NOT_OWNED', async () => {
    const res = await getHistory(
      { channel: '#agent-history' },
      agentApiHeaders(MACHINE_RAW_TOKEN, OTHER_AGENT_ID),
    );

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('AGENT_NOT_OWNED');
  });

  it('wire shape: sender_id / sender_kind / seq (string) / content / id / created_at present and correct', async () => {
    // Fetch all messages; check both agent-sent (odd index) and human-sent (even index).
    const res = await getHistory({ channel: '#agent-history' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.length).toBe(5);

    // Message index 0 (seq 1): agent sender
    const agentMsg = body.messages[0];
    expect(agentMsg).toHaveProperty('id');
    expect(typeof agentMsg.id).toBe('string');
    expect(agentMsg).toHaveProperty('seq');
    expect(typeof agentMsg.seq).toBe('string');
    expect(agentMsg.sender_kind).toBe('agent');
    expect(agentMsg.sender_id).toBe(AGENT_ID);
    expect(agentMsg).toHaveProperty('content');
    expect(agentMsg).toHaveProperty('created_at');
    expect(typeof agentMsg.created_at).toBe('string');
    // Agent display name should be resolved (TestAgent)
    expect(agentMsg.sender_display_name).toBe('TestAgent');

    // Message index 1 (seq 2): human sender
    const humanMsg = body.messages[1];
    expect(humanMsg.sender_kind).toBe('user');
    expect(humanMsg.sender_id).toBe(HUMAN_SENDER_ID);
    // No ControlAgent row for HUMAN_SENDER_ID → display name is null
    expect(humanMsg.sender_display_name).toBeNull();
  });

  it('missing channel param → 400 INVALID_QUERY', async () => {
    const res = await getHistory({});

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_QUERY');
  });

  it('missing Authorization → 401 MACHINE_TOKEN_INVALID', async () => {
    const res = await APP.inject({
      method: 'GET',
      url: '/internal/agent-api/history?channel=%23agent-history',
      headers: { 'x-mio-agent-id': AGENT_ID },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('MACHINE_TOKEN_INVALID');
  });

  it('attachment_ids round-trip: send with attachment_ids, read back via /history → attachment_ids present', async () => {
    // Send a message with attachment_ids via POST /internal/agent-api/send
    const attachIds = [randomUUID(), randomUUID()];
    const sendRes = await post({
      target: '#agent-history',
      content: 'Message with attachments',
      attachment_ids: attachIds,
    });
    expect(sendRes.statusCode).toBe(201);
    const sendBody = JSON.parse(sendRes.body);
    const sentId = sendBody.id as string;
    const sentSeq = sendBody.seq as string;

    // Read back via GET /internal/agent-api/history using after_seq just before the sent message
    const seqBefore = (BigInt(sentSeq) - 1n).toString();
    const histRes = await getHistory({ channel: '#agent-history', after_seq: seqBefore });
    expect(histRes.statusCode).toBe(200);
    const histBody = JSON.parse(histRes.body);

    // Find our sent message in the returned list
    const returned = (histBody.messages as Array<Record<string, unknown>>).find((m) => m.id === sentId);
    expect(returned).toBeDefined();

    // attachment_ids must be present and match what was sent
    expect(returned).toHaveProperty('attachment_ids');
    expect(returned!.attachment_ids).toEqual(attachIds);
  });
});
