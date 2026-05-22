/**
 * #133 — issue-operator-session endpoint integration tests (REAL Postgres).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Covers the machine_token-gated op_sess_ issuance flow: an authenticated Mac/daemon
 * obtains a scoped op_sess_ for a workroom in its bound org, which it then relays to a
 * paired phone. Verifies success (issued token actually authenticates), and the no-leak
 * failure ladder: 401 (no token) → 403 (machine/id mismatch) → 409 (unbound) → 404
 * (workroom not found / cross-org).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { machineRoutes } from './machineRoutes.js';
import { verifyOperatorSession } from '@/control/operatorSessions/operatorSessionAuth.js';

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const WORKROOM = randomUUID();
const OTHER_WORKROOM = randomUUID();   // belongs to OTHER_ORG → cross-org 404

let app: FastifyInstance;
let machineId: string;
let machineToken: string;
let unboundId: string;
let unboundToken: string;

async function registerMachine(): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const res = await app.inject({
    method: 'POST', url: '/api/v1/machines/register',
    headers: { 'content-type': 'application/json' },
    payload: { machine_id: id, display_name: 'test', platform: 'darwin', arch: 'arm64' },
  });
  return { id, token: (res.json() as { machine_token: string }).machine_token };
}

function issue(id: string, body: unknown, token?: string) {
  return app.inject({
    method: 'POST', url: `/api/v1/machines/${id}/issue-operator-session`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    payload: body as object,
  });
}

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(machineRoutes);
  await app.ready();

  for (const [oid] of [[ORG], [OTHER_ORG]]) {
    await db.controlOrg.create({ data: { id: oid, name: `org ${oid.slice(0, 6)}`, slug: `iss-${randomUUID()}`, ownerUserId: randomUUID() } });
  }
  await db.controlWorkroom.create({ data: { id: WORKROOM, orgId: ORG, name: 'wr', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM, orgId: OTHER_ORG, name: 'other wr', createdBy: randomUUID() } });

  // a machine registered + bound to ORG
  const m = await registerMachine();
  machineId = m.id; machineToken = m.token;
  await db.controlMachine.update({ where: { id: machineId }, data: { orgId: ORG, boundAt: new Date() } });

  // a machine registered but NOT bound to any org
  const u = await registerMachine();
  unboundId = u.id; unboundToken = u.token;
});

afterAll(async () => {
  await db.controlOperatorSession.deleteMany({ where: { workroomId: { in: [WORKROOM, OTHER_WORKROOM] } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [machineId, unboundId] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM, OTHER_WORKROOM] } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await app.close();
  await db.$disconnect();
});

describe('#133 issue-operator-session', () => {
  it('success: bound machine → 200, issued op_sess_ authenticates + scoped to workroom + V1 commands', async () => {
    const res = await issue(machineId, { workroom_id: WORKROOM }, machineToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { op_sess_token: string; workroom_id: string; allowed_commands: string[] };
    expect(body.workroom_id).toBe(WORKROOM);
    expect(body.allowed_commands).toContain('acknowledge_needs_human');
    // the issued token must actually authenticate as an operator session for this workroom
    const session = await verifyOperatorSession(`Bearer ${body.op_sess_token}`);
    expect(session).not.toBeNull();
    expect(session!.workroomId).toBe(WORKROOM);
  });

  it('no token → 401', async () => {
    expect((await issue(machineId, { workroom_id: WORKROOM })).statusCode).toBe(401);
  });

  it('token does not match path :id → 403', async () => {
    // unbound machine's token used against the bound machine's id
    expect((await issue(machineId, { workroom_id: WORKROOM }, unboundToken)).statusCode).toBe(403);
  });

  it('machine not bound to an org → 409', async () => {
    expect((await issue(unboundId, { workroom_id: WORKROOM }, unboundToken)).statusCode).toBe(409);
  });

  it('cross-org workroom → 404 (no-leak)', async () => {
    expect((await issue(machineId, { workroom_id: OTHER_WORKROOM }, machineToken)).statusCode).toBe(404);
  });

  it('non-existent workroom → 404', async () => {
    expect((await issue(machineId, { workroom_id: randomUUID() }, machineToken)).statusCode).toBe(404);
  });
});
