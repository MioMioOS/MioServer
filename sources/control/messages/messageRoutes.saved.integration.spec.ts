/**
 * S5 Saved messages — control plane (REAL Postgres integration).
 *
 * Covers:
 *   POST   /api/v1/workrooms/:wid/messages/:id/save   → save (idempotent)
 *   DELETE /api/v1/workrooms/:wid/messages/:id/save   → unsave (idempotent)
 *   GET    /api/v1/workrooms/:wid/saved               → caller's saved list, newest first
 *
 * Auth:
 *   save/unsave: op_sess_('save_message') OR machine; dev_ctl_ → 403.
 *   GET /saved: authorizeControlRead (machine OR dev_ctl_; dev allowlisted).
 *
 * Behaviour:
 *   - save then GET saved returns it (subject-scoped)
 *   - idempotent double-save → 200, single row
 *   - unsave removes it; unsave-missing → 200 no-op
 *   - dev_ctl_ → 403 on save
 *   - message-not-in-workroom → 404 on save
 *   - GET /saved requires auth (401 with no token)
 *   - GET /saved for dev_ctl_ (no subject) returns ALL saved in the workroom (debug)
 *   - V1_OPERATOR_COMMANDS includes 'save_message'
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
const OPERATOR_SUBJECT_ID = `pairing:${randomUUID()}`;

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const DEV_CTL_RAW_TOKEN = `dev_ctl_${randomUUID().replace(/-/g, '')}`;

let OP_SESS_RAW_TOKEN = '';
let CHANNEL_ID = '';
let MSG_A = '';
let MSG_B = '';
let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ───────────────────────────────────────────────────────────────────

const opSessHeader = () => ({ authorization: `Bearer ${OP_SESS_RAW_TOKEN}` });
const machineHeader = () => ({ authorization: `Bearer ${MACHINE_RAW_TOKEN}` });
const devCtlHeader = () => ({ authorization: `Bearer ${DEV_CTL_RAW_TOKEN}` });

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
      senderKind: 'user',
      senderId: OPERATOR_SUBJECT_ID,
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
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'SavedSpec WR', createdBy: randomUUID() },
  });

  const ch = await db.controlChannel.create({
    data: { workroomId: WORKROOM_ID, name: 'general', type: 'main', visibility: 'public', createdBy: 'system' },
  });
  CHANNEL_ID = ch.id;

  MSG_A = await seedMessage('Message A');
  MSG_B = await seedMessage('Message B');

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
  await db.controlSavedMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlDevToken.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── Operator command chain ────────────────────────────────────────────────────

describe('V1_OPERATOR_COMMANDS includes save_message', () => {
  it('array contains save_message', () => {
    expect(V1_OPERATOR_COMMANDS).toContain('save_message');
  });
});

// ── save → GET saved ──────────────────────────────────────────────────────────

describe('S5 saved messages', () => {
  // NOTE on auth model:
  //   save/unsave (POST/DELETE)  → op_sess_('save_message') OR machine. dev_ctl_ → 403.
  //   GET /saved                 → authorizeControlRead = machine OR dev_ctl_ ONLY
  //                                (op_sess_ is a WRITE credential, not accepted on reads).
  //   The operator's saved rows (subject = operatorSubjectId) are therefore verified via the
  //   DB directly + via the dev_ctl_ "all in workroom" debug view; a phone reads its saved
  //   list with its dev_ctl_ read token (which has no subject → all workroom saves).

  it('op_sess_ save then dev_ctl_ GET saved returns it (id + message_id shape)', async () => {
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_A}/save`, opSessHeader());
    expect(save.statusCode).toBe(200);
    expect(JSON.parse(save.body).ok).toBe(true);

    // Subject-scoped row exists for the operator subject.
    const row = await db.controlSavedMessage.findFirst({
      where: { subjectId: OPERATOR_SUBJECT_ID, messageId: MSG_A },
    });
    expect(row).not.toBeNull();

    // dev_ctl_ GET (no subject → all workroom saves) returns it with { id, message_id }.
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, devCtlHeader());
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
    const r1 = await inject('POST', url, opSessHeader());
    const r2 = await inject('POST', url, opSessHeader());
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const rows = await db.controlSavedMessage.count({
      where: { subjectId: OPERATOR_SUBJECT_ID, messageId: MSG_B },
    });
    expect(rows).toBe(1);
  });

  it('GET saved is newest-first', async () => {
    // MSG_B was saved after MSG_A → MSG_B should appear before MSG_A in the dev_ctl_ list.
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, devCtlHeader());
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
    const del = await inject('DELETE', url, opSessHeader());
    expect(del.statusCode).toBe(200);
    expect(JSON.parse(del.body).ok).toBe(true);

    // Operator-subject row is gone.
    const row = await db.controlSavedMessage.findFirst({
      where: { subjectId: OPERATOR_SUBJECT_ID, messageId: MSG_A },
    });
    expect(row).toBeNull();
  });

  it('unsave missing → 200 no-op', async () => {
    // MSG_A was just unsaved; deleting again is a no-op.
    const del = await inject('DELETE', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_A}/save`, opSessHeader());
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
    expect(ids).not.toContain(MSG_B); // MSG_B is an op-subject save → not visible to machine subject
  });

  it('dev_ctl_ → 403 on save', async () => {
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_B}/save`, devCtlHeader());
    expect(save.statusCode).toBe(403);
  });

  it('dev_ctl_ → 403 on unsave', async () => {
    const del = await inject('DELETE', `/api/v1/workrooms/${WORKROOM_ID}/messages/${MSG_B}/save`, devCtlHeader());
    expect(del.statusCode).toBe(403);
  });

  it('save message not in workroom → 404', async () => {
    // Seed a message in a different workroom.
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
        senderKind: 'user', senderId: OPERATOR_SUBJECT_ID, content: 'elsewhere',
      },
    });

    // Save it under WORKROOM_ID (mismatch) → 404.
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${otherMsg.id}/save`, opSessHeader());
    expect(save.statusCode).toBe(404);

    // cleanup
    await db.controlMessage.deleteMany({ where: { id: otherMsg.id } });
    await db.controlChannel.deleteMany({ where: { id: otherCh.id } });
    await db.controlWorkroom.deleteMany({ where: { id: otherWr } });
  });

  it('save nonexistent message → 404', async () => {
    const save = await inject('POST', `/api/v1/workrooms/${WORKROOM_ID}/messages/${randomUUID()}/save`, opSessHeader());
    expect(save.statusCode).toBe(404);
  });

  it('GET /saved with no auth → 401', async () => {
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, {});
    expect(list.statusCode).toBe(401);
  });

  it('GET /saved with dev_ctl_ returns ALL saved in the workroom (no subject)', async () => {
    // dev_ctl_ has no subject → debug view returns every save in the workroom.
    // At this point op subject saved MSG_B (kept), machine subject saved MSG_A.
    const list = await inject('GET', `/api/v1/workrooms/${WORKROOM_ID}/saved`, devCtlHeader());
    expect(list.statusCode).toBe(200);
    const ids = JSON.parse(list.body).saved.map((s: { message_id: string }) => s.message_id);
    // Sees both subjects' saves.
    expect(ids).toContain(MSG_A); // machine subject
    expect(ids).toContain(MSG_B); // op subject
  });
});
