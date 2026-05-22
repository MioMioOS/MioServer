/**
 * #141 — GET /actions evidence/log flatten + server-side redaction (REAL Postgres).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Plan B: Evidence / Runtime Log pushed pages (CodeLight) are driven by the LATEST
 * reconciliation's output_summary / raw_log_redacted, flattened onto GET /actions(/:id) and
 * GET /workrooms/:id/actions, and RE-REDACTED server-side (defense-in-depth) even though the
 * daemon is contracted to send pre-redacted text. Verifies: flatten present, latest-wins across
 * multiple reconciliations, secrets scrubbed, and null when an action has no reconciliation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { actionRoutes } from './actionRoutes';

const ORG_ID = randomUUID();
const AGENT_ID = randomUUID();
const WORKROOM = randomUUID();
const SESSION = randomUUID();
let ACTION_WITH_EVIDENCE = '';
let ACTION_NO_EVIDENCE = '';

const RAW_DEV = `dev_ctl_${randomUUID().replace(/-/g, '')}`;
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

let app: FastifyInstance;
const get = (url: string, token = RAW_DEV) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

async function seedAction(status: string): Promise<string> {
  const id = randomUUID();
  await db.controlAction.create({
    data: {
      id, sessionId: SESSION, workroomId: WORKROOM, actorAgentId: AGENT_ID,
      kind: 'deploy', summary: 'evidence flatten test action',
      reversibility: 'reversible', riskLevel: 'low', requiresApproval: false,
      status, clientIdempotencyKey: `idem-${randomUUID()}`,
    },
  });
  return id;
}

beforeAll(async () => {
  app = fastify();
  await app.register(actionRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'EvF Org', slug: `evf-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, name: 'evf-agent', displayName: 'EvF', role: 'ops' } });
  await db.controlWorkroom.create({ data: { id: WORKROOM, orgId: ORG_ID, name: 'evf-wr', createdBy: randomUUID() } });
  await db.controlSession.create({ data: { id: SESSION, orgId: ORG_ID, workroomId: WORKROOM, machineId: null, mode: 'daemon', runtime: 'claude', displayName: 'evf-session' } });

  ACTION_WITH_EVIDENCE = await seedAction('needs_human');
  ACTION_NO_EVIDENCE = await seedAction('fired');

  // Two reconciliations on the same action (createdAt order): the later one wins.
  // Both contain secret-shaped content that MUST be redacted on the way out.
  await db.controlActionReconciliation.create({
    data: {
      id: randomUUID(), actionId: ACTION_WITH_EVIDENCE, evidenceId: 'ev-old',
      reasonCode: 'fire_response_lost_token_unrecoverable', machineId: randomUUID(),
      outputSummary: 'OLD summary leaking dev_ctl_OLD00000000000000000000000000',
      rawLogRedacted: 'old log /tmp/mio-secret-old.token',
      createdAt: new Date(Date.now() - 60_000),
    },
  });
  await db.controlActionReconciliation.create({
    data: {
      id: randomUUID(), actionId: ACTION_WITH_EVIDENCE, evidenceId: 'ev-new',
      reasonCode: 'drain_deadline_exceeded', machineId: randomUUID(),
      outputSummary: '部署完成，等待人工确认（token dev_ctl_NEW11111111111111111111111111 已轮换）',
      rawLogRedacted: '[runtime] cleaned /var/folders/zz/qm/T/mio-secret-new-xyz done',
      createdAt: new Date(),
    },
  });

  await db.controlDevToken.create({ data: { tokenHash: hash(RAW_DEV), orgId: ORG_ID, workroomId: WORKROOM, scope: 'read_only', expiresAt: new Date(Date.now() + 3600_000) } });
});

afterAll(async () => {
  await db.controlActionReconciliation.deleteMany({ where: { actionId: { in: [ACTION_WITH_EVIDENCE, ACTION_NO_EVIDENCE] } } });
  await db.controlDevToken.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlAction.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlSession.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await app.close();
  await db.$disconnect();
});

describe('#141 evidence/log flatten + redaction', () => {
  it('GET /actions/:id flattens LATEST reconciliation output_summary + raw_log_redacted', async () => {
    const res = await get(`/api/v1/actions/${ACTION_WITH_EVIDENCE}`);
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    // latest-wins: the newer reconciliation's content (not the old one)
    expect(b.output_summary).toContain('部署完成');
    expect(b.output_summary).not.toContain('OLD summary');
    expect(b.raw_log_redacted).toContain('[runtime]');
  });

  it('flattened fields are RE-REDACTED server-side (no token/path leaks)', async () => {
    const res = await get(`/api/v1/actions/${ACTION_WITH_EVIDENCE}`);
    const b = JSON.parse(res.body);
    expect(b.output_summary).not.toMatch(/dev_ctl_/);
    expect(b.raw_log_redacted).not.toMatch(/\/var\/folders|\/tmp\/mio-/);
    expect(b.output_summary).toContain('[REDACTED]');
    expect(b.raw_log_redacted).toContain('[REDACTED]');
    // whole body carries no secret token/path shapes
    expect(res.body).not.toMatch(/dev_ctl_(?!FAKE)[A-Za-z0-9]/);
  });

  it('action with NO reconciliation -> output_summary / raw_log_redacted null', async () => {
    const res = await get(`/api/v1/actions/${ACTION_NO_EVIDENCE}`);
    expect(res.statusCode).toBe(200);
    const b = JSON.parse(res.body);
    expect(b.output_summary).toBeNull();
    expect(b.raw_log_redacted).toBeNull();
  });

  it('GET /workrooms/:id/actions list also flattens + redacts per action', async () => {
    const res = await get(`/api/v1/workrooms/${WORKROOM}/actions`);
    expect(res.statusCode).toBe(200);
    const items = JSON.parse(res.body).items as Array<{ action_id: string; output_summary: string | null; raw_log_redacted: string | null }>;
    const withEv = items.find((a) => a.action_id === ACTION_WITH_EVIDENCE)!;
    const noEv = items.find((a) => a.action_id === ACTION_NO_EVIDENCE)!;
    expect(withEv.output_summary).toContain('部署完成');
    expect(withEv.output_summary).not.toMatch(/dev_ctl_/);
    expect(withEv.raw_log_redacted).not.toMatch(/\/var\/folders/);
    expect(noEv.output_summary).toBeNull();
    expect(noEv.raw_log_redacted).toBeNull();
  });
});
