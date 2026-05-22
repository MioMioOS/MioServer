/**
 * #179 — connection-credential ABUSE / edge-case security review (REAL Postgres).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * PM-requested strict-lane review. Covers the 6 abuse vectors:
 *   1. refresh race — concurrent /access produce independent valid tokens, no corruption.
 *   2. revoke-during-inflight — revoke stops NEW access; documents the BOUNDED SEAM: an
 *      already-minted access token survives until its own TTL (by design C2 — exposure ≤ access TTL).
 *   3. expiry boundary — expired connection → 401 (covered in connectionCredential spec; reaffirmed).
 *   4. replay — redeemed pairing code → 403; revoked connection /access → 401.
 *   5. scope escalation — read-only connection never yields an operator token (incl. after rotate).
 *   6. multi-device — revoking one connection does NOT affect another in the same workroom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { machineRoutes } from '@/machines/machineRoutes';
import { operatorPairingRoutes } from '@/control/operatorSessions/operatorPairingRoutes';
import { connectionRoutes } from './connectionRoutes';
import { taskRoutes } from '@/control/tasks/taskRoutes';
import { mintConnectionCredential, rotateConnectionCredential } from './connectionCredential';

const ORG = randomUUID();
const WORKROOM = randomUUID();
let app: FastifyInstance;
let machineId: string, machineToken: string;

async function registerMachine() {
  const id = randomUUID();
  const res = await app.inject({
    method: 'POST', url: '/api/v1/machines/register',
    headers: { 'content-type': 'application/json' },
    payload: { machine_id: id, display_name: 't', platform: 'darwin', arch: 'arm64' },
  });
  return { id, token: (res.json() as { machine_token: string }).machine_token };
}
/** Full bind → returns the redeem body (connection_credential + connection_id). */
async function bind(): Promise<{ connection_credential: string; connection_id: string }> {
  const create = await app.inject({
    method: 'POST', url: `/api/v1/machines/${machineId}/pairings`,
    headers: { authorization: `Bearer ${machineToken}`, 'content-type': 'application/json' },
    payload: { workroom_id: WORKROOM },
  });
  const code = (create.json() as { code: string }).code;
  const redeem = await app.inject({
    method: 'POST', url: `/api/v1/pairings/${encodeURIComponent(code)}/redeem`,
    headers: { 'content-type': 'application/json' }, payload: {},
  });
  return redeem.json() as { connection_credential: string; connection_id: string };
}
const access = (cc: string) => app.inject({
  method: 'POST', url: '/api/v1/connections/access',
  headers: { authorization: `Bearer ${cc}`, 'content-type': 'application/json' }, payload: {},
});
const revoke = (id: string, cc: string) => app.inject({
  method: 'POST', url: `/api/v1/connections/${id}/revoke`,
  headers: { authorization: `Bearer ${cc}`, 'content-type': 'application/json' }, payload: {},
});
const getTasks = (token: string) => app.inject({
  method: 'GET', url: `/api/v1/workrooms/${WORKROOM}/tasks`,
  headers: { authorization: `Bearer ${token}` },
});

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(machineRoutes);
  await app.register(operatorPairingRoutes);
  await app.register(connectionRoutes);
  await app.register(taskRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG, name: 'Abuse Org', slug: `abuse-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: WORKROOM, orgId: ORG, name: 'Abuse WR', createdBy: randomUUID() } });
  const m = await registerMachine(); machineId = m.id; machineToken = m.token;
  await db.controlMachine.update({ where: { id: machineId }, data: { orgId: ORG, boundAt: new Date() } });
});

afterAll(async () => {
  await db.controlConnectionCredential.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlOperatorPairing.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlDevToken.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlMachine.deleteMany({ where: { id: machineId } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM } });
  await db.controlOrg.deleteMany({ where: { id: ORG } });
  await app.close();
  await db.$disconnect();
});

describe('#179 abuse — vector 1: refresh race (concurrent /access)', () => {
  it('two concurrent /access both succeed with DISTINCT tokens (no corruption)', async () => {
    const c = await bind();
    const [r1, r2] = await Promise.all([access(c.connection_credential), access(c.connection_credential)]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const t1 = (r1.json() as { read_access_token: string }).read_access_token;
    const t2 = (r2.json() as { read_access_token: string }).read_access_token;
    expect(t1).not.toBe(t2); // independent short-lived tokens; both valid (same scope) — acceptable
    expect((await getTasks(t1)).statusCode).toBe(200);
    expect((await getTasks(t2)).statusCode).toBe(200);
  });
});

describe('#179 abuse — vector 2: revoke-during-inflight (BOUNDED SEAM, by design C2)', () => {
  it('revoke stops NEW access (401); but a pre-minted access token survives until its TTL', async () => {
    const c = await bind();
    const a = (await access(c.connection_credential)).json() as { read_access_token: string };
    expect((await getTasks(a.read_access_token)).statusCode).toBe(200); // valid before revoke

    expect((await revoke(c.connection_id, c.connection_credential)).statusCode).toBe(200);

    // NEW access is killed immediately:
    expect((await access(c.connection_credential)).statusCode).toBe(401);
    // SEAM (documented, by design): the already-minted read access token still validates until its
    // own ~1h TTL — revocation bounds exposure to the access TTL, it is not instant for live tokens.
    expect((await getTasks(a.read_access_token)).statusCode).toBe(200);
  });
});

describe('#179 abuse — vector 4: replay', () => {
  it('redeemed pairing code cannot be replayed (second redeem → 403)', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/machines/${machineId}/pairings`,
      headers: { authorization: `Bearer ${machineToken}`, 'content-type': 'application/json' },
      payload: { workroom_id: WORKROOM },
    });
    const code = (create.json() as { code: string }).code;
    const first = await app.inject({ method: 'POST', url: `/api/v1/pairings/${code}/redeem`, headers: { 'content-type': 'application/json' }, payload: {} });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: `/api/v1/pairings/${code}/redeem`, headers: { 'content-type': 'application/json' }, payload: {} });
    expect(second.statusCode).toBe(403); // one-time consume honored
  });

  it('revoked connection cannot replay /access (401)', async () => {
    const c = await bind();
    await revoke(c.connection_id, c.connection_credential);
    expect((await access(c.connection_credential)).statusCode).toBe(401);
  });
});

