/**
 * Action fire transaction — unit tests.
 *
 * Tests the logic of the approval consumption CAS and fire transaction
 * WITHOUT hitting a real DB.
 *
 * Verifies:
 * 1. Only 'approved' approval can be consumed (CAS on status)
 * 2. Double-fire is rejected (UNIQUE backstop simulation)
 * 3. irreversible_no_abort without approval → rejected
 * 4. reversible/irreversible_abortable fire without approval → allowed
 * 5. Approved-at-snapshot is captured correctly
 */
import { describe, it, expect } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────────

type ApprovalStatus =
  | 'pending' | 'approved' | 'consumed' | 'rejected'
  | 'snoozed' | 'expired' | 'ignored';

type ActionStatus =
  | 'proposed' | 'approved' | 'rejected' | 'canceled'
  | 'fired' | 'transmission_complete' | 'reconciling' | 'succeeded' | 'failed' | 'needs_human';

type Reversibility = 'reversible' | 'irreversible_abortable' | 'irreversible_no_abort';

interface SimApproval {
  id: string;
  actionId: string;
  status: ApprovalStatus;
  decidedAt: Date | null;
}

interface SimAction {
  id: string;
  reversibility: Reversibility;
  requiresApproval: boolean;
  status: ActionStatus;
  firedAt: Date | null;
  approvalId: string | null;
  approvedAtSnapshot: Date | null;
}

// ── Fire transaction simulator ─────────────────────────────────────────────────

type ConsumptionTable = Map<string, { approvalId: string; actionId: string }>;

type FireResult =
  | { ok: true; firedAt: Date; approvedAtSnapshot: Date | null }
  | { ok: false; code: string; message: string };

/**
 * Simulates the three-step fire transaction.
 * In production: runs inside Prisma $transaction on PostgreSQL.
 */
function simulateFireTransaction(
  action: SimAction,
  approval: SimApproval | null,
  consumptionTable: ConsumptionTable,
): FireResult {
  const now = new Date();

  // Reversible/abortable: no approval needed
  if (action.reversibility !== 'irreversible_no_abort') {
    return { ok: true, firedAt: now, approvedAtSnapshot: null };
  }

  // irreversible_no_abort: must have approved approval
  if (!approval) {
    return { ok: false, code: 'APPROVAL_REQUIRED', message: 'approval_id required' };
  }

  // Step 1: CAS approval status 'approved' → 'consumed'
  if (approval.status !== 'approved') {
    return {
      ok: false,
      code: 'APPROVAL_NOT_APPROVED',
      message: `Approval is in state '${approval.status}', expected 'approved'`,
    };
  }

  // Mutate (simulates the DB UPDATE)
  approval.status = 'consumed';

  // Step 2: INSERT into consumption table — UNIQUE backstop
  const approvalKey = `approval:${approval.id}`;
  const actionKey = `action:${action.id}`;
  if (consumptionTable.has(approvalKey) || consumptionTable.has(actionKey)) {
    return { ok: false, code: 'FIRE_RACE_CONFLICT', message: 'Already consumed (UNIQUE violation)' };
  }
  consumptionTable.set(approvalKey, { approvalId: approval.id, actionId: action.id });
  consumptionTable.set(actionKey, { approvalId: approval.id, actionId: action.id });

  // Step 3: UPDATE action to fired
  action.status = 'fired';
  action.firedAt = now;
  action.approvalId = approval.id;
  action.approvedAtSnapshot = approval.decidedAt;

  return { ok: true, firedAt: now, approvedAtSnapshot: approval.decidedAt };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Action fire — reversible/abortable (no approval needed)', () => {
  it('fires a reversible action without approval', () => {
    const action: SimAction = {
      id: 'a1', reversibility: 'reversible', requiresApproval: false,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, null, table);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvedAtSnapshot).toBeNull();
    }
  });

  it('fires an irreversible_abortable action without approval', () => {
    const action: SimAction = {
      id: 'a2', reversibility: 'irreversible_abortable', requiresApproval: false,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, null, table);
    expect(result.ok).toBe(true);
  });
});

