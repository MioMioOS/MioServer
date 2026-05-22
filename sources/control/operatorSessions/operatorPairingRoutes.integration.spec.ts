/**
 * #153 — operator pairing (opaque, mint-at-redeem) integration tests (REAL Postgres).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Covers the Mac→phone onboarding pairing: create (machine_token, opaque payload, NO raw token),
 * redeem (unauthenticated opaque code → mint op_sess_ once, one-time, expiry, uniform 403), and
 * cancel (machine_token). Verifies the redeemed op_sess_ actually authenticates + is workroom-scoped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { machineRoutes } from '@/machines/machineRoutes';
import { operatorPairingRoutes } from './operatorPairingRoutes.js';
import { verifyOperatorSession } from '@/control/operatorSessions/operatorSessionAuth.js';

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const WORKROOM = randomUUID();
const OTHER_WORKROOM = randomUUID();

let app: FastifyInstance;
let machineId: string, machineToken: string;
let unboundId: string, unboundToken: string;

async function registerMachine(): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const res = await app.inject({
    method: 'POST', url: '/api/v1/machines/register',
    headers: { 'content-type': 'application/json' },
    payload: { machine_id: id, display_name: 'test', platform: 'darwin', arch: 'arm64' },
  });
  return { id, token: (res.json() as { machine_token: string }).machine_token };
}
function createPairing(id: string, body: unknown, token?: string) {
  return app.inject({
    method: 'POST', url: `/api/v1/machines/${id}/pairings`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    payload: body as object,
  });
}
function redeem(code: string) {
  return app.inject({
    method: 'POST', url: `/api/v1/pairings/${encodeURIComponent(code)}/redeem`,
    headers: { 'content-type': 'application/json' }, payload: {},
  });
}
function cancel(id: string, pairingId: string, token?: string) {
  return app.inject({
    method: 'DELETE', url: `/api/v1/machines/${id}/pairings/${pairingId}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}
type CreateBody = { pairing_id: string; code: string; workroom_display: string; scope_label: string; expires_at: string; op_sess_token?: string };
type RedeemBody = { op_sess_token: string; workroom_id: string; org_id: string; allowed_commands: string[]; expires_at: string };

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(machineRoutes);
  await app.register(operatorPairingRoutes);
  await app.ready();

  for (const oid of [ORG, OTHER_ORG]) {
    await db.controlOrg.create({ data: { id: oid, name: `org ${oid.slice(0, 6)}`, slug: `pair-${randomUUID()}`, ownerUserId: randomUUID() } });
  }
  await db.controlWorkroom.create({ data: { id: WORKROOM, orgId: ORG, name: 'Pair WR', createdBy: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: OTHER_WORKROOM, orgId: OTHER_ORG, name: 'Other WR', createdBy: randomUUID() } });

  const m = await registerMachine(); machineId = m.id; machineToken = m.token;
  await db.controlMachine.update({ where: { id: machineId }, data: { orgId: ORG, boundAt: new Date() } });
  const u = await registerMachine(); unboundId = u.id; unboundToken = u.token;
});

afterAll(async () => {
  await db.controlOperatorSession.deleteMany({ where: { workroomId: { in: [WORKROOM, OTHER_WORKROOM] } } });
  await db.controlOperatorPairing.deleteMany({ where: { workroomId: { in: [WORKROOM, OTHER_WORKROOM] } } });
  await db.controlMachine.deleteMany({ where: { id: { in: [machineId, unboundId] } } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM, OTHER_WORKROOM] } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await app.close();
  await db.$disconnect();
});

describe('#153 operator pairing (opaque, mint-at-redeem)', () => {
  it('create: bound machine → 201 opaque payload, NO raw token', async () => {
    const res = await createPairing(machineId, { workroom_id: WORKROOM }, machineToken);
    expect(res.statusCode).toBe(201);
    const b = res.json() as CreateBody;
    expect(b.pairing_id).toBeTruthy();
    expect(typeof b.code).toBe('string');
    expect(b.workroom_display).toBe('Pair WR');
    expect(b.scope_label).toBeTruthy();
    expect(b.expires_at).toBeTruthy();
    // no-leak: NO op_sess_ token anywhere; opaque code is not an op_sess_/dev_ctl_ token
    expect(res.body).not.toMatch(/op_sess_|dev_ctl_/);
    expect(b.op_sess_token).toBeUndefined();
    expect(b.code.startsWith('op_sess_')).toBe(false);
  });

  it('create auth ladder: 401 / 403 / 409 / 404(cross-org) / 404(nonexistent)', async () => {
    expect((await createPairing(machineId, { workroom_id: WORKROOM })).statusCode).toBe(401);
    expect((await createPairing(machineId, { workroom_id: WORKROOM }, unboundToken)).statusCode).toBe(403);
    expect((await createPairing(unboundId, { workroom_id: WORKROOM }, unboundToken)).statusCode).toBe(409);
    expect((await createPairing(machineId, { workroom_id: OTHER_WORKROOM }, machineToken)).statusCode).toBe(404);
    expect((await createPairing(machineId, { workroom_id: randomUUID() }, machineToken)).statusCode).toBe(404);
  });

  it('redeem: valid code → 200 mints op_sess_ that authenticates + scoped to workroom + V1 commands', async () => {
    const code = (await createPairing(machineId, { workroom_id: WORKROOM }, machineToken)).json() as CreateBody;
    const res = await redeem(code.code);
    expect(res.statusCode).toBe(200);
    const b = res.json() as RedeemBody;
    expect(b.op_sess_token.startsWith('op_sess_')).toBe(true);
    expect(b.workroom_id).toBe(WORKROOM);
    expect(b.allowed_commands).toContain('acknowledge_needs_human');
    const session = await verifyOperatorSession(`Bearer ${b.op_sess_token}`);
    expect(session).not.toBeNull();
    expect(session!.workroomId).toBe(WORKROOM);
  });

  it('redeem is one-time: second redeem of same code → 403', async () => {
    const code = (await createPairing(machineId, { workroom_id: WORKROOM }, machineToken)).json() as CreateBody;
    expect((await redeem(code.code)).statusCode).toBe(200);
    expect((await redeem(code.code)).statusCode).toBe(403);
  });

  it('redeem unknown / malformed code → uniform 403', async () => {
    expect((await redeem('not-a-real-code')).statusCode).toBe(403);
    expect((await redeem(randomUUID())).statusCode).toBe(403);
  });

  it('redeem expired code → 403', async () => {
    const created = (await createPairing(machineId, { workroom_id: WORKROOM }, machineToken)).json() as CreateBody;
    await db.controlOperatorPairing.update({ where: { id: created.pairing_id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeem(created.code)).statusCode).toBe(403);
  });

  it('cancel: creating machine cancels → 200, then redeem → 403', async () => {
    const created = (await createPairing(machineId, { workroom_id: WORKROOM }, machineToken)).json() as CreateBody;
    expect((await cancel(machineId, created.pairing_id, machineToken)).statusCode).toBe(200);
    expect((await redeem(created.code)).statusCode).toBe(403);
  });

  it('cancel: token≠id → 403 ; not-the-creator → 404 ; nonexistent → 404 ; no token → 401', async () => {
    const created = (await createPairing(machineId, { workroom_id: WORKROOM }, machineToken)).json() as CreateBody;
    expect((await cancel(machineId, created.pairing_id, unboundToken)).statusCode).toBe(403); // token's machine ≠ path id
    expect((await cancel(unboundId, created.pairing_id, unboundToken)).statusCode).toBe(404); // valid machine, not creator
    expect((await cancel(machineId, randomUUID(), machineToken)).statusCode).toBe(404);
    expect((await cancel(machineId, created.pairing_id)).statusCode).toBe(401);
  });
});
