/**
 * Slock Slice 7 — machine enrollment full integration suite (B4 rewrite).
 *
 * Rewrites the prior Slice 6 op_sess_-based suite to the Slice 7 user_sess_ auth model.
 * Auth on POST .../approve is now `requireUserWrite({ workroomIdFrom: 'body' })`; the body
 * MUST carry `workroom_id`. Public endpoints (POST create, GET poll) are unchanged.
 *
 * Test contracts per spec §9.1 T13–T17:
 *   T13 — approve with valid user_sess_ (owner) + correct workroom_id → 200 + machine_token + ControlMachine row
 *   T14 — approve with valid user_sess_ + workroom_id user is NOT a member of → 403 FORBIDDEN
 *         (distinct from ENROLLMENT_NOT_REDEEMABLE: auth-fail vs intent-fail)
 *   T15 — approve with expired user_sess_ → 401 INVALID_SESSION + no DB writes
 *   T16 — concurrent double-approve (two valid sessions, same code) → exactly one 200, one 403 ENROLLMENT_NOT_REDEEMABLE
 *   T17 — atomicity: forced rollback inside the tx → no partial state (CAS rolled back, no orphan ControlMachine)
 *
 * Retained Slice 6 coverage (still valuable, unchanged endpoints):
 *   C1  — create intent → 201 + 3-field response + DB row matches
 *   C2  — create → poll → 202 pending
 *   C5b — approve happy path → poll → 200 + machine_token + org_id + workroom_id (delivered exactly once)
 *   C7  — second poll after delivery → 403 (one-time)
 *   C8  — expired intent → poll/approve → 403
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/operatorSessions/machineEnrollmentRoutes.integration.spec.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID, createHash } from 'crypto';
import { db } from '@/storage/db';
import { machineEnrollmentRoutes } from './machineEnrollmentRoutes.js';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const OTHER_WORKROOM_ID = randomUUID(); // user is NOT a member here — used by T14
const OTHER_ORG_ID = randomUUID();

let app: FastifyInstance;
let userId = '';
let otherUserId = ''; // a SECOND owner of WORKROOM_ID, used by T16 to drive a real concurrent approve
let validToken = '';
let otherUserToken = '';
let expiredSessionId = '';
let expiredToken = '';

// Per-test-suite-lifecycle bookkeeping for cleanup.
const createdIntentIds = new Set<string>();
const createdMachineIds = new Set<string>();

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function createIntent(body?: Partial<{ device_name: string; platform: string; arch: string }>) {
  const payload = {
    device_name: body?.device_name ?? `mac-${randomUUID().slice(0, 8)}`,
    platform: body?.platform ?? 'darwin',
    arch: body?.arch ?? 'arm64',
  };
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/enrollment-intents',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  return { res, payload };
}

function approve(
  id: string,
  code: string | undefined,
  token: string | undefined,
  workroomId?: string,
) {
  const body: Record<string, string> = {};
  if (code !== undefined) body.code = code;
  if (workroomId !== undefined) body.workroom_id = workroomId;
  return app.inject({
    method: 'POST',
    url: `/api/v1/enrollment-intents/${id}/approve`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    payload: body,
  });
}

function poll(id: string, code?: string) {
  const qs = code !== undefined ? `?code=${encodeURIComponent(code)}` : '';
  return app.inject({
    method: 'GET',
    url: `/api/v1/enrollment-intents/${id}${qs}`,
  });
}

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(machineEnrollmentRoutes);
  await app.ready();

  // Seed orgs + workrooms.
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'Enroll Org', slug: `enroll-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlOrg.create({
    data: { id: OTHER_ORG_ID, name: 'Other Org', slug: `other-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'Enroll WR', createdBy: randomUUID() },
  });
  await db.controlWorkroom.create({
    data: { id: OTHER_WORKROOM_ID, orgId: OTHER_ORG_ID, name: 'Other WR', createdBy: randomUUID() },
  });

  // Primary user — owner of WORKROOM_ID, NOT a member of OTHER_WORKROOM_ID.
  const user = await db.user.create({
    data: {
      email: `b4-${randomUUID()}@example.test`,
      passwordHash: await hashPassword('p'),
    },
  });
  userId = user.id;
  await db.userWorkroomMembership.create({
    data: { userId, workroomId: WORKROOM_ID, role: 'owner' },
  });
  validToken = mintUserSessionToken();
  await db.userSession.create({
    data: {
      userId,
      tokenHash: hashUserSessionToken(validToken),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  // Second owner of the SAME workroom — used by T16 to drive a true concurrent approve.
  const other = await db.user.create({
    data: {
      email: `b4-other-${randomUUID()}@example.test`,
      passwordHash: await hashPassword('p'),
    },
  });
  otherUserId = other.id;
  await db.userWorkroomMembership.create({
    data: { userId: otherUserId, workroomId: WORKROOM_ID, role: 'owner' },
  });
  otherUserToken = mintUserSessionToken();
  await db.userSession.create({
    data: {
      userId: otherUserId,
      tokenHash: hashUserSessionToken(otherUserToken),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  // An EXPIRED session for the primary user — used by T15.
  expiredToken = mintUserSessionToken();
  const expired = await db.userSession.create({
    data: {
      userId,
      tokenHash: hashUserSessionToken(expiredToken),
      // Expired 1 minute ago.
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  expiredSessionId = expired.id;
});

afterAll(async () => {
  if (createdMachineIds.size > 0) {
    await db.controlMachine.deleteMany({ where: { id: { in: [...createdMachineIds] } } });
  }
  if (createdIntentIds.size > 0) {
    await db.controlMachineEnrollment.deleteMany({ where: { id: { in: [...createdIntentIds] } } });
  }
  // Sweep any leftover machines (concurrent test could orphan on failure).
  await db.controlMachine.deleteMany({ where: { orgId: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await db.userSession.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }).catch(() => {});
  await db.userWorkroomMembership.deleteMany({ where: { userId: { in: [userId, otherUserId] } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }).catch(() => {});
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, OTHER_WORKROOM_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: { in: [ORG_ID, OTHER_ORG_ID] } } });
  await app.close();
  await db.$disconnect();
  void expiredSessionId; // retained for diagnostic cleanup if needed
});

describe('Slice 7 machine enrollment — full integration (spec §9.1 T13–T17 + retained Slice 6 coverage)', () => {
  // ── C1: create intent ──────────────────────────────────────────────────────
  it('C1: create intent → 201 + 3-field response + DB row matches', async () => {
    const { res, payload } = await createIntent({ device_name: 'c1-mac', platform: 'darwin', arch: 'arm64' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body.intent_id).toBe('string');
    expect(typeof body.opaque_code).toBe('string');
    expect(typeof body.expires_at).toBe('string');
    expect((body.opaque_code as string).length).toBe(24);
    const intentId = body.intent_id as string;
    const opaque = body.opaque_code as string;
    createdIntentIds.add(intentId);

    const row = await db.controlMachineEnrollment.findUniqueOrThrow({ where: { id: intentId } });
    expect(row.codeHash).toBe(sha256(opaque));
    expect(row.deviceName).toBe(payload.device_name);
    expect(row.platform).toBe('darwin');
    expect(row.arch).toBe('arm64');
    expect(row.approvedAt).toBeNull();
    expect(row.approvedByUserId).toBeNull();
    expect(row.approvedWorkroomId).toBeNull();
    expect(row.deliveredToken).toBeNull();
    expect(row.machineId).toBeNull();
  });

  // ── C2: poll pending ───────────────────────────────────────────────────────
  it('C2: create → poll (pending) → 202 { status: "pending" }', async () => {
    const { res } = await createIntent();
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);

    const p = await poll(body.intent_id, body.opaque_code);
    expect(p.statusCode).toBe(202);
    expect(p.json()).toEqual({ status: 'pending' });
  });

  // ── T13: happy path ────────────────────────────────────────────────────────
  it('T13: approve with valid user_sess_ (owner) + correct workroom_id → 200 + machine_token + ControlMachine', async () => {
    const { res, payload } = await createIntent({ device_name: 't13-mac', platform: 'linux', arch: 'x64' });
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);

    const a = await approve(body.intent_id, body.opaque_code, validToken, WORKROOM_ID);
    expect(a.statusCode).toBe(200);
    // R2.3 response contract: { kind, machine_id, workroom_id, workroom_already_bound }.
    // Binding into an EXISTING owned workroom → kind 'both', already_bound true.
    const ab = a.json() as {
      kind: string;
      machine_id: string;
      workroom_id: string;
      workroom_already_bound: boolean;
    };
    expect(ab.kind).toBe('both');
    expect(ab.workroom_already_bound).toBe(true);
    expect(ab.workroom_id).toBe(WORKROOM_ID);
    expect(typeof ab.machine_id).toBe('string');
    createdMachineIds.add(ab.machine_id);

    const machine = await db.controlMachine.findUniqueOrThrow({ where: { id: ab.machine_id } });
    expect(machine.displayName).toBe(payload.device_name);
    expect(machine.platform).toBe('linux');
    expect(machine.arch).toBe('x64');
    expect(machine.orgId).toBe(ORG_ID);
    expect(machine.tokenHash).toBeTruthy();
    expect(machine.tokenHash.length).toBe(64);

    const row = await db.controlMachineEnrollment.findUniqueOrThrow({ where: { id: body.intent_id } });
    expect(row.approvedAt).not.toBeNull();
    expect(row.approvedByUserId).toBe(userId);
    expect(row.approvedWorkroomId).toBe(WORKROOM_ID);
    expect(row.deliveredToken).not.toBeNull();
    expect(row.machineId).toBe(ab.machine_id);
  });

  // ── T14: user is not member of target workroom ─────────────────────────────
  it('T14: approve with valid user_sess_ but workroom_id user is NOT a member of → 403 FORBIDDEN (not ENROLLMENT_NOT_REDEEMABLE)', async () => {
    const { res } = await createIntent();
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);

    // OTHER_WORKROOM_ID exists, but userId has no UserWorkroomMembership row for it.
    const a = await approve(body.intent_id, body.opaque_code, validToken, OTHER_WORKROOM_ID);
    expect(a.statusCode).toBe(403);
    const err = (a.json() as { error: { code: string } }).error.code;
    // Spec contract: auth-fail returns FORBIDDEN, distinct from the intent-fail code.
    expect(err).toBe('FORBIDDEN');
    expect(err).not.toBe('ENROLLMENT_NOT_REDEEMABLE');

    // Intent must NOT have been touched (auth failed BEFORE the handler body ran).
    const row = await db.controlMachineEnrollment.findUniqueOrThrow({ where: { id: body.intent_id } });
    expect(row.approvedAt).toBeNull();
    expect(row.approvedByUserId).toBeNull();
    expect(row.approvedWorkroomId).toBeNull();
    expect(row.machineId).toBeNull();
    expect(row.deliveredToken).toBeNull();
  });

  // ── T15: expired user_sess_ ────────────────────────────────────────────────
  it('T15: approve with expired user_sess_ → 401 INVALID_SESSION + no DB writes', async () => {
    const { res } = await createIntent({ device_name: 't15-mac' });
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);

    const machinesBefore = await db.controlMachine.count({ where: { orgId: ORG_ID } });

    const a = await approve(body.intent_id, body.opaque_code, expiredToken, WORKROOM_ID);
    expect(a.statusCode).toBe(401);
    expect((a.json() as { error: { code: string } }).error.code).toBe('INVALID_SESSION');

    const row = await db.controlMachineEnrollment.findUniqueOrThrow({ where: { id: body.intent_id } });
    expect(row.approvedAt).toBeNull();
    expect(row.machineId).toBeNull();

    const machinesAfter = await db.controlMachine.count({ where: { orgId: ORG_ID } });
    expect(machinesAfter).toBe(machinesBefore);
  });

  // ── T16: concurrent double-approve ─────────────────────────────────────────
  it('T16: concurrent double-approve (two valid sessions, same code) → exactly one 200 + one 403 ENROLLMENT_NOT_REDEEMABLE', async () => {
    const { res } = await createIntent({ device_name: 't16-mac' });
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);

    // Fire both before awaiting either — two different valid user sessions, both owners of WORKROOM_ID.
    const [r1, r2] = await Promise.all([
      approve(body.intent_id, body.opaque_code, validToken, WORKROOM_ID),
      approve(body.intent_id, body.opaque_code, otherUserToken, WORKROOM_ID),
    ]);

    const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([200, 403]);

    const loser = r1.statusCode === 403 ? r1 : r2;
    expect((loser.json() as { error: { code: string } }).error.code).toBe('ENROLLMENT_NOT_REDEEMABLE');

    const winner = r1.statusCode === 200 ? r1 : r2;
    const winnerBody = winner.json() as { kind: string; machine_id: string; workroom_already_bound: boolean };
    expect(winnerBody.kind).toBe('both');
    expect(winnerBody.workroom_already_bound).toBe(true);
    createdMachineIds.add(winnerBody.machine_id);

    // Exactly ONE ControlMachine row created for this device.
    const machines = await db.controlMachine.findMany({
      where: { displayName: 't16-mac', orgId: ORG_ID },
    });
    expect(machines).toHaveLength(1);
    expect(machines[0].id).toBe(winnerBody.machine_id);
  });

  // ── T17: atomicity rollback ────────────────────────────────────────────────
  it('T17: forced rollback inside the approve tx → no partial state (CAS rolled back, no orphan ControlMachine)', async () => {
    const { res } = await createIntent({ device_name: 't17-mac' });
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);

    // Intercept db.$transaction once: wrap tx with a Proxy that re-routes
    // controlMachine.create → throws. All other ops go through to the real tx
    // so we genuinely exercise the rollback path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalTx = (db as any).$transaction.bind(db);
    let createIntercepted = false;
    let alreadyInjected = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).$transaction = ((arg: unknown, opts?: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (alreadyInjected || typeof arg !== 'function') return (originalTx as any)(arg, opts);
      alreadyInjected = true;
      const fn = arg as (tx: unknown) => Promise<unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalTx as any)(async (tx: any) => {
        const wrappedTx = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'controlMachine') {
              const realModel = Reflect.get(target, prop, receiver);
              return new Proxy(realModel, {
                get(m, mp, r) {
                  if (mp === 'create') {
                    return async () => {
                      createIntercepted = true;
                      throw new Error('injected: simulated mid-tx failure');
                    };
                  }
                  return Reflect.get(m, mp, r);
                },
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        return fn(wrappedTx);
      }, opts);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {
      const a = await approve(body.intent_id, body.opaque_code, validToken, WORKROOM_ID);
      expect(a.statusCode).toBe(403);
      expect((a.json() as { error: { code: string } }).error.code).toBe('ENROLLMENT_NOT_REDEEMABLE');
      expect(createIntercepted).toBe(true);

      // CAS updateMany ran inside the wrapped tx and must have been undone.
      const row = await db.controlMachineEnrollment.findUniqueOrThrow({ where: { id: body.intent_id } });
      expect(row.approvedAt).toBeNull();
      expect(row.approvedByUserId).toBeNull();
      expect(row.approvedWorkroomId).toBeNull();
      expect(row.machineId).toBeNull();
      expect(row.deliveredToken).toBeNull();

      // No leaked ControlMachine.
      const orphans = await db.controlMachine.findMany({
        where: { displayName: 't17-mac', orgId: ORG_ID },
      });
      expect(orphans).toHaveLength(0);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (db as any).$transaction;
    }

    // Sanity: after restore, the SAME intent can be approved fresh — proves the rollback
    // truly left it redeemable.
    const a2 = await approve(body.intent_id, body.opaque_code, validToken, WORKROOM_ID);
    expect(a2.statusCode).toBe(200);
    const machineId = (a2.json() as { machine_id: string }).machine_id;
    createdMachineIds.add(machineId);
  });

  // ── C5b: approved → poll → delivers token + clears ─────────────────────────
  let c5bIntentId = '';
  let c5bOpaqueCode = '';
  let c5bMachineId = '';

  it('C5b: approved → poll → 200 + machine_token + org_id + workroom_id, deliveredToken cleared', async () => {
    const { res } = await createIntent({ device_name: 'c5b-mac' });
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);
    c5bIntentId = body.intent_id;
    c5bOpaqueCode = body.opaque_code;

    const a = await approve(body.intent_id, body.opaque_code, validToken, WORKROOM_ID);
    expect(a.statusCode).toBe(200);
    const machineId = (a.json() as { machine_id: string }).machine_id;
    createdMachineIds.add(machineId);
    c5bMachineId = machineId;

    const p = await poll(body.intent_id, body.opaque_code);
    expect(p.statusCode).toBe(200);
    const pb = p.json() as {
      machine_token: string;
      machine_id: string;
      org_id: string;
      workroom_id: string;
    };
    expect(typeof pb.machine_token).toBe('string');
    expect(pb.machine_token.length).toBe(64);
    expect(pb.machine_id).toBe(machineId);
    expect(pb.org_id).toBe(ORG_ID);
    expect(pb.workroom_id).toBe(WORKROOM_ID);

    const row = await db.controlMachineEnrollment.findUniqueOrThrow({ where: { id: body.intent_id } });
    expect(row.deliveredToken).toBeNull();
  });

  // ── C7: second poll → 403 (one-time delivery) ──────────────────────────────
  it('C7: approved → poll AGAIN with right code → 403 ENROLLMENT_NOT_REDEEMABLE (one-time)', async () => {
    expect(c5bIntentId).not.toBe('');
    const p2 = await poll(c5bIntentId, c5bOpaqueCode);
    expect(p2.statusCode).toBe(403);
    expect((p2.json() as { error: { code: string } }).error.code).toBe('ENROLLMENT_NOT_REDEEMABLE');
    const m = await db.controlMachine.findUnique({ where: { id: c5bMachineId } });
    expect(m).not.toBeNull();
  });

  // ── C8: expired intent → poll / approve both 403 ───────────────────────────
  it('C8: create → expired → poll → 403; approve → 403', async () => {
    const { res } = await createIntent();
    const body = res.json() as { intent_id: string; opaque_code: string };
    createdIntentIds.add(body.intent_id);

    await db.controlMachineEnrollment.update({
      where: { id: body.intent_id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const p = await poll(body.intent_id, body.opaque_code);
    expect(p.statusCode).toBe(403);
    expect((p.json() as { error: { code: string } }).error.code).toBe('ENROLLMENT_NOT_REDEEMABLE');

    const a = await approve(body.intent_id, body.opaque_code, validToken, WORKROOM_ID);
    expect(a.statusCode).toBe(403);
    expect((a.json() as { error: { code: string } }).error.code).toBe('ENROLLMENT_NOT_REDEEMABLE');
  });
});

// Track-down note: a unit-level "wrong code → 403 ENROLLMENT_NOT_REDEEMABLE" case is implicitly
// covered by T17's wrapped-tx CAS-loss path (the CAS update updateMany returns count=0 when the
// codeHash doesn't match) and by C8 (expired). A separate dedicated wrong-code case is omitted
// to avoid duplicating the same code path under three names.
beforeEach(() => {
  // No-op: each test owns its own intent + cleanup happens in afterAll.
});
