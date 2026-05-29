/**
 * B1 — Agent API attachments integration tests.
 *
 * Endpoints under test:
 *   POST /internal/agent-api/attachments  { filename, mime_type, data_base64, target }
 *   GET  /internal/agent-api/attachments/:id
 *
 * Also exercises: send with attachment_ids (persisted on ControlMessage).
 *
 * Run: npm run test:integration -- sources/control/attachments sources/control/messages sources/control/agentApi
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentApiAttachments } from './agentApiAttachments';
import { agentApiRoutes } from '@/control/agentApi/agentApiRoutes';
import { registerEmptyJsonBodyParser } from '@/jsonBodyParser';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();        // owned by MACHINE_ID, member of CHANNEL_ID
const OTHER_AGENT_ID = randomUUID(); // owned by OTHER_MACHINE_ID, NOT a member of CHANNEL_ID

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let CHANNEL_ID = '';       // #attach-test channel — AGENT_ID is a member
let OTHER_CHANNEL_ID = ''; // a channel AGENT_ID is NOT a member of

let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// A small 1x1 white PNG (valid image, tiny size)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';

// ── Helpers ────────────────────────────────────────────────────────────────────

function headers(machineToken = MACHINE_RAW_TOKEN, agentId = AGENT_ID) {
  return {
    authorization: `Bearer ${machineToken}`,
    'x-mio-agent-id': agentId,
    'content-type': 'application/json',
  };
}

function upload(body: Record<string, unknown>, h = headers()) {
  return APP.inject({
    method: 'POST',
    url: '/internal/agent-api/attachments',
    headers: h,
    payload: JSON.stringify(body),
  });
}

function view(id: string, h = headers()) {
  return APP.inject({
    method: 'GET',
    url: `/internal/agent-api/attachments/${id}`,
    headers: h,
  });
}

function send(body: Record<string, unknown>, h = headers()) {
  return APP.inject({
    method: 'POST',
    url: '/internal/agent-api/send',
    headers: h,
    payload: JSON.stringify(body),
  });
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  registerEmptyJsonBodyParser(APP);
  await APP.register(agentApiAttachments);
  await APP.register(agentApiRoutes);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'AgentApiAttachments Org',
      slug: `agent-api-attachments-${randomUUID()}`,
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentApiAttachments WR', createdBy: randomUUID() },
  });

  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'AttachTestAgent',
      displayName: 'AttachTestAgent',
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
      name: 'OtherAttachAgent',
      displayName: 'OtherAttachAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // #attach-test channel — AGENT_ID is a member
  const ch = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'attach-test',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  CHANNEL_ID = ch.id;
  await db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId: AGENT_ID } });

  // Non-member channel (AGENT_ID is NOT a member)
  const otherCh = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'no-member-attach',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  OTHER_CHANNEL_ID = otherCh.id;
});

afterAll(async () => {
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAttachment.deleteMany({ where: { workroomId: WORKROOM_ID } });
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

// ── POST /internal/agent-api/attachments ──────────────────────────────────────

describe('POST /internal/agent-api/attachments (upload)', () => {
  it('valid image + member target → row created with data bytes, channelId set, sizeBytes correct', async () => {
    const res = await upload({
      filename: 'test.png',
      mime_type: 'image/png',
      data_base64: TINY_PNG_BASE64,
      target: '#attach-test',
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(typeof body.attachment_id).toBe('string');

    // Verify the DB row
    const row = await db.controlAttachment.findUnique({
      where: { id: body.attachment_id },
      select: { data: true, channelId: true, sizeBytes: true, workroomId: true, uploaderKind: true, uploaderId: true },
    });
    expect(row).not.toBeNull();

    // channelId set correctly
    expect(row!.channelId).toBe(CHANNEL_ID);

    // workroomId set correctly
    expect(row!.workroomId).toBe(WORKROOM_ID);

    // uploaderKind = 'agent', uploaderId = AGENT_ID
    expect(row!.uploaderKind).toBe('agent');
    expect(row!.uploaderId).toBe(AGENT_ID);

    // data bytes match the decoded base64.
    // Prisma returns Bytes fields as Uint8Array; compare via Buffer.from for a
    // type-agnostic bytes equality check.
    const expectedBuf = Buffer.from(TINY_PNG_BASE64, 'base64');
    expect(Buffer.from(row!.data as Uint8Array)).toEqual(expectedBuf);

    // sizeBytes is a BigInt and matches
    expect(row!.sizeBytes).toBe(BigInt(expectedBuf.length));
  });

  it('mime_type not in allowlist → 415', async () => {
    const res = await upload({
      filename: 'test.pdf',
      mime_type: 'application/pdf',
      data_base64: TINY_PNG_BASE64,
      target: '#attach-test',
    });
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).error.code).toBe('UNSUPPORTED_MIME');
  });

  it('decoded data > 8MB → 413', async () => {
    // Create a base64 string whose decoded size exceeds 8MB
    const oversizedBuf = Buffer.alloc(8 * 1024 * 1024 + 1, 0);
    const oversizedB64 = oversizedBuf.toString('base64');

    const res = await upload({
      filename: 'big.png',
      mime_type: 'image/png',
      data_base64: oversizedB64,
      target: '#attach-test',
    });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('large legitimate image (~7.8MiB decoded, ~10.4MiB base64 wire) → 201 + exact byte round-trip', async () => {
    // Production's GLOBAL default bodyLimit (api.ts) is 10MiB. This route overrides it to
    // 12MiB. A real ~7.8MiB-decoded image has a base64 WIRE size of ~10.4MiB — ABOVE the
    // 10MiB global default but UNDER the 12MiB route cap — so it MUST succeed (201). If a
    // regression drops the per-route bodyLimit (falling back to the 10MiB global), this body
    // would be rejected before the handler ever runs. This test is the only guard that proves
    // a SUCCESSFUL large upload (the 413 test only proves a too-large body is rejected), and
    // it also pins the decoded-byte cap below the wire cap (7.8MiB decoded < 8MiB decoded cap).
    const decodedBytes = Math.floor(7.8 * 1024 * 1024); // ~7.8 MiB decoded
    const bigBuf = Buffer.alloc(decodedBytes);
    // Fill with varying bytes so the round-trip equality check is meaningful (not all-zeros).
    for (let i = 0; i < bigBuf.length; i++) bigBuf[i] = (i * 31 + 7) & 0xff;
    const bigB64 = bigBuf.toString('base64');
    // Sanity: wire size is above the 10MiB global default but under the 12MiB route cap.
    expect(bigB64.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(bigB64.length).toBeLessThan(12 * 1024 * 1024);

    const res = await upload({
      filename: 'large-image.png',
      mime_type: 'image/png',
      data_base64: bigB64,
      target: '#attach-test',
    });
    expect(res.statusCode).toBe(201);
    const attachmentId = JSON.parse(res.body).attachment_id;

    // GET it back and assert exact byte equality (full round-trip).
    const getRes = await view(attachmentId);
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.size_bytes).toBe(bigBuf.length);
    const returnedBuf = Buffer.from(getBody.data_base64, 'base64');
    expect(returnedBuf).toEqual(bigBuf);
  });

  it('target is not a member channel → 404 NOT_A_MEMBER', async () => {
    const res = await upload({
      filename: 'test.png',
      mime_type: 'image/png',
      data_base64: TINY_PNG_BASE64,
      target: '#no-member-attach',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it('missing target → 400 INVALID_BODY', async () => {
    const res = await upload({
      filename: 'test.png',
      mime_type: 'image/png',
      data_base64: TINY_PNG_BASE64,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_BODY');
  });

  it('empty target → 400 INVALID_BODY', async () => {
    const res = await upload({
      filename: 'test.png',
      mime_type: 'image/png',
      data_base64: TINY_PNG_BASE64,
      target: '',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_BODY');
  });
});

// ── GET /internal/agent-api/attachments/:id ───────────────────────────────────

describe('GET /internal/agent-api/attachments/:id (view)', () => {
  let attachmentId: string;
  const originalBuf = Buffer.from(TINY_PNG_BASE64, 'base64');

  beforeAll(async () => {
    // Upload one attachment for view tests
    const res = await upload({
      filename: 'view-test.png',
      mime_type: 'image/png',
      data_base64: TINY_PNG_BASE64,
      target: '#attach-test',
    });
    expect(res.statusCode).toBe(201);
    attachmentId = JSON.parse(res.body).attachment_id;
  });

  it('member → correct bytes round-trip', async () => {
    const res = await view(attachmentId);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.filename).toBe('view-test.png');
    expect(body.mime_type).toBe('image/png');
    expect(body.size_bytes).toBe(originalBuf.length);

    // Bytes round-trip: decoded data_base64 must exactly equal original bytes
    const returnedBuf = Buffer.from(body.data_base64, 'base64');
    expect(returnedBuf).toEqual(originalBuf);
  });

  it('non-member of the attachment channel → 403', async () => {
    // OTHER_AGENT_ID (owned by OTHER_MACHINE) is not a member of CHANNEL_ID (#attach-test)
    const res = await view(attachmentId, headers(OTHER_MACHINE_RAW_TOKEN, OTHER_AGENT_ID));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
  });

  it('not found → 404', async () => {
    const res = await view(randomUUID());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND');
  });
});

// ── POST /internal/agent-api/send with attachment_ids ─────────────────────────

describe('POST /internal/agent-api/send with attachment_ids', () => {
  it('send with attachment_ids → persisted message has attachmentIds set', async () => {
    // First upload an attachment
    const upRes = await upload({
      filename: 'send-attach.png',
      mime_type: 'image/png',
      data_base64: TINY_PNG_BASE64,
      target: '#attach-test',
    });
    expect(upRes.statusCode).toBe(201);
    const attachmentId = JSON.parse(upRes.body).attachment_id;

    // Send a message with that attachment_id
    const sendRes = await send({
      target: '#attach-test',
      content: 'Message with attachment',
      attachment_ids: [attachmentId],
    });
    expect(sendRes.statusCode).toBe(201);
    const { id: messageId } = JSON.parse(sendRes.body);

    // Re-query the message row — sendMessageTransaction select omits attachmentIds
    const msg = await db.controlMessage.findUnique({
      where: { id: messageId },
      select: { attachmentIds: true },
    });
    expect(msg).not.toBeNull();
    expect(msg!.attachmentIds).toEqual([attachmentId]);
  });

  it('send without attachment_ids → message has empty attachmentIds', async () => {
    const sendRes = await send({
      target: '#attach-test',
      content: 'Message without attachment',
    });
    expect(sendRes.statusCode).toBe(201);
    const { id: messageId } = JSON.parse(sendRes.body);

    const msg = await db.controlMessage.findUnique({
      where: { id: messageId },
      select: { attachmentIds: true },
    });
    expect(msg).not.toBeNull();
    expect(msg!.attachmentIds).toEqual([]);
  });

  it('send with malformed attachment_ids (non-array string) → 400 INVALID_BODY', async () => {
    // A malformed attachment_ids must fail loud, not silently send with no attachments.
    const sendRes = await send({
      target: '#attach-test',
      content: 'Message with bad attachment_ids',
      attachment_ids: 'abc',
    });
    expect(sendRes.statusCode).toBe(400);
    expect(JSON.parse(sendRes.body).error.code).toBe('INVALID_BODY');
  });

  it('send with attachment_ids array containing a non-string element → 400 INVALID_BODY', async () => {
    const sendRes = await send({
      target: '#attach-test',
      content: 'Message with non-string element in attachment_ids',
      attachment_ids: [123],
    });
    expect(sendRes.statusCode).toBe(400);
    expect(JSON.parse(sendRes.body).error.code).toBe('INVALID_BODY');
  });
});
