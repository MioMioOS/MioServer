/**
 * DELETE /api/v1/machines/:id — per-machine hard-delete integration suite.
 *
 * Regression target: the phone's 监控 tab "Delete" used to call leaveWorkroom (workroom-scoped),
 * which dropped EVERY machine in that org from the aggregated computer list — "deleted 1 computer,
 * 3 vanished". The fix is a per-machine DELETE that removes exactly ONE ControlMachine row.
 *
 * Contracts:
 *   D1 — owner deletes ONE machine in an org that has TWO → 200 { deleted:true }; that machine gone,
 *        the SIBLING machine still exists, the workroom is NOT archived, the org survives.
 *   D2 — a user who is NOT an owner of the machine's org → 403 FORBIDDEN; machine still exists.
 *   D3 — unknown machine id → 404 MACHINE_NOT_FOUND.
 *   D4 — missing / expired session → 401 INVALID_SESSION; machine still exists.
 *   D5 — machine with a ControlSession row (NO ACTION FK) → 200; session survives with machineId nulled
 *        (proves the delete is not FK-blocked and we null the child ref, not delete the session).
 *
 * Run: npm run test:db:setup && npm run test:integration -- \
 *        sources/control/workrooms/workspaceMembershipRoutes.deleteMachine.integration.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { workspaceMembershipRoutes } from './workspaceMembershipRoutes.js';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID();

let app: FastifyInstance;
let ownerId = '';
let strangerId = ''; // owner of OTHER_ORG only — NOT an owner of ORG_ID → used by D2
let ownerToken = '';
let strangerToken = '';
let expiredToken = '';

const createdMachineIds = new Set<string>();
const createdSessionIds = new Set<string>();

async function makeMachine(orgId: string, name = `mac-${randomUUID().slice(0, 8)}`): Promise<string> {
  const m = await db.controlMachine.create({
    data: {
      orgId,
      displayName: name,
      tokenHash: `hash-${randomUUID()}`,
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });
  createdMachineIds.add(m.id);
  return m.id;
}

function del(id: string, token: string | undefined) {
  return app.inject({
    method: 'DELETE',
    url: `/api/v1/machines/${id}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(workspaceMembershipRoutes);
  await app.ready();

  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'Del Org', slug: `del-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlOrg.create({
    data: { id: OTHER_ORG_ID, name: 'Other Org', slug: `other-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Del WR', createdBy: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: OTHER_WORKROOM_ID, orgId: OTHER_ORG_ID, name: 'Other WR', createdBy: randomUUID() },
  });

  const owner = await db.user.create({
    data: { email: `del-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  ownerId = owner.id;
  await db.userWorkroomMembership.create({ data: { userId: ownerId, workroomId: WORKROOM_ID, role: 'owner' } });
  ownerToken = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: ownerId, tokenHash: hashUserSessionToken(ownerToken), expiresAt: new Date(Date.now() + 86_400_000) },
  });

  // Stranger: owner of OTHER_ORG only, so they do NOT own machines in ORG_ID.
  const stranger = await db.user.create({
    data: { email: `del-x-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  strangerId = stranger.id;
  await db.userWorkroomMembership.create({ data: { userId: strangerId, workroomId: OTHER_WORKROOM_ID, role: 'owner' } });
  strangerToken = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: strangerId, tokenHash: hashUserSessionToken(strangerToken), expiresAt: new Date(Date.now() + 86_400_000) },
  });

  expiredToken = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: ownerId, tokenHash: hashUserSessionToken(expiredToken), expiresAt: new Date(Date.now() - 60_000) },
  });
});

afterAll(async () => {
  if (createdSessionIds.size > 0) {
    await db.controlSession.deleteMany({ where: { id: { in: [...createdSessionIds] } } }).catch(() => {});
  }
  await db.controlSession.deleteMany({ where: { orgId: { in: [ORG_ID, OTHER_ORG_ID] } } }).catch(() => {});
  await db.controlMachine.deleteMany({ where: { orgId: { in: [ORG_ID, OTHER_ORG_ID] } } }).catch(() => {});
  await db.userSession.deleteMany({ where: { userId: { in: [ownerId, strangerId] } } }).catch(() => {});
  await db.userWorkroomMembership.deleteMany({ where: { userId: { in: [ownerId, strangerId] } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {});
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } }).catch(() => {});
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } }).catch(() => {});
  await app.close();
  await db.$disconnect();
});

describe('DELETE /api/v1/machines/:id — per-machine hard delete', () => {
  it('D1: owner deletes ONE of TWO machines → only that one is gone; sibling + workroom survive', async () => {
    const a = await makeMachine(ORG_ID, 'machine-A');
    const b = await makeMachine(ORG_ID, 'machine-B');

    const res = await del(a, ownerToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ machine_id: a, deleted: true });

    expect(await db.controlMachine.findUnique({ where: { id: a } })).toBeNull();
    // The whole point of the fix: the sibling is untouched.
    expect(await db.controlMachine.findUnique({ where: { id: b } })).not.toBeNull();
    // Deleting a machine must NOT archive the workroom (that was the old leaveWorkroom behavior).
    const wr = await db.controlWorkroom.findUnique({ where: { id: WORKROOM_ID }, select: { archivedAt: true } });
    expect(wr?.archivedAt).toBeNull();
    // Org survives.
    expect(await db.controlOrg.findUnique({ where: { id: ORG_ID } })).not.toBeNull();
  });

  it('D2: a non-owner of the machine\'s org → 403 FORBIDDEN; machine still exists', async () => {
    const m = await makeMachine(ORG_ID);
    const res = await del(m, strangerToken);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect(await db.controlMachine.findUnique({ where: { id: m } })).not.toBeNull();
  });

  it('D3: unknown machine id → 404 MACHINE_NOT_FOUND', async () => {
    const res = await del(randomUUID(), ownerToken);
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('MACHINE_NOT_FOUND');
  });

  it('D4: missing or expired session → 401; machine survives', async () => {
    const m = await makeMachine(ORG_ID);
    const noAuth = await del(m, undefined);
    expect(noAuth.statusCode).toBe(401);
    const expired = await del(m, expiredToken);
    expect(expired.statusCode).toBe(401);
    expect(await db.controlMachine.findUnique({ where: { id: m } })).not.toBeNull();
  });

  it('D5: machine with a ControlSession (NO ACTION FK) → 200; session survives with machineId nulled', async () => {
    const m = await makeMachine(ORG_ID);
    const s = await db.controlSession.create({
      data: {
        orgId: ORG_ID,
        workroomId: WORKROOM_ID,
        machineId: m,
        mode: 'daemon',
        runtime: 'claude',
        displayName: 'sess-1',
      },
      select: { id: true },
    });
    createdSessionIds.add(s.id);

    const res = await del(m, ownerToken);
    expect(res.statusCode).toBe(200);

    expect(await db.controlMachine.findUnique({ where: { id: m } })).toBeNull();
    const session = await db.controlSession.findUnique({ where: { id: s.id }, select: { machineId: true } });
    expect(session).not.toBeNull(); // session row is NOT deleted...
    expect(session?.machineId).toBeNull(); // ...its machine ref is nulled.
  });
});
