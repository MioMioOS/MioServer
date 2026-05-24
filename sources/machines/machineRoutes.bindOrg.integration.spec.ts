/**
 * S2 Chunk 1 — bind-org creates a ControlAgent (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration
 *
 * Covers the S2 §1.2 behaviour: when a machine binds to an org, the server creates
 * a ControlAgent identity row for that machine (so it appears in the members list and
 * resolves a display name on its messages). The creation is idempotent — binding the
 * same machine to the same org twice must NOT create a second ControlAgent row
 * (guarded by @@unique([orgId, machineId]) + findFirst).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { machineRoutes } from './machineRoutes.js';

const ORG = randomUUID();

let app: FastifyInstance;

async function registerMachine(displayName?: string): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const res = await app.inject({
    method: 'POST', url: '/api/v1/machines/register',
    headers: { 'content-type': 'application/json' },
    payload: { machine_id: id, display_name: displayName, platform: 'darwin', arch: 'arm64' },
  });
  return { id, token: (res.json() as { machine_token: string }).machine_token };
}

function bindOrg(id: string, orgId: string, token?: string) {
  return app.inject({
    method: 'POST', url: `/api/v1/machines/${id}/bind-org`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    payload: { org_id: orgId },
  });
}

const createdMachineIds: string[] = [];

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(machineRoutes);
  await app.ready();

  await db.controlOrg.create({
    data: { id: ORG, name: `org ${ORG.slice(0, 6)}`, slug: `bindorg-${randomUUID()}`, ownerUserId: randomUUID() },
  });
});

afterAll(async () => {
  await db.controlAgent.deleteMany({ where: { orgId: ORG } });
  await db.controlMachine.deleteMany({ where: { id: { in: createdMachineIds } } });
  await db.controlOrg.deleteMany({ where: { id: ORG } });
  await app.close();
  await db.$disconnect();
});

describe('S2 bind-org → ControlAgent', () => {
  it('bind-org creates a ControlAgent for the machine (idempotent)', async () => {
    const m = await registerMachine('Mio Box');
    createdMachineIds.push(m.id);

    const res1 = await bindOrg(m.id, ORG, m.token);
    expect(res1.statusCode).toBe(200);

    // exactly one ControlAgent for this machine+org
    const agents1 = await db.controlAgent.findMany({ where: { orgId: ORG, machineId: m.id } });
    expect(agents1).toHaveLength(1);
    expect(agents1[0].machineId).toBe(m.id);
    expect(agents1[0].orgId).toBe(ORG);
    expect(agents1[0].status).toBe('online');
    // display name taken from the machine's displayName
    expect(agents1[0].displayName).toBe('Mio Box');

    // bind again → still exactly one ControlAgent row (idempotent)
    const res2 = await bindOrg(m.id, ORG, m.token);
    expect(res2.statusCode).toBe(200);

    const agents2 = await db.controlAgent.findMany({ where: { orgId: ORG, machineId: m.id } });
    expect(agents2).toHaveLength(1);
    expect(agents2[0].id).toBe(agents1[0].id); // same row, not recreated
  });

  it('bind-org falls back to a default display name when the machine has none', async () => {
    const m = await registerMachine(); // no display_name
    createdMachineIds.push(m.id);

    const res = await bindOrg(m.id, ORG, m.token);
    expect(res.statusCode).toBe(200);

    const agents = await db.controlAgent.findMany({ where: { orgId: ORG, machineId: m.id } });
    expect(agents).toHaveLength(1);
    expect(agents[0].displayName).toBe('Agent');
    expect(agents[0].name).toBe('Agent');
    expect(agents[0].role).toBe('other');
  });
});
