/**
 * #97 operator write endpoints — REAL Postgres integration tests.
 * Run with: npm run test:db:setup && npm run test:integration (excluded from default npm test).
 *
 * Covers the full auth/command matrix: success (ack/mark-reviewed), 401 (no token / dev_ctl_),
 * 400 (no idempotency key), 404 (non-existent + cross-workroom, no-leak), 403 (command not in
 * session scope), 422 (approve/retry not in V1), 409 (wrong status + duplicate idempotency),
 * and anti-enumeration (401 before 404).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';
import { operatorWriteRoutes } from './operatorWriteRoutes.js';
import { mintOperatorSession } from './operatorSessionMint.js';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();
const AGENT_ID = randomUUID();
const SESSION_ID = randomUUID();

let app: FastifyInstance;
let tokenBoth: string;          // allowedCommands: ack + mark_reviewed (default)
let tokenAckOnly: string;       // allowedCommands: ack only (for 403 command-scope test)

async function seedAction(opts: { workroomId?: string; status?: string }): Promise<string> {
  const id = randomUUID();
  await db.controlAction.create({
    data: {
      id,
      sessionId: SESSION_ID,
      workroomId: opts.workroomId ?? WORKROOM_ID,
      actorAgentId: AGENT_ID,
      kind: 'other',
      summary: 'op-write test action',
      reversibility: 'reversible',
      riskLevel: 'low',
      requiresApproval: false,
      status: opts.status ?? 'needs_human',
      clientIdempotencyKey: `idem-${randomUUID()}`,
    },
  });
  return id;
}

function post(actionId: string, segment: string, token?: string, body: unknown = { client_idempotency_key: randomUUID() }) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/actions/${actionId}/${segment}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    payload: body as object,
  });
}

beforeAll(async () => {
  app = fastify();
  await app.register(operatorWriteRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'OpW Org', slug: `opw-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, name: 'opw-agent', displayName: 'OpW Agent', role: 'ops' } });
  for (const wid of [WORKROOM_ID, OTHER_WORKROOM_ID]) {
    await db.controlWorkroom.create({ data: { id: wid, orgId: ORG_ID, name: `WR ${wid.slice(0, 6)}`, createdBy: randomUUID() } });
  }
  await db.controlSession.create({ data: { id: SESSION_ID, orgId: ORG_ID, workroomId: WORKROOM_ID, machineId: null, mode: 'daemon', runtime: 'claude', displayName: 'opw-session' } });

  tokenBoth = (await mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: 'subj', issuedBy: 'cli:test' })).rawToken;
  tokenAckOnly = (await mintOperatorSession({ orgId: ORG_ID, workroomId: WORKROOM_ID, operatorSubjectId: 'subj', issuedBy: 'cli:test', allowedCommands: ['acknowledge_needs_human'] })).rawToken;
});

afterAll(async () => {
  await db.controlOperatorAuditLog.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlAction.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlSession.deleteMany({ where: { id: SESSION_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await app.close();
  await db.$disconnect();
});

describe('#97 operator write endpoints — success', () => {
  it('acknowledge: needs_human action → 200, operatorAcknowledgedAt set + audit row', async () => {
    const id = await seedAction({ status: 'needs_human' });
    const res = await post(id, 'acknowledge', tokenBoth);
    expect(res.statusCode).toBe(200);
    const action = await db.controlAction.findUnique({ where: { id } });
    expect(action!.operatorAcknowledgedAt).not.toBeNull();
    const audit = await db.controlOperatorAuditLog.findMany({ where: { actionId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].commandKey).toBe('acknowledge_needs_human');
  });

  it('mark-reviewed: succeeded action → 200, operatorReviewedAt set', async () => {
    const id = await seedAction({ status: 'succeeded' });
    const res = await post(id, 'mark-reviewed', tokenBoth);
    expect(res.statusCode).toBe(200);
    expect((await db.controlAction.findUnique({ where: { id } }))!.operatorReviewedAt).not.toBeNull();
  });
});

describe('#97 operator write endpoints — auth (401/400)', () => {
  it('no token → 401', async () => {
    const id = await seedAction({});
    expect((await post(id, 'acknowledge', undefined)).statusCode).toBe(401);
  });

  it('dev_ctl_ token → 401 (read-only token hard-rejected on writes)', async () => {
    const id = await seedAction({});
    expect((await post(id, 'acknowledge', 'dev_ctl_whatever')).statusCode).toBe(401);
  });

  it('missing client_idempotency_key → 400', async () => {
    const id = await seedAction({});
    expect((await post(id, 'acknowledge', tokenBoth, {})).statusCode).toBe(400);
  });

  it('anti-enumeration: no token on existent vs non-existent action → both 401 (auth before lookup)', async () => {
    const id = await seedAction({});
    expect((await post(id, 'acknowledge', undefined)).statusCode).toBe(401);
    expect((await post(randomUUID(), 'acknowledge', undefined)).statusCode).toBe(401);
  });
});

describe('#97 operator write endpoints — scope/command (404/403/422)', () => {
  it('cross-workroom action → 404 (no-leak, not 403)', async () => {
    const id = await seedAction({ workroomId: OTHER_WORKROOM_ID, status: 'needs_human' });
    expect((await post(id, 'acknowledge', tokenBoth)).statusCode).toBe(404);
  });

  it('non-existent action → 404', async () => {
    expect((await post(randomUUID(), 'acknowledge', tokenBoth)).statusCode).toBe(404);
  });

  it('command not in session allowedCommands → 403', async () => {
    const id = await seedAction({ status: 'succeeded' });
    // tokenAckOnly cannot mark-reviewed
    expect((await post(id, 'mark-reviewed', tokenAckOnly)).statusCode).toBe(403);
  });

  it('approve / retry with default (ack+mark) token → 403 (command not in scope, no V1-gate leak)', async () => {
    const id1 = await seedAction({ status: 'proposed' });
    const id2 = await seedAction({ status: 'failed' });
    // Unscoped session must NOT learn the command is "V1-gated" (422) — it gets fail-closed 403.
    expect((await post(id1, 'approve', tokenBoth)).statusCode).toBe(403);
    expect((await post(id2, 'retry', tokenBoth)).statusCode).toBe(403);
  });

  it('approve with a session GRANTED approve scope → 422 (authorized but not supported in V1)', async () => {
    // mintOperatorSession refuses approve/retry (V1 allow-list), so insert a session row directly
    // with approve scope to reach the helper's V1-gate.
    const raw = `op_sess_${randomBytes(32).toString('base64url')}`;
    await db.controlOperatorSession.create({
      data: {
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        orgId: ORG_ID,
        workroomId: WORKROOM_ID,
        allowedCommands: ['approve'],
        operatorSubjectId: 'subj',
        issuedBy: 'cli:test',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const id = await seedAction({ status: 'proposed' });
    expect((await post(id, 'approve', raw)).statusCode).toBe(422);
  });
});

describe('#97 operator write endpoints — status/idempotency (409)', () => {
  it('acknowledge on a non-needs_human action → 409 (wrong status)', async () => {
    const id = await seedAction({ status: 'succeeded' });
    expect((await post(id, 'acknowledge', tokenBoth)).statusCode).toBe(409);
  });

  it('duplicate idempotency key → 409, no second mutation/audit', async () => {
    const id = await seedAction({ status: 'needs_human' });
    const key = randomUUID();
    const r1 = await post(id, 'acknowledge', tokenBoth, { client_idempotency_key: key });
    expect(r1.statusCode).toBe(200);
    const r2 = await post(id, 'acknowledge', tokenBoth, { client_idempotency_key: key });
    expect(r2.statusCode).toBe(409);
    // exactly one audit row for this idempotency key path
    const audit = await db.controlOperatorAuditLog.findMany({ where: { actionId: id } });
    expect(audit).toHaveLength(1);
  });
});