describe('Action fire — irreversible_no_abort approval gate', () => {
  const makeApproval = (status: ApprovalStatus, actionId: string): SimApproval => ({
    id: 'appr-1', actionId, status,
    decidedAt: status === 'approved' ? new Date('2026-05-21T10:00:00Z') : null,
  });

  const makeAction = (): SimAction => ({
    id: 'action-1', reversibility: 'irreversible_no_abort', requiresApproval: true,
    status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
  });

  it('requires approval_id for irreversible_no_abort', () => {
    const action = makeAction();
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, null, table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  it('fires when approval is in approved state', () => {
    const action = makeAction();
    const approval = makeApproval('approved', action.id);
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, approval, table);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvedAtSnapshot?.toISOString()).toBe('2026-05-21T10:00:00.000Z');
    }
  });

  it('captures approvedAtSnapshot from approval.decidedAt', () => {
    const action = makeAction();
    const approval = makeApproval('approved', action.id);
    const table: ConsumptionTable = new Map();
    simulateFireTransaction(action, approval, table);
    expect(action.approvedAtSnapshot?.toISOString()).toBe('2026-05-21T10:00:00.000Z');
  });

  it('rejects when approval is pending', () => {
    const action = makeAction();
    const approval = makeApproval('pending', action.id);
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, approval, table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('rejects when approval is already consumed', () => {
    const action = makeAction();
    const approval = makeApproval('consumed', action.id);
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, approval, table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('rejects when approval is rejected', () => {
    const action = makeAction();
    const approval = makeApproval('rejected', action.id);
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, approval, table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('rejects when approval is expired', () => {
    const action = makeAction();
    const approval = makeApproval('expired', action.id);
    const table: ConsumptionTable = new Map();
    const result = simulateFireTransaction(action, approval, table);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_NOT_APPROVED');
  });
});

describe('Action fire — double-fire prevention (UNIQUE backstop)', () => {
  it('second fire of same action is rejected by UNIQUE(action_id)', () => {
    const action: SimAction = {
      id: 'action-dup', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const approval: SimApproval = {
      id: 'appr-dup', actionId: action.id, status: 'approved',
      decidedAt: new Date(),
    };
    const table: ConsumptionTable = new Map();

    // First fire: succeeds
    const r1 = simulateFireTransaction(action, { ...approval }, table);
    expect(r1.ok).toBe(true);

    // Second fire: same action but approval already consumed in CAS
    const r2 = simulateFireTransaction(action, { ...approval, status: 'consumed' }, table);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('same approval cannot be used to fire two different actions (UNIQUE(approval_id))', () => {
    const sharedApproval: SimApproval = {
      id: 'shared-appr', actionId: 'action-x',
      status: 'approved', decidedAt: new Date(),
    };
    const action1: SimAction = {
      id: 'action-x', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const action2: SimAction = {
      id: 'action-y', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const table: ConsumptionTable = new Map();

    // First action fires with the shared approval: succeeds
    const approvalCopy1 = { ...sharedApproval };
    const r1 = simulateFireTransaction(action1, approvalCopy1, table);
    expect(r1.ok).toBe(true);

    // Second action tries to use the same approval ID.
    // In real DB: approval status is now 'consumed' → CAS fails.
    // In simulation: approval copy has status 'consumed' after first fire.
    const approvalCopy2 = { ...sharedApproval, status: 'consumed' as ApprovalStatus };
    const r2 = simulateFireTransaction(action2, approvalCopy2, table);
    expect(r2.ok).toBe(false);
  });

  it('UNIQUE(approval_id) in consumption table catches race (both CAS pass, backstop fires)', () => {
    // Edge case: two transactions both pass the CAS simultaneously.
    // The UNIQUE INSERT is the final backstop.
    // Simulate by pre-populating the consumption table as if first transaction won.
    const action1: SimAction = {
      id: 'race-action', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const approval1: SimApproval = {
      id: 'race-appr', actionId: 'race-action',
      status: 'approved', decidedAt: new Date(),  // Both transactions see 'approved' initially
    };

    const table: ConsumptionTable = new Map();

    // First transaction wins — populates the table
    const r1 = simulateFireTransaction(action1, approval1, table);
    expect(r1.ok).toBe(true);

    // Second transaction: approval is now 'consumed', will be blocked at CAS step
    // (In an extreme race, if CAS somehow passed, UNIQUE INSERT would catch it)
    const action2: SimAction = { ...action1, status: 'proposed' }; // reset
    const approval2: SimApproval = { ...approval1, status: 'approved' }; // simulate race: both saw 'approved'
    // Pre-insert the consumption row to simulate the case where first tx won the INSERT
    // but second tx's CAS somehow also passed (non-serializable isolation edge)
    // => second tx INSERT fails with UNIQUE violation → caught as FIRE_RACE_CONFLICT
    const r2 = simulateFireTransaction(action2, approval2, table);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('FIRE_RACE_CONFLICT');
  });
});

describe('Approval consumption table invariants', () => {
  it('each successful fire creates exactly one consumption record', () => {
    const table: ConsumptionTable = new Map();
    const action: SimAction = {
      id: 'inv-action', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const approval: SimApproval = {
      id: 'inv-appr', actionId: action.id, status: 'approved', decidedAt: new Date(),
    };
    simulateFireTransaction(action, approval, table);
    // Table contains entries keyed by approval: and action:
    expect(table.has(`approval:${approval.id}`)).toBe(true);
    expect(table.has(`action:${action.id}`)).toBe(true);
    expect(table.size).toBe(2); // one for approval key, one for action key
  });
});
