/**
 * S1 Chunk 4 — Message WRITE endpoint (REAL Postgres integration).
 *
 * Covers POST /api/v1/workrooms/:wid/channels/:cid/messages:
 *   - op_sess_ send: OK (201)
 *   - machine send: OK (201)
 *   - dev_ctl_ → 403 hard reject
 *   - private non-member → 403
 *   - idempotent replay returns same message (idempotent:true)
 *   - op_sess_ missing client_idempotency_key → 400
 *   - machine omit key: two sends → two distinct messages (no collision)
 *   - event message.created published write-before-broadcast (event row exists post-send)
 *   - preview is redacted + truncated to ≤120 chars
 *
 * Also covers:
 *   - V1_OPERATOR_COMMANDS includes 'send_message' (minting op_sess_ with it does not fail-closed)
 *   - operator command chain: mintOperatorSession with send_message succeeds
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
const OPERATOR_SUBJECT_ID = randomUUID(); // must be UUID (senderId is @db.Uuid)

// Raw tokens (set in beforeAll after DB rows are created)
const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let OP_SESS_RAW_TOKEN = '';
let PUBLIC_CHANNEL_ID = '';
let PRIVATE_CHANNEL_ID = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

function opSessHeader() {
  return { authorization: `Bearer ${OP_SESS_RAW_TOKEN}` };
}

function machineHeader() {
  return { authorization: `Bearer ${MACHINE_RAW_TOKEN}` };
}

function devCtlHeader() {
  return { authorization: `Bearer ${DEV_CTL_RAW_TOKEN}` };
}

function post(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = opSessHeader(),
) {
  return APP.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(messageRoutes);
  await APP.ready();

  // Org, machine, dev token, workroom
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'WriteMsgSpec Org', slug: `write-msg-${randomUUID()}`, ownerUserId: randomUUID() },
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
  // Dev token stored directly so we can send it in tests (not a valid op/machine token).
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'WriteMsgSpec WR', createdBy: randomUUID() },
  });

  // Channels
  const pubCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  PUBLIC_CHANNEL_ID = pubCh.id;

  const privCh = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'secret', type: 'standard', visibility: 'private', createdBy: 'system' },
  });
  PRIVATE_CHANNEL_ID = privCh.id;

  // Mint an op_sess_ that includes send_message (via mintOperatorSession).
  // OPERATOR_SUBJECT_ID is a UUID so senderId is valid in ControlMessage.
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
  // FK-safe delete order.
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlDevToken.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── Operator command chain: send_message in V1_OPERATOR_COMMANDS ──────────────

describe('V1_OPERATOR_COMMANDS includes send_message', () => {
  it('V1_OPERATOR_COMMANDS array contains send_message', () => {
    expect(V1_OPERATOR_COMMANDS).toContain('send_message');
  });

  it('mintOperatorSession with send_message does not fail-closed', async () => {
    // If send_message were NOT in V1_OPERATOR_COMMANDS, this would throw OperatorSessionMintError.
    const result = await mintOperatorSession({
      orgId: ORG_ID,
      workroomId: WORKROOM_ID,
      operatorSubjectId: randomUUID(),
      issuedBy: 'test:chain-verify',
      allowedCommands: ['send_message'],
    });
    expect(result.rawToken).toMatch(/^op_sess_/);
    expect(result.allowedCommands).toContain('send_message');
    // cleanup
    await db.controlOperatorSession.deleteMany({ where: { id: result.id } });
  });
});

// ── POST /api/v1/workrooms/:wid/channels/:cid/messages ────────────────────────

describe('POST /api/v1/workrooms/:wid/channels/:cid/messages', () => {
  it('op_sess_ send: returns 201 with id, seq, created_at, idempotent:false', async () => {
    const key = randomUUID();
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Hello from operator', client_idempotency_key: key },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('seq');
    expect(body).toHaveProperty('created_at');
    expect(body.idempotent).toBe(false);
  });

  it('machine send: returns 201 with id, seq, created_at, idempotent:false', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Hello from machine' },
      machineHeader(),
    );
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('seq');
    expect(body.idempotent).toBe(false);
  });

  it('dev_ctl_ → 403 hard reject', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'Should be denied', client_idempotency_key: randomUUID() },
      devCtlHeader(),
    );
    expect(res.statusCode).toBe(403);
  });

  it('private channel non-member → 403', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PRIVATE_CHANNEL_ID}/messages`,
      { content: 'Should be denied', client_idempotency_key: randomUUID() },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
  });

  it('idempotent replay: same client_idempotency_key returns same message (idempotent:true)', async () => {
    const key = randomUUID();
    const body = { content: 'Idempotent message', client_idempotency_key: key };
    const url = `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`;

    // First send
    const res1 = await post(url, body, opSessHeader());
    expect(res1.statusCode).toBe(201);
    const b1 = JSON.parse(res1.body);
    expect(b1.idempotent).toBe(false);

    // Second send with same key
    const res2 = await post(url, body, opSessHeader());
    expect(res2.statusCode).toBe(201);
    const b2 = JSON.parse(res2.body);
    expect(b2.idempotent).toBe(true);

    // Same message id and seq
    expect(b2.id).toBe(b1.id);
    expect(b2.seq).toBe(b1.seq);
  });

  it('op_sess_ missing client_idempotency_key → 400', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'No key provided' },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('machine omit key: two sends → two distinct messages (no collision)', async () => {
    const url = `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`;
    const bodyTemplate = { content: 'Machine message no key' };

    const res1 = await post(url, bodyTemplate, machineHeader());
    const res2 = await post(url, bodyTemplate, machineHeader());

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);

    const b1 = JSON.parse(res1.body);
    const b2 = JSON.parse(res2.body);

    // Two distinct messages (different IDs and different seqs)
    expect(b1.id).not.toBe(b2.id);
    expect(b1.seq).not.toBe(b2.seq);
  });

  it('event message.created is written to DB (write-before-broadcast) after send', async () => {
    const key = randomUUID();
    const content = 'Event write-before-broadcast test';

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content, client_idempotency_key: key },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(201);
    const msgBody = JSON.parse(res.body);

    // Event must exist in the DB after the send (write-before-broadcast guarantee).
    // The event topic is 'message.created' and payload contains the message_id.
    const event = await db.controlEventLog.findFirst({
      where: {
        workroomId: WORKROOM_ID,
        topic: 'message.created',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(msgBody.id);
    expect(payload.channel_id).toBe(PUBLIC_CHANNEL_ID);
    expect(payload.seq).toBe(msgBody.seq);
    expect(payload.sender_kind).toBe('user');
    expect(payload.sender_id).toBe(OPERATOR_SUBJECT_ID);
    // preview: redacted + truncated to ≤120
    expect(typeof payload.preview).toBe('string');
    expect((payload.preview as string).length).toBeLessThanOrEqual(120);
  });

  it('preview in event payload is redacted (token shapes replaced with [REDACTED])', async () => {
    const sensitiveToken = 'op_sess_SECRETTOKEN123';
    const content = `Message with secret: ${sensitiveToken}`;
    const key = randomUUID();

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content, client_idempotency_key: key },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(201);
    const msgBody = JSON.parse(res.body);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'message.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(msgBody.id);
    // The raw op_sess_ token should be redacted in the preview
    expect(payload.preview as string).not.toContain(sensitiveToken);
    expect(payload.preview as string).toContain('[REDACTED]');
  });

  it('preview is truncated to ≤120 chars', async () => {
    const longContent = 'A'.repeat(300);
    const key = randomUUID();

    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: longContent, client_idempotency_key: key },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(201);
    const msgBody = JSON.parse(res.body);

    const event = await db.controlEventLog.findFirst({
      where: { workroomId: WORKROOM_ID, topic: 'message.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    const payload = event!.payloadJson as Record<string, unknown>;
    expect(payload.message_id).toBe(msgBody.id);
    expect((payload.preview as string).length).toBeLessThanOrEqual(120);
  });

  it('no auth → 401', async () => {
    const res = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${PUBLIC_CHANNEL_ID}/messages`,
      { content: 'No auth', client_idempotency_key: randomUUID() },
      {},
    );
    expect(res.statusCode).toBe(401);
  });

  it('channel not in workroom → 404', async () => {
    const otherWrId = randomUUID();
    await db.controlWorkroom.create({
      data: { id: otherWrId, orgId: ORG_ID, name: 'Other WR', createdBy: randomUUID() },
    });
    const otherCh = await db.controlChannel.create({
      data: { workroomId: otherWrId, name: 'other-ch', type: 'main', visibility: 'public', createdBy: 'system' },
    });

    const res = await post(
      // cid belongs to otherWrId, not WORKROOM_ID
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${otherCh.id}/messages`,
      { content: 'Wrong workroom', client_idempotency_key: randomUUID() },
      opSessHeader(),
    );
    expect(res.statusCode).toBe(404);

    // cleanup
    await db.controlChannel.deleteMany({ where: { id: otherCh.id } });
    await db.controlWorkroom.deleteMany({ where: { id: otherWrId } });
  });

  it('seq increments monotonically across sends', async () => {
    // Seed a fresh channel to get clean seq numbers
    const ch = await db.controlChannel.create({
      data: { workroomId: WORKROOM_ID, name: 'seq-mono-test', type: 'standard', visibility: 'public', createdBy: 'system' },
    });

    const res1 = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'seq1', client_idempotency_key: randomUUID() },
      opSessHeader(),
    );
    const res2 = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'seq2', client_idempotency_key: randomUUID() },
      opSessHeader(),
    );
    const res3 = await post(
      `/api/v1/workrooms/${WORKROOM_ID}/channels/${ch.id}/messages`,
      { content: 'seq3', client_idempotency_key: randomUUID() },
      opSessHeader(),
    );

    expect(res1.statusCode).toBe(201);
    expect(res2.statusCode).toBe(201);
    expect(res3.statusCode).toBe(201);

    const s1 = Number(JSON.parse(res1.body).seq);
    const s2 = Number(JSON.parse(res2.body).seq);
    const s3 = Number(JSON.parse(res3.body).seq);

    expect(s1).toBeLessThan(s2);
    expect(s2).toBeLessThan(s3);

    // cleanup
    await db.controlMessage.deleteMany({ where: { channelId: ch.id } });
    await db.controlChannel.deleteMany({ where: { id: ch.id } });
  });
});
