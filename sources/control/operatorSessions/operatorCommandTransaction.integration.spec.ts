/**
 * #88 operatorCommandTransaction — REAL Postgres integration tests.
 * Run with: npm run test:db:setup && npm run test:integration
 * Excluded from default `npm test` (no DB there).
 *
 * Core invariant under test: mutation + audit row are atomic.
 *
 *   1. acknowledge_needs_human: operatorAcknowledgedAt set + audit row created (single tx)
 *   2. mark_reviewed: operatorReviewedAt set + audit row created (single tx)
 *   3. duplicate clientIdempotencyKey: P2002 on audit insert rolls back mutation — field NOT set
 *   4. command not in session.allowedCommands: guard fires before tx — no DB writes
 *   5. action in wrong status (proposed): guard fires before tx — no audit row
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { executeOperatorCommand, type VerifiedOperatorSession } from './operatorCommandTransaction.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID           = randomUUID();
const WORKROOM_ID      = randomUUID();
const WORKROOM_ID_OTHER = randomUUID();  // different workroom — used to test cross-workroom rejection
const SESSION_ID       = randomUUID();  // ControlSession (for actions)
const AGENT_ID         = randomUUID();
const MACHINE_ID       = randomUUID();
const OP_SESS_ID       = randomUUID();  // operator session id (used in VerifiedOperatorSession)

/** Pre-verified session passed to executeOperatorCommand (auth bypassed — tested in #96). */
const SESSION_V1: VerifiedOperatorSession = {
  sessionId: OP_SESS_ID,
  workroomId: WORKROOM_ID,
  operatorSubjectId: 'operator-subject-test-88',
  allowedCommands: ['acknowledge_needs_human', 'mark_reviewed'],
};

/** Seed a ControlAction with the given status (defaults to session's WORKROOM_ID). */
async function seedAction(status: string, workroomId = WORKROOM_ID): Promise<string> {
  const id = randomUUID();
  await db.controlAction.create({
    data: {
      id,
      sessionId: SESSION_ID,
      workroomId,
      actorAgentId: AGENT_ID,
      kind: 'deploy',
      summary: '#88 integration test action',
      reversibility: 'reversible',
      riskLevel: 'low',
      requiresApproval: false,
      status,
      clientIdempotencyKey: `idem-${randomUUID()}`,
    },
  });
  return id;
}