describe('#179 abuse — vector 5: scope escalation', () => {
  it('read-only connection never yields an operator token (incl. after rotate)', async () => {
    const c = await mintConnectionCredential({ orgId: ORG, workroomId: WORKROOM, scopes: ['read'] });
    const body = (await access(c.rawCredential)).json() as Record<string, unknown>;
    expect(body.read_access_token).toBeDefined();
    expect(body.operator_access_token).toBeUndefined();

    // rotation must carry the SAME (read-only) scope — no escalation through rotate.
    const next = await rotateConnectionCredential(c.connectionId);
    const body2 = (await access(next.rawCredential)).json() as Record<string, unknown>;
    expect(body2.operator_access_token).toBeUndefined();
  });
});

describe('#179 abuse — vector 6: multi-device isolation', () => {
  it('revoking one connection does NOT affect another in the same workroom', async () => {
    const a = await bind();
    const b = await bind();
    // both usable
    expect((await access(a.connection_credential)).statusCode).toBe(200);
    expect((await access(b.connection_credential)).statusCode).toBe(200);
    // revoke A only
    await revoke(a.connection_id, a.connection_credential);
    expect((await access(a.connection_credential)).statusCode).toBe(401); // A dead
    expect((await access(b.connection_credential)).statusCode).toBe(200); // B unaffected
  });

  it('one connection cannot revoke another (self-revoke scope)', async () => {
    const a = await bind();
    const b = await bind();
    // A's credential trying to revoke B's id → 403 (can only self-revoke)
    expect((await revoke(b.connection_id, a.connection_credential)).statusCode).toBe(403);
    // B still works
    expect((await access(b.connection_credential)).statusCode).toBe(200);
  });
});
