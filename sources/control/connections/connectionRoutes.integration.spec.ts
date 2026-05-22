/**
 * #179 — connection access + revoke endpoints, REAL Postgres integration test.
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Covers the bind→access→revoke flow: redeem now returns a connection_credential; /connections/access
 * exchanges it for short-lived read (+ operator) access; /connections/:id/revoke (self + machine_token)
 * is the kill switch; after revoke, access fails (401). Plus read-only connection, scope isolation,
 * cross-org no-leak, and auth rejections.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { machineRoutes } from '@/machines/machineRoutes';
import { operatorPairingRoutes } from '@/control/operatorSessions/operatorPairingRoutes';
import { connectionRoutes } from './connectionRoutes';
import { mintConnectionCredential } from './connectionCredential';

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const WORKROOM = randomUUID();

let app: FastifyInstance;
let machineId: string, machineToken: string;
let otherMachineId: string, otherMachineToken: string;

async function registerMachine(): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const res = await app.inject({
    method: 'POST', url: '/api/v1/machines/register',
    headers: { 'content-type': 'application/json' },
    payload: { machine_id: id, display_name: 'test', platform: 'darwin', arch: 'arm64' },
  });
  return { id, token: (res.json() as { machine_token: string }).machine_token };
}

/** Full bind: create pairing (machine_token) → redeem → return the redeem body. */
async function bindConnection(): Promise<{ connection_credential: string; connection_id: string; scopes: string[]; op_sess_token: string }> {
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
  return redeem.json() as { connection_credential: string; connection_id: string; scopes: string[]; op_sess_token: string };
}

const access = (token?: string) => app.inject({
  method: 'POST', url: '/api/v1/connections/access',
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, payload: {},
});
const revoke = (connectionId: string, token?: string) => app.inject({
  method: 'POST', url: `/api/v1/connections/${connectionId}/revoke`,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, payload: {},
});

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(machineRoutes);
  await app.register(operatorPairingRoutes);
  await app.register(connectionRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG, name: 'Conn Org', slug: `conn-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlOrg.create({ data: { id: OTHER_ORG, name: 'Other Org', slug: `other-${randomUUID()}`, ownerUserId: randomUUID() } });
  await db.controlWorkroom.create({ data: { id: WORKROOM, orgId: ORG, name: 'Conn WR', createdBy: randomUUID() } });

  const m = await registerMachine(); machineId = m.id; machineToken = m.token;
  await db.controlMachine.update({ where: { id: machineId }, data: { orgId: ORG, boundAt: new Date() } });
  const o = await registerMachine(); otherMachineId = o.id; otherMachineToken = o.token;
  await db.controlMachine.update({ where: { id: otherMachineId }, data: { orgId: OTHER_ORG, boundAt: new Date() } });
});

afterAll(async () => {
  await db.controlConnectionCredential.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlOperatorPairing.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlDevToken.deleteMany({ where: { workroomId: WORKROOM } });
  await db.controlMachine.deleteMany({ where: { id: { in: [machineId, otherMachineId] } } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await app.close();
  await db.$disconnect();
});

describe('#179 redeem now returns a connection credential', () => {
  it('redeem returns connection_credential + scopes[read,operator] + op_sess_ (back-compat)', async () => {
    const b = await bindConnection();
    expect(typeof b.connection_credential).toBe('string');
    expect(b.connection_credential.startsWith('conn_')).toBe(true);
    expect(b.scopes).toEqual(expect.arrayContaining(['read', 'operator']));
    expect(typeof b.op_sess_token).toBe('string'); // retained for transition
  });
});

describe('#179 POST /connections/access', () => {
  it('operator connection → read + operator access tokens; correct prefixes', async () => {
    const b = await bindConnection();
    const res = await access(b.connection_credential);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, string>;
    expect(body.read_access_token.startsWith('dev_ctl_')).toBe(true);
    expect(body.operator_access_token.startsWith('op_sess_')).toBe(true);
    expect(body.read_expires_at).toBeDefined();
    expect(body.operator_expires_at).toBeDefined();
  });

  it('read-only connection → read access only, no operator token (scope isolation)', async () => {
    const c = await mintConnectionCredential({ orgId: ORG, workroomId: WORKROOM, scopes: ['read'] });
    const res = await access(c.rawCredential);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, string | undefined>;
    expect(body.read_access_token).toBeDefined();
    expect(body.operator_access_token).toBeUndefined();
  });

  it('no / invalid connection credential → 401', async () => {
    expect((await access()).statusCode).toBe(401);
    expect((await access('conn_doesnotexist')).statusCode).toBe(401);
    expect((await access('dev_ctl_notaconn')).statusCode).toBe(401); // wrong class
  });
});

describe('#179 POST /connections/:id/revoke', () => {
  it('self-revoke (connection credential) → 200; access then fails 401 (kill switch)', async () => {
    const b = await bindConnection();
    expect((await access(b.connection_credential)).statusCode).toBe(200);
    const rev = await revoke(b.connection_id, b.connection_credential);
    expect(rev.statusCode).toBe(200);
    // after revoke the credential no longer exchanges for access
    expect((await access(b.connection_credential)).statusCode).toBe(401);
  });

  it('self-revoke a DIFFERENT connection id than the credential → 403', async () => {
    const b = await bindConnection();
    const other = await mintConnectionCredential({ orgId: ORG, workroomId: WORKROOM, scopes: ['read'] });
    const rev = await revoke(other.connectionId, b.connection_credential);
    expect(rev.statusCode).toBe(403);
  });

  it('machine_token (same org) → 200; cross-org machine → 404 (no-leak)', async () => {
    const c = await mintConnectionCredential({ orgId: ORG, workroomId: WORKROOM, scopes: ['read'] });
    // cross-org machine cannot see it → uniform 404
    expect((await revoke(c.connectionId, otherMachineToken)).statusCode).toBe(404);
    // same-org machine revokes
    expect((await revoke(c.connectionId, machineToken)).statusCode).toBe(200);
  });

  it('no auth → 401; non-uuid → 404', async () => {
    expect((await revoke(randomUUID())).statusCode).toBe(401);
    expect((await revoke('not-a-uuid', machineToken)).statusCode).toBe(404);
  });
});
