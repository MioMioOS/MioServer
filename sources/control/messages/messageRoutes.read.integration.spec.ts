/**
 * S1 Chunk 3 — Message read endpoints + per-channel seq (REAL Postgres integration).
 *
 * Covers:
 *   GET /api/v1/workrooms/:wid/channels/:cid/messages
 *     - list messages in seq-ascending order
 *     - after_seq pagination (exclusive lower bound)
 *     - limit capped at 100
 *     - has_more signal
 *     - no after_seq → most recent rows
 *     - private channel non-member → 404
 *
 *   GET /api/v1/messages/:id
 *     - returns single visible message including channel_id
 *     - private channel non-member → 404
 *     - message not found → 404
 *
 *   nextChannelSeq
 *     - monotonically increases within a channel
 *     - isolated across channels
 *
 * Run: npm run test:db:setup && npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { messageRoutes } from './messageRoutes';
import { nextChannelSeq } from './channelSeq';

// ── Test fixture IDs ──────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const WORKROOM_B_ID = randomUUID();   // cross-workroom isolation
const MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();
const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let PUBLIC_CHANNEL_ID = '';
let PRIVATE_CHANNEL_ID = '';
let APP: FastifyInstance;

// Message IDs seeded below (filled in beforeAll).
const MSG_IDS: string[] = [];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeader() {
  return { authorization: `Bearer ${MACHINE_RAW_TOKEN}` };
}

function get(url: string, headers: Record<string, string> = authHeader()) {
  return APP.inject({ method: 'GET', url, headers });
}

async function seedMessage(opts: {
  channelId: string;
  seq: number;
  senderKind?: string;
  senderId?: string;
  content?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.controlMessage.create({
    data: {
      id,
      workroomId: WORKROOM_ID,
      channelId: opts.channelId,
      seq: BigInt(opts.seq),
      senderKind: opts.senderKind ?? 'system',
      senderId: opts.senderId ?? randomUUID(),
      content: opts.content ?? `Message seq=${opts.seq}`,
    },
  });
  return id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  // Org + machine + agent + workrooms
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'MsgRoute Org', slug: `msgrt-${randomUUID()}`, ownerUserId: randomUUID() },
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
    data: { id: AGENT_ID, orgId: ORG_ID, name: 'msg-agent', displayName: 'Msg Agent', role: 'ops' },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'MsgRoute WR', createdBy: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_B_ID, orgId: ORG_ID, name: 'MsgRoute WR-B', createdBy: randomUUID() },
  });

  // Public channel with 5 messages (seq 1–5)
  const pubCh = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'general',
      type: 'main',
      visibility: 'public',
      createdBy: 'system',
    },
  });
  PUBLIC_CHANNEL_ID = pubCh.id;

  for (let i = 1; i <= 5; i++) {
    const mid = await seedMessage({ channelId: PUBLIC_CHANNEL_ID, seq: i, senderId: AGENT_ID, senderKind: 'agent' });
    MSG_IDS.push(mid);
  }

  // Private channel (no member rows → machine is not a member in S1)
  const privCh = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'secret',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  PRIVATE_CHANNEL_ID = privCh.id;

  // Seed one private channel message so it exists
  await seedMessage({ channelId: PRIVATE_CHANNEL_ID, seq: 1, content: 'private content' });
});

afterAll(async () => {
  // FK-safe delete order: messages → channel members → channels → workrooms → agent → machine → org
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_B_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_B_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, WORKROOM_B_ID] } } });
  // Delete all agents in this org (covers AGENT_ID + any per-test daemon agents
  // whose own cleanup may not have run if a test failed mid-way).
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── GET /workrooms/:wid/channels/:cid/messages ────────────────────────────────

describe('GET /api/v1/workrooms/:wid/channels/:cid/messages', () => {
  it('returns messages in seq-ascending order', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?limit=10`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.channel_id).toBe(PUBLIC_CHANNEL_ID);
    expect(body.messages).toHaveLength(5);
    // seq-ascending
    const seqs = body.messages.map((m: { seq: string }) => Number(m.seq));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(body.has_more).toBe(false);
  });

  it('after_seq is an exclusive lower bound (returns only seq > after_seq)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?after_seq=2&limit=10`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const seqs = body.messages.map((m: { seq: string }) => Number(m.seq));
    expect(seqs).toEqual([3, 4, 5]);
    expect(body.has_more).toBe(false);
  });

  it('has_more is true when more messages exist beyond the page', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?after_seq=0&limit=3`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(3);
    expect(body.has_more).toBe(true);
    const seqs = body.messages.map((m: { seq: string }) => Number(m.seq));
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('limit is capped at 100 (requesting 200 gives at most 100)', async () => {
    // Seed a separate channel with 105 messages to test the cap
    const capCh = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'cap-test', type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    for (let i = 1; i <= 105; i++) {
      await seedMessage({ channelId: capCh.id, seq: i });
    }

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${capCh.id}/messages?limit=200`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.length).toBeLessThanOrEqual(100);
    expect(body.has_more).toBe(true);

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: capCh.id } });
    await db.controlChannel.deleteMany({ where: { id: capCh.id } });
  });

  it('no after_seq → returns most recent limit rows (desc then reversed to asc)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?limit=3`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Most recent 3 = seq 3, 4, 5 (then reversed to ascending: 3, 4, 5)
    const seqs = body.messages.map((m: { seq: string }) => Number(m.seq));
    expect(seqs).toEqual([3, 4, 5]);
    // has_more: fetched 4 rows (limit+1=4), got 5 rows in the channel but only fetched 4 desc → 4 rows
    // 4 > limit(3) → has_more = true
    expect(body.has_more).toBe(true);
  });

  it('empty page when after_seq is beyond all messages', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?after_seq=9999&limit=10`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(0);
    expect(body.has_more).toBe(false);
  });

  it('resolves sender_display_name for agent senders', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?limit=1`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const msg = body.messages[0];
    expect(msg.sender_kind).toBe('agent');
    expect(msg.sender_display_name).toBe('Msg Agent');
  });

  // ── S2 §1.4: additive name resolution by machineId (daemon send) ─────────────
  //
  // A daemon sends as senderKind='agent', senderId = machine.id (NOT ControlAgent.id).
  // Before S2 the resolver only matched ControlAgent.id, so daemon messages resolved
  // to null and the iOS app rendered the raw UUID. S2 adds an OR machineId branch.
  // This test seeds an agent with a machineId and a message whose senderId == that
  // machineId, and asserts the display name resolves. The existing positive test above
  // ('resolves sender_display_name for agent senders') already covers the id branch and
  // must stay green (additive, not replaced).
  it('resolves agent display_name by machineId (daemon send)', async () => {
    const daemonAgentId = randomUUID();
    const daemonMachineId = randomUUID(); // the machine.id the daemon sends as
    await db.controlAgent.create({
      data: {
        id: daemonAgentId,
        orgId: ORG_ID,
        machineId: daemonMachineId,
        name: 'mio-daemon',
        displayName: 'Mio',
        role: 'other',
        status: 'online',
      },
    });

    const daemonCh = await db.controlChannel.create({
      data: {
        workroomId: WORKROOM_ID,
        name: `daemon-machineid-${randomUUID().slice(0, 8)}`,
        type: 'standard',
        visibility: 'public',
        createdBy: 'system',
      },
    });

    // message sent as the MACHINE id (not the agent id)
    const msgId = randomUUID();
    await db.controlMessage.create({
      data: {
        id: msgId,
        workroomId: WORKROOM_ID,
        channelId: daemonCh.id,
        seq: 1n,
        senderKind: 'agent',
        senderId: daemonMachineId,
        content: 'hello from the daemon',
      },
    });

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${daemonCh.id}/messages`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(1);
    const msg = body.messages[0];
    expect(msg.sender_kind).toBe('agent');
    expect(msg.sender_id).toBe(daemonMachineId);
    // Resolved via the new machineId branch.
    expect(msg.sender_display_name).toBe('Mio');

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: daemonCh.id } });
    await db.controlChannel.deleteMany({ where: { id: daemonCh.id } });
    await db.controlAgent.deleteMany({ where: { id: daemonAgentId } });
  });

  // ── Regression: P2023 non-uuid agent senderId (commit 5ff4c39) ───────────────
  //
  // Bug: resolveSenderDisplayNames passed all agent senderIds straight into
  // db.controlAgent.findMany({ where: { id: { in: agentIds } } }).  ControlAgent.id
  // is @db.Uuid, but senderId is opaque TEXT (e.g. 'kris', 'pairing:<uuid>').
  // A non-uuid senderId caused Prisma P2023 (Inconsistent column data / invalid
  // UUID) → 500 on GET /messages.
  //
  // Fix: filter agentIds through a uuid-shape regex before the query.
  // These two tests assert:
  //   1. non-uuid senderId 'kris'          → HTTP 200, message present, display_name null
  //   2. non-uuid senderId 'pairing:<uuid>'→ HTTP 200, message present, display_name null
  //   3. uuid agentId matching ControlAgent → HTTP 200, display_name resolved (existing test
  //      above, kept as the positive counterpart)
  //
  // To verify the tests would FAIL without the fix: temporarily remove the
  // .filter((id) => uuidRe.test(id)) line in resolveSenderDisplayNames; the
  // requests below return 500 instead of 200.
  it('[regression P2023] non-uuid senderId "kris" → 200, message returned, display_name null', async () => {
    const nonUuidCh = await db.controlChannel.create({
      data: {
        workroomId: WORKROOM_ID,
        name: `regression-non-uuid-kris-${randomUUID().slice(0, 8)}`,
        type: 'standard',
        visibility: 'public',
        createdBy: 'system',
      },
    });

    // Seed a message whose senderKind='agent' but senderId is the bare word 'kris'
    // (not a UUID). Before the fix this caused Prisma P2023 → 500.
    const msgId = randomUUID();
    await db.controlMessage.create({
      data: {
        id: msgId,
        workroomId: WORKROOM_ID,
        channelId: nonUuidCh.id,
        seq: 1n,
        senderKind: 'agent',
        senderId: 'kris',
        content: 'hello from kris',
      },
    });

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${nonUuidCh.id}/messages`);

    // Must be 200, NOT 500 (P2023).
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(1);

    const msg = body.messages[0];
    expect(msg.id).toBe(msgId);
    expect(msg.sender_kind).toBe('agent');
    expect(msg.sender_id).toBe('kris');
    // No ControlAgent row for 'kris'; display name must be null (not a crash).
    expect(msg.sender_display_name).toBeNull();

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: nonUuidCh.id } });
    await db.controlChannel.deleteMany({ where: { id: nonUuidCh.id } });
  });

  it('[regression P2023] non-uuid senderId "pairing:<uuid>" → 200, message returned, display_name null', async () => {
    const pairingCh = await db.controlChannel.create({
      data: {
        workroomId: WORKROOM_ID,
        name: `regression-pairing-${randomUUID().slice(0, 8)}`,
        type: 'standard',
        visibility: 'public',
        createdBy: 'system',
      },
    });

    // 'pairing:<uuid>' is a real senderId shape used by op_sess_ human sends.
    // It starts with a UUID segment but the full string is not a bare UUID, so
    // the pre-fix code passed it into the Uuid column and triggered P2023.
    const pairingSenderId = `pairing:${randomUUID()}`;
    const msgId = randomUUID();
    await db.controlMessage.create({
      data: {
        id: msgId,
        workroomId: WORKROOM_ID,
        channelId: pairingCh.id,
        seq: 1n,
        senderKind: 'agent',
        senderId: pairingSenderId,
        content: 'pairing agent message',
      },
    });

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${pairingCh.id}/messages`);

    // Must be 200, NOT 500 (P2023).
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(1);

    const msg = body.messages[0];
    expect(msg.id).toBe(msgId);
    expect(msg.sender_kind).toBe('agent');
    expect(msg.sender_id).toBe(pairingSenderId);
    // No ControlAgent row for the pairing id; display name must be null.
    expect(msg.sender_display_name).toBeNull();

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: pairingCh.id } });
    await db.controlChannel.deleteMany({ where: { id: pairingCh.id } });
  });

  it('[regression P2023] uuid agent senderId with matching ControlAgent row → display_name still resolves', async () => {
    // Positive counterpart: the uuid filter must NOT accidentally drop valid uuid senderIds.
    // AGENT_ID is seeded in beforeAll with displayName='Msg Agent'.
    const uuidCh = await db.controlChannel.create({
      data: {
        workroomId: WORKROOM_ID,
        name: `regression-uuid-ok-${randomUUID().slice(0, 8)}`,
        type: 'standard',
        visibility: 'public',
        createdBy: 'system',
      },
    });

    const msgId = randomUUID();
    await db.controlMessage.create({
      data: {
        id: msgId,
        workroomId: WORKROOM_ID,
        channelId: uuidCh.id,
        seq: 1n,
        senderKind: 'agent',
        senderId: AGENT_ID,
        content: 'uuid agent message',
      },
    });

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${uuidCh.id}/messages`);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(1);

    const msg = body.messages[0];
    expect(msg.sender_kind).toBe('agent');
    expect(msg.sender_id).toBe(AGENT_ID);
    // UUID sender → ControlAgent row found → display name resolved.
    expect(msg.sender_display_name).toBe('Msg Agent');

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: uuidCh.id } });
    await db.controlChannel.deleteMany({ where: { id: uuidCh.id } });
  });
  // ── End regression P2023 ─────────────────────────────────────────────────────

  it('private channel non-member → 404 (uniform, anti-enumeration)', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PRIVATE_CHANNEL_ID}/messages`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('channel does not belong to this workroom → 404', async () => {
    const otherCh = await db.controlChannel.create({
      data: { workroomId: WORKROOM_B_ID, name: 'other-wr-ch', type: 'main', visibility: 'public', createdBy: 'system' },
    });
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${otherCh.id}/messages`);
    expect(res.statusCode).toBe(404);

    // cleanup
    await db.controlChannel.deleteMany({ where: { id: otherCh.id } });
  });

  it('401 when no token provided', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`, {});
    expect(res.statusCode).toBe(401);
  });

  it('returns wire shape fields: id, seq, sender_kind, sender_id, sender_display_name, content, mentions, embedded_card_type, embedded_card_id, thread_reply_count, created_at', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?after_seq=0&limit=1`);
    expect(res.statusCode).toBe(200);
    const msg = JSON.parse(res.body).messages[0];
    expect(msg).toHaveProperty('id');
    expect(msg).toHaveProperty('seq');
    expect(msg).toHaveProperty('sender_kind');
    expect(msg).toHaveProperty('sender_id');
    expect(msg).toHaveProperty('sender_display_name');
    expect(msg).toHaveProperty('content');
    expect(msg).toHaveProperty('mentions');
    expect(msg).toHaveProperty('embedded_card_type');
    expect(msg).toHaveProperty('embedded_card_id');
    expect(msg).toHaveProperty('thread_reply_count');
    expect(msg).toHaveProperty('created_at');
  });

  // ── S2 Task 2.3: parent_message_id field + replies excluded from main timeline ──
  it('top-level messages carry parent_message_id: null in the wire shape', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages?after_seq=0&limit=1`);
    expect(res.statusCode).toBe(200);
    const msg = JSON.parse(res.body).messages[0];
    expect(msg).toHaveProperty('parent_message_id');
    expect(msg.parent_message_id).toBeNull();
  });

  it('GET channel messages excludes reply rows (parentMessageId set)', async () => {
    // Fresh channel: one top-level message + one reply to it.
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: `excl-replies-${randomUUID().slice(0, 8)}`, type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const parentId = randomUUID();
    await db.controlMessage.create({
      data: { id: parentId, workroomId: WORKROOM_ID, channelId: ch.id, seq: 1n, senderKind: 'system', senderId: randomUUID(), content: 'top-level' },
    });
    await db.controlMessage.create({
      data: { id: randomUUID(), workroomId: WORKROOM_ID, channelId: ch.id, seq: 2n, senderKind: 'system', senderId: randomUUID(), content: 'a reply', parentMessageId: parentId },
    });

    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages?after_seq=0&limit=100`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Only the top-level message appears; the reply is filtered out.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe(parentId);
    expect(body.has_more).toBe(false);

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: ch.id } });
    await db.controlChannel.deleteMany({ where: { id: ch.id } });
  });

  it('GET channel messages excludes replies in the no-after_seq (most-recent) branch too', async () => {
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: `excl-replies-recent-${randomUUID().slice(0, 8)}`, type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const parentId = randomUUID();
    await db.controlMessage.create({
      data: { id: parentId, workroomId: WORKROOM_ID, channelId: ch.id, seq: 1n, senderKind: 'system', senderId: randomUUID(), content: 'top-level' },
    });
    // Two replies (later seqs) — must NOT appear in the most-recent page.
    await db.controlMessage.create({
      data: { id: randomUUID(), workroomId: WORKROOM_ID, channelId: ch.id, seq: 2n, senderKind: 'system', senderId: randomUUID(), content: 'reply 1', parentMessageId: parentId },
    });
    await db.controlMessage.create({
      data: { id: randomUUID(), workroomId: WORKROOM_ID, channelId: ch.id, seq: 3n, senderKind: 'system', senderId: randomUUID(), content: 'reply 2', parentMessageId: parentId },
    });

    // No after_seq → most-recent branch.
    const res = await get(`/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages?limit=10`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe(parentId);
    expect(body.has_more).toBe(false);

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: ch.id } });
    await db.controlChannel.deleteMany({ where: { id: ch.id } });
  });
});

// ── GET /api/v1/messages/:id ──────────────────────────────────────────────────

describe('GET /api/v1/messages/:id', () => {
  it('returns a visible message with channel_id', async () => {
    const msgId = MSG_IDS[0];
    const res = await get(`/api/v1/messages/${msgId}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(msgId);
    expect(body.channel_id).toBe(PUBLIC_CHANNEL_ID);
    expect(body.seq).toBeDefined();
    expect(body.sender_kind).toBe('agent');
    expect(body.sender_display_name).toBe('Msg Agent');
  });

  it('message in private channel → 404 (non-member)', async () => {
    // Private channel message exists but viewer is not a member.
    const privMsgs = await db.controlMessage.findMany({ where: { channelId: PRIVATE_CHANNEL_ID } });
    expect(privMsgs.length).toBeGreaterThan(0);
    const res = await get(`/api/v1/messages/${privMsgs[0].id}`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('non-existent message id → 404', async () => {
    const res = await get(`/api/v1/messages/${randomUUID()}`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('401 when no token', async () => {
    const res = await get(`/api/v1/messages/${MSG_IDS[0]}`, {});
    expect(res.statusCode).toBe(401);
  });

  it('GET /messages/:id returns all expected wire shape fields', async () => {
    const msgId = MSG_IDS[0];
    const res = await get(`/api/v1/messages/${msgId}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('channel_id');
    expect(body).toHaveProperty('seq');
    expect(body).toHaveProperty('sender_kind');
    expect(body).toHaveProperty('sender_id');
    expect(body).toHaveProperty('sender_display_name');
    expect(body).toHaveProperty('content');
    expect(body).toHaveProperty('mentions');
    expect(body).toHaveProperty('embedded_card_type');
    expect(body).toHaveProperty('embedded_card_id');
    expect(body).toHaveProperty('thread_reply_count');
    expect(body).toHaveProperty('created_at');
    // S2 Task 2.3: parent_message_id present (null for a top-level message).
    expect(body).toHaveProperty('parent_message_id');
    expect(body.parent_message_id).toBeNull();
  });
});

// ── nextChannelSeq ────────────────────────────────────────────────────────────

describe('nextChannelSeq', () => {
  it('returns 1 for an empty channel', async () => {
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'seq-test-empty', type: 'standard', visibility: 'public', createdBy: 'system' },
    });

    const seq = await db.$transaction(async (tx) => nextChannelSeq(tx as never, ch.id));
    expect(seq).toBe(1n);

    // cleanup
    await db.controlChannel.deleteMany({ where: { id: ch.id } });
  });

  it('increments monotonically for each message in the channel', async () => {
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'seq-test-incr', type: 'standard', visibility: 'public', createdBy: 'system' },
    });

    // Allocate seq 1 and insert
    const seq1 = await db.$transaction(async (tx) => nextChannelSeq(tx as never, ch.id));
    expect(seq1).toBe(1n);
    await db.controlMessage.create({
      data: { workroomId: WORKROOM_ID, channelId: ch.id, seq: seq1, senderKind: 'system', senderId: randomUUID(), content: 'a' },
    });

    // Allocate seq 2 and insert
    const seq2 = await db.$transaction(async (tx) => nextChannelSeq(tx as never, ch.id));
    expect(seq2).toBe(2n);
    await db.controlMessage.create({
      data: { workroomId: WORKROOM_ID, channelId: ch.id, seq: seq2, senderKind: 'system', senderId: randomUUID(), content: 'b' },
    });

    // Next seq should be 3
    const seq3 = await db.$transaction(async (tx) => nextChannelSeq(tx as never, ch.id));
    expect(seq3).toBe(3n);

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: ch.id } });
    await db.controlChannel.deleteMany({ where: { id: ch.id } });
  });

  it('seq is isolated per channel (seqs in channel A do not affect channel B)', async () => {
    const chA = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'seq-iso-a', type: 'standard', visibility: 'public', createdBy: 'system' },
    });
    const chB = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'seq-iso-b', type: 'standard', visibility: 'public', createdBy: 'system' },
    });

    // Insert 3 messages in channel A
    for (let i = 1; i <= 3; i++) {
      const s = await db.$transaction(async (tx) => nextChannelSeq(tx as never, chA.id));
      await db.controlMessage.create({
        data: { workroomId: WORKROOM_ID, channelId: chA.id, seq: s, senderKind: 'system', senderId: randomUUID(), content: `a${i}` },
      });
    }

    // Channel B seq should still start at 1
    const seqB = await db.$transaction(async (tx) => nextChannelSeq(tx as never, chB.id));
    expect(seqB).toBe(1n);

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: { in: [chA.id, chB.id] } } });
    await db.controlChannel.deleteMany({ where: { id: { in: [chA.id, chB.id] } } });
  });
});