/** Count audit rows for a given actionId. */
async function auditCount(actionId: string): Promise<number> {
  return db.controlOperatorAuditLog.count({ where: { actionId } });
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'OpCmd Org', slug: `opcmd-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlMachine.create({
    data: {
      id: MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: `hash-${randomUUID()}`,
      tokenExpiresAt: new Date(Date.now() + 24 * 3600_000),
      platform: 'darwin',
      arch: 'arm64',
    },
  });
  await db.controlAgent.create({
    data: { id: AGENT_ID, orgId: ORG_ID, name: 'opcmd-agent', displayName: 'OpCmd Agent', role: 'ops' },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'OpCmd Workroom', createdBy: randomUUID() },
  });
  // WORKROOM_ID_OTHER must also exist to satisfy the FK on control_actions.workroom_id.
  // Used by test 6 (cross-workroom rejection) to seed an action in a different workroom.
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID_OTHER, orgId: ORG_ID, name: 'OpCmd Workroom Other', createdBy: randomUUID() },
  });
  await db.controlSession.create({
    data: {
      id: SESSION_ID,
      orgId: ORG_ID,
      workroomId: WORKROOM_ID,
      machineId: MACHINE_ID,
      mode: 'daemon',
      runtime: 'claude',
      displayName: 'opcmd-session',
    },
  });
  // Create a stub ControlOperatorSession row (audit log references sessionId by UUID; FK not enforced)
  await db.controlOperatorSession.create({
    data: {
      id: OP_SESS_ID,
      tokenHash: `op-sess-hash-${randomUUID()}`,
      orgId: ORG_ID,
      workroomId: WORKROOM_ID,
      allowedCommands: ['acknowledge_needs_human', 'mark_reviewed'],
      operatorSubjectId: 'operator-subject-test-88',
      issuedBy: 'test-runner',
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    },
  });
});

afterAll(async () => {
  // Delete in dependency order (audit logs reference actions)
  await db.controlOperatorAuditLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  // Actions seeded in WORKROOM_ID_OTHER also need cleanup
  await db.controlAction.deleteMany({ where: { workroomId: { in: [WORKROOM_ID, WORKROOM_ID_OTHER] } } });
  await db.controlSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlOperatorSession.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: { in: [WORKROOM_ID, WORKROOM_ID_OTHER] } } });
  await db.controlAgent.deleteMany({ where: { id: AGENT_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#88 executeOperatorCommand — real DB atomicity', () => {
  it('acknowledge_needs_human: sets operatorAcknowledgedAt + creates audit row in same tx', async () => {
    const actionId = await seedAction('needs_human');
    const idempotencyKey = randomUUID();

    const result = await executeOperatorCommand({
      session: SESSION_V1,
      actionId,
      commandKey: 'acknowledge_needs_human',
      clientIdempotencyKey: idempotencyKey,
    });

    expect(result.ok).toBe(true);

    // Mutation: operatorAcknowledgedAt set
    const action = await db.controlAction.findUnique({ where: { id: actionId } });
    expect(action!.operatorAcknowledgedAt).not.toBeNull();
    expect(action!.operatorReviewedAt).toBeNull();  // should not be touched

    // Audit row created
    expect(await auditCount(actionId)).toBe(1);
    const auditRow = await db.controlOperatorAuditLog.findFirst({ where: { actionId } });
    expect(auditRow!.commandKey).toBe('acknowledge_needs_human');
    expect(auditRow!.outcome).toBe('succeeded');
    expect(auditRow!.sessionId).toBe(OP_SESS_ID);
    expect(auditRow!.operatorSubjectId).toBe('operator-subject-test-88');
    expect(auditRow!.clientIdempotencyKey).toBe(idempotencyKey);
    // SECURITY: audit row must not contain raw token, secret, path
    expect(JSON.stringify(auditRow)).not.toMatch(/op_sess_|secret|storage_ref/);
  });

  it('mark_reviewed: sets operatorReviewedAt + creates audit row in same tx', async () => {
    const actionId = await seedAction('needs_human');

    const result = await executeOperatorCommand({
      session: SESSION_V1,
      actionId,
      commandKey: 'mark_reviewed',
      clientIdempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(true);

    const action = await db.controlAction.findUnique({ where: { id: actionId } });
    expect(action!.operatorReviewedAt).not.toBeNull();
    expect(action!.operatorAcknowledgedAt).toBeNull();  // should not be touched

    expect(await auditCount(actionId)).toBe(1);
    const auditRow = await db.controlOperatorAuditLog.findFirst({ where: { actionId } });
    expect(auditRow!.commandKey).toBe('mark_reviewed');
    expect(auditRow!.outcome).toBe('succeeded');
  });

  it('duplicate clientIdempotencyKey rolls back mutation — operatorAcknowledgedAt NOT set twice', async () => {
    const actionId = await seedAction('needs_human');
    const idempotencyKey = randomUUID();

    // First call succeeds
    const first = await executeOperatorCommand({
      session: SESSION_V1,
      actionId,
      commandKey: 'acknowledge_needs_human',
      clientIdempotencyKey: idempotencyKey,
    });
    expect(first.ok).toBe(true);
    const firstTimestamp = (await db.controlAction.findUnique({ where: { id: actionId } }))!.operatorAcknowledgedAt;
    expect(firstTimestamp).not.toBeNull();

    // Second call with same idempotency key must fail
    const second = await executeOperatorCommand({
      session: SESSION_V1,
      actionId,
      commandKey: 'acknowledge_needs_human',
      clientIdempotencyKey: idempotencyKey,  // same key → P2002 on audit insert
    });
    expect(second.ok).toBe(false);
    expect((second as { code: string }).code).toBe('DUPLICATE_IDEMPOTENCY_KEY');

    // Mutation was rolled back: operatorAcknowledgedAt unchanged (still the first timestamp)
    const action = await db.controlAction.findUnique({ where: { id: actionId } });
    expect(action!.operatorAcknowledgedAt!.toISOString()).toBe(firstTimestamp!.toISOString());

    // Exactly one audit row (the second attempt was rolled back)
    expect(await auditCount(actionId)).toBe(1);
  });

  it('command not in session.allowedCommands is rejected — no DB writes', async () => {
    const actionId = await seedAction('needs_human');
    const restrictedSession: VerifiedOperatorSession = {
      ...SESSION_V1,
      allowedCommands: ['acknowledge_needs_human'],  // mark_reviewed deliberately excluded
    };

    const result = await executeOperatorCommand({
      session: restrictedSession,
      actionId,
      commandKey: 'mark_reviewed',  // not in allowedCommands
      clientIdempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('COMMAND_NOT_ALLOWED');

    // No mutation, no audit row
    const action = await db.controlAction.findUnique({ where: { id: actionId } });
    expect(action!.operatorReviewedAt).toBeNull();
    expect(await auditCount(actionId)).toBe(0);
  });

  it('action in wrong status (proposed) is rejected — no audit row', async () => {
    const actionId = await seedAction('proposed');  // acknowledge requires needs_human

    const result = await executeOperatorCommand({
      session: SESSION_V1,
      actionId,
      commandKey: 'acknowledge_needs_human',
      clientIdempotencyKey: randomUUID(),
    });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('ACTION_WRONG_STATUS');

    // No mutation, no audit row
    const action = await db.controlAction.findUnique({ where: { id: actionId } });
    expect(action!.operatorAcknowledgedAt).toBeNull();
    expect(await auditCount(actionId)).toBe(0);
  });

  it('CAS count=0: no mutation and no audit row when concurrent status change races the write', async () => {
    // Simulate a concurrent status change that lands between our Step 3 read and Step 4 write:
    // spy on db.$transaction and wrap the tx proxy so controlAction.updateMany returns { count: 0 }.
    // All other tx operations (findUnique, controlOperatorAuditLog.create) are real DB calls,
    // so if the audit INSERT somehow ran despite count=0 it would be persisted and caught below.
    //
    // ISOLATION NOTE: In Vitest 3.2, a vi.spyOn-based mockImplementationOnce on db.$transaction
    // does NOT fall through to the original after the one-time mock is consumed — subsequent calls
    // silently skip the callback (returns resolved promise without calling fn). We capture the real
    // $transaction BEFORE installing the spy and restore it manually in a finally block so no spy
    // state leaks into subsequent tests. Do NOT use vi.restoreAllMocks() — it sets db.$transaction
    // to undefined on Prisma's own-property client instance.
    const originalTransaction = (db as any).$transaction.bind(db);
    const actionId = await seedAction('needs_human');

    try {
      vi.spyOn(db as any, '$transaction').mockImplementationOnce((...args: any[]) => {
        const [fn] = args;
        return originalTransaction((tx: any) =>
          fn(
            new Proxy(tx, {
              get(target: any, prop: string | symbol) {
                if (prop !== 'controlAction') return Reflect.get(target, prop);
                return new Proxy(Reflect.get(target, prop), {
                  get(delegate: any, method: string | symbol) {
                    // Intercept updateMany only — simulate CAS returning 0 matched rows
                    if (method === 'updateMany') return async () => ({ count: 0 });
                    return Reflect.get(delegate, method);
                  },
                });
              },
            }),
          ),
        );
      });

      const result = await executeOperatorCommand({
        session: SESSION_V1,
        actionId,
        commandKey: 'acknowledge_needs_human',
        clientIdempotencyKey: randomUUID(),
      });

      // CAS failure → ACTION_WRONG_STATUS (re-query sees needs_human → non-terminal)
      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe('ACTION_WRONG_STATUS');

      // No mutation written (transaction rolled back by the OperatorCmdError throw)
      const action = await db.controlAction.findUnique({ where: { id: actionId } });
      expect(action!.operatorAcknowledgedAt).toBeNull();

      // No audit row — CAS fail throws before the audit INSERT, so audit was never committed
      expect(await auditCount(actionId)).toBe(0);
    } finally {
      // Always restore db.$transaction after this test — vi.spyOn's exhausted mock silently
      // swallows subsequent calls, causing false-positive results in test 7 (cross-workroom guard).
      (db as any).$transaction = originalTransaction;
    }
  });

  it('action belonging to a different workroom is rejected as NOT_FOUND — no-leak, no DB writes', async () => {
    // Seed action in a different workroom (WORKROOM_ID_OTHER ≠ session.workroomId)
    const actionId = await seedAction('needs_human', WORKROOM_ID_OTHER);

    // Verify the seed is correct — action must be in the other workroom for this test to be meaningful.
    const seeded = await db.controlAction.findUnique({ where: { id: actionId }, select: { workroomId: true } });
    expect(seeded!.workroomId).toBe(WORKROOM_ID_OTHER);

    const result = await executeOperatorCommand({
      session: SESSION_V1,           // session.workroomId = WORKROOM_ID
      actionId,
      commandKey: 'acknowledge_needs_human',
      clientIdempotencyKey: randomUUID(),
    });

    // Fail-closed no-leak: returns 404 not 403 (no workroom membership disclosure)
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('ACTION_NOT_FOUND');

    // No mutation, no audit row
    const action = await db.controlAction.findUnique({ where: { id: actionId } });
    expect(action!.operatorAcknowledgedAt).toBeNull();
    expect(await auditCount(actionId)).toBe(0);
  });
});
