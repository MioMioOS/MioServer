/**
 * Action fire transaction — unit tests.
 *
 * Verifies (v2 — after PM/운위 review):
 * 1. Only 'approved' AND non-expired approval can be consumed
 * 2. `decidedAt` is NOT overwritten during consumption (only status → 'consumed')
 *    `consumedAt` lives on control_action_approval_consumptions
 * 3. Double-fire is rejected for reversible actions via status CAS
 * 4. Double-fire is rejected for irreversible_no_abort via UNIQUE backstop
 * 5. `approved_at_snapshot` = approval.decidedAt (human approval time), not fire time
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

const TERMINAL_STATUSES: ActionStatus[] = [
  'fired', 'canceled', 'failed', 'succeeded', 'transmission_complete',
];

interface SimApproval {
  id: string;
  actionId: string;
  status: ApprovalStatus;
  decidedAt: Date | null;
  expiresAt: Date | null;
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

type ConsumptionTable = Map<string, { approvalId: string; actionId: string; consumedAt: Date }>;

type FireResult =
  | { ok: true; firedAt: Date; approvedAtSnapshot: Date | null }
  | { ok: false; code: string; message: string };

/**
 * Simulates the three-step fire transaction.
 *
 * Changes from v1 (per PM/운위 review):
 * - Step 1 CAS: also checks expiresAt (null OR > now)
 * - Step 1 CAS: does NOT overwrite approval.decidedAt (only status → consumed)
 * - Reversible path: uses status CAS (notIn terminal) → 0 count = 409
 * - consumedAt stored on consumption table, not on approval row
 */
function simulateFireTransaction(
  action: SimAction,
  approval: SimApproval | null,
  consumptionTable: ConsumptionTable,
  now: Date = new Date(),
): FireResult {
  // ── Reversible / irreversible_abortable: status CAS, no approval ──
  if (action.reversibility !== 'irreversible_no_abort') {
    if (TERMINAL_STATUSES.includes(action.status)) {
      return { ok: false, code: 'ACTION_ALREADY_TERMINAL', message: `Action is ${action.status}` };
    }
    // Atomic status CAS: only update if not terminal
    action.status = 'fired';
    action.firedAt = now;
    return { ok: true, firedAt: now, approvedAtSnapshot: null };
  }

  // ── irreversible_no_abort: must have approved, non-expired approval ──
  if (!approval) {
    return { ok: false, code: 'APPROVAL_REQUIRED', message: 'approval_id required' };
  }

  // Step 1: CAS approval — status='approved' AND (expiresAt IS NULL OR expiresAt > now)
  const isExpired = approval.expiresAt !== null && approval.expiresAt <= now;
  if (approval.status !== 'approved' || isExpired) {
    return {
      ok: false,
      code: 'APPROVAL_NOT_APPROVED',
      message: isExpired
        ? `Approval has expired at ${approval.expiresAt?.toISOString()}`
        : `Approval is in state '${approval.status}', expected 'approved'`,
    };
  }

  // Mutate status to 'consumed'. decidedAt is NOT touched — it records human approval time.
  const originalDecidedAt = approval.decidedAt;
  approval.status = 'consumed';
  // approval.decidedAt stays unchanged ← the key correctness invariant

  // Step 2: INSERT into consumption table — UNIQUE backstop
  const approvalKey = `approval:${approval.id}`;
  const actionKey = `action:${action.id}`;
  if (consumptionTable.has(approvalKey) || consumptionTable.has(actionKey)) {
    return { ok: false, code: 'FIRE_RACE_CONFLICT', message: 'Already consumed (UNIQUE violation)' };
  }
  consumptionTable.set(approvalKey, { approvalId: approval.id, actionId: action.id, consumedAt: now });
  consumptionTable.set(actionKey, { approvalId: approval.id, actionId: action.id, consumedAt: now });

  // Step 3: UPDATE action to fired; snapshot = original decidedAt (human approval time)
  action.status = 'fired';
  action.firedAt = now;
  action.approvalId = approval.id;
  action.approvedAtSnapshot = originalDecidedAt;  // NOT now — this is the human's approval time

  return { ok: true, firedAt: now, approvedAtSnapshot: originalDecidedAt };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Action fire — reversible/abortable status CAS (double-fire protection)', () => {
  it('fires a reversible action in proposed state', () => {
    const action: SimAction = {
      id: 'a1', reversibility: 'reversible', requiresApproval: false,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const result = simulateFireTransaction(action, null, new Map());
    expect(result.ok).toBe(true);
    expect(action.status).toBe('fired');
  });

  it('rejects double-fire via status CAS — second fire sees terminal status', () => {
    const action: SimAction = {
      id: 'a2', reversibility: 'reversible', requiresApproval: false,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const table = new Map();
    // First fire succeeds
    const r1 = simulateFireTransaction(action, null, table);
    expect(r1.ok).toBe(true);
    expect(action.status).toBe('fired');
    // Second fire: action is now terminal → CAS returns 0 → 409
    const r2 = simulateFireTransaction(action, null, table);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('ACTION_ALREADY_TERMINAL');
  });

  it('rejects irreversible_abortable double-fire the same way', () => {
    const action: SimAction = {
      id: 'a3', reversibility: 'irreversible_abortable', requiresApproval: false,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const table = new Map();
    simulateFireTransaction(action, null, table);
    const r2 = simulateFireTransaction(action, null, table);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('ACTION_ALREADY_TERMINAL');
  });
});

describe('Action fire — expiry check in approval CAS', () => {
  const futureDate = new Date(Date.now() + 86400_000); // +1 day
  const pastDate = new Date(Date.now() - 1000);        // 1 second ago

  const makeAction = (): SimAction => ({
    id: 'action-exp', reversibility: 'irreversible_no_abort', requiresApproval: true,
    status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
  });

  it('fires when approval has no expiresAt', () => {
    const approval: SimApproval = {
      id: 'appr-1', actionId: 'action-exp', status: 'approved',
      decidedAt: new Date('2026-05-21T09:00:00Z'), expiresAt: null,
    };
    const result = simulateFireTransaction(makeAction(), approval, new Map());
    expect(result.ok).toBe(true);
  });

  it('fires when approval expiresAt is in the future', () => {
    const approval: SimApproval = {
      id: 'appr-2', actionId: 'action-exp', status: 'approved',
      decidedAt: new Date('2026-05-21T09:00:00Z'), expiresAt: futureDate,
    };
    const result = simulateFireTransaction(makeAction(), approval, new Map());
    expect(result.ok).toBe(true);
  });

  it('rejects when approval expiresAt is in the past (even if status still approved)', () => {
    const approval: SimApproval = {
      id: 'appr-3', actionId: 'action-exp', status: 'approved',
      decidedAt: new Date('2026-05-21T09:00:00Z'), expiresAt: pastDate,
    };
    const result = simulateFireTransaction(makeAction(), approval, new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('rejects when approval status is approved but expired exactly at now', () => {
    const exactlyNow = new Date();
    const approval: SimApproval = {
      id: 'appr-4', actionId: 'action-exp', status: 'approved',
      decidedAt: new Date('2026-05-21T09:00:00Z'), expiresAt: exactlyNow,
    };
    // expiresAt <= now → expired
    const result = simulateFireTransaction(makeAction(), approval, new Map(), exactlyNow);
    expect(result.ok).toBe(false);
  });
});

describe('Timestamp semantics — decidedAt vs consumedAt vs approvedAtSnapshot', () => {
  const humanApprovedAt = new Date('2026-05-21T08:30:00Z');
  const fireAt = new Date('2026-05-21T10:00:00Z');  // fire happens 90 minutes later

  const makeApproval = (): SimApproval => ({
    id: 'appr-ts', actionId: 'action-ts', status: 'approved',
    decidedAt: humanApprovedAt,  // when the human approved
    expiresAt: null,
  });

  const makeAction = (): SimAction => ({
    id: 'action-ts', reversibility: 'irreversible_no_abort', requiresApproval: true,
    status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
  });

  it('approval.decidedAt is NOT overwritten during consumption', () => {
    const approval = makeApproval();
    simulateFireTransaction(makeAction(), approval, new Map(), fireAt);
    // decidedAt must remain the human's approval time, not the fire time
    expect(approval.decidedAt?.toISOString()).toBe(humanApprovedAt.toISOString());
    expect(approval.decidedAt?.toISOString()).not.toBe(fireAt.toISOString());
  });

  it('action.approvedAtSnapshot = human approval time (decidedAt), not fire time', () => {
    const action = makeAction();
    const approval = makeApproval();
    simulateFireTransaction(action, approval, new Map(), fireAt);
    // Audit query: "who approved and when?" → approvedAtSnapshot points to human decision time
    expect(action.approvedAtSnapshot?.toISOString()).toBe(humanApprovedAt.toISOString());
  });

  it('action.firedAt = actual fire time, separate from approval time', () => {
    const action = makeAction();
    simulateFireTransaction(action, makeApproval(), new Map(), fireAt);
    expect(action.firedAt?.toISOString()).toBe(fireAt.toISOString());
    // The 90-minute gap between approval and fire is preserved and auditable
    expect(action.approvedAtSnapshot?.toISOString()).not.toBe(action.firedAt?.toISOString());
  });

  it('consumptionTable records consumedAt = fire time (not approval time)', () => {
    const action = makeAction();
    const table = new Map();
    simulateFireTransaction(action, makeApproval(), table, fireAt);
    const record = table.get('approval:appr-ts');
    expect(record?.consumedAt.toISOString()).toBe(fireAt.toISOString());
  });
});

describe('Action fire — irreversible_no_abort approval gate', () => {
  const makeApproval = (status: ApprovalStatus, expiresAt: Date | null = null): SimApproval => ({
    id: 'appr-1', actionId: 'action-1', status,
    decidedAt: status === 'approved' ? new Date('2026-05-21T10:00:00Z') : null,
    expiresAt,
  });

  const makeAction = (): SimAction => ({
    id: 'action-1', reversibility: 'irreversible_no_abort', requiresApproval: true,
    status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
  });

  it('requires approval_id for irreversible_no_abort', () => {
    const result = simulateFireTransaction(makeAction(), null, new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_REQUIRED');
  });

  it('fires when approval is approved and not expired', () => {
    const result = simulateFireTransaction(makeAction(), makeApproval('approved'), new Map());
    expect(result.ok).toBe(true);
  });

  it('rejects when approval is pending', () => {
    const result = simulateFireTransaction(makeAction(), makeApproval('pending'), new Map());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('rejects when approval is already consumed', () => {
    const result = simulateFireTransaction(makeAction(), makeApproval('consumed'), new Map());
    expect(result.ok).toBe(false);
  });

  it('rejects when approval is rejected', () => {
    const result = simulateFireTransaction(makeAction(), makeApproval('rejected'), new Map());
    expect(result.ok).toBe(false);
  });
});

describe('Action fire — double-fire prevention (UNIQUE backstop)', () => {
  it('second fire of same action is rejected', () => {
    const action: SimAction = {
      id: 'action-dup', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const approval: SimApproval = {
      id: 'appr-dup', actionId: action.id, status: 'approved',
      decidedAt: new Date(), expiresAt: null,
    };
    const table: ConsumptionTable = new Map();
    const r1 = simulateFireTransaction(action, { ...approval }, table);
    expect(r1.ok).toBe(true);
    // Second attempt: approval now 'consumed', will fail at CAS step
    const r2 = simulateFireTransaction({ ...action, status: 'fired' }, { ...approval, status: 'consumed' }, table);
    expect(r2.ok).toBe(false);
  });

  it('same approval cannot fire two different actions — UNIQUE(approval_id) backstop', () => {
    const sharedApproval: SimApproval = {
      id: 'shared-appr', actionId: 'action-x',
      status: 'approved', decidedAt: new Date(), expiresAt: null,
    };
    const action1: SimAction = {
      id: 'action-x', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const table: ConsumptionTable = new Map();
    const r1 = simulateFireTransaction(action1, { ...sharedApproval }, table);
    expect(r1.ok).toBe(true);
    // Second action tries to use same approval — it's now consumed
    const action2: SimAction = { ...action1, id: 'action-y', status: 'proposed' };
    const r2 = simulateFireTransaction(action2, { ...sharedApproval, status: 'consumed' }, table);
    expect(r2.ok).toBe(false);
  });

  it('FIRE_RACE_CONFLICT backstop when CAS somehow passes but UNIQUE INSERT fails', () => {
    // Pre-populate consumption table as if first transaction won
    const action: SimAction = {
      id: 'race-action', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const approval: SimApproval = {
      id: 'race-appr', actionId: 'race-action', status: 'approved',
      decidedAt: new Date(), expiresAt: null,
    };
    const table: ConsumptionTable = new Map();
    simulateFireTransaction(action, { ...approval }, table);
    // Second concurrent transaction: both CAS passed (extreme race), UNIQUE fires
    const action2: SimAction = { ...action, status: 'proposed' };
    const r2 = simulateFireTransaction(action2, { ...approval }, table);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('FIRE_RACE_CONFLICT');
  });
});

describe('Approval consumption table invariants', () => {
  it('each successful fire creates exactly one consumption record with correct consumedAt', () => {
    const now = new Date('2026-05-21T11:00:00Z');
    const table: ConsumptionTable = new Map();
    const action: SimAction = {
      id: 'inv-action', reversibility: 'irreversible_no_abort', requiresApproval: true,
      status: 'proposed', firedAt: null, approvalId: null, approvedAtSnapshot: null,
    };
    const approval: SimApproval = {
      id: 'inv-appr', actionId: action.id, status: 'approved',
      decidedAt: new Date('2026-05-21T09:00:00Z'), expiresAt: null,
    };
    simulateFireTransaction(action, approval, table, now);
    const record = table.get(`approval:${approval.id}`);
    expect(record).toBeDefined();
    expect(record?.consumedAt.toISOString()).toBe(now.toISOString());
    // consumedAt should differ from decidedAt (fire happened 2h after approval)
    expect(record?.consumedAt.toISOString()).not.toBe(approval.decidedAt?.toISOString());
  });
});

describe('Task CAS claim — WHERE predicate logic', () => {
  type TaskStatus = 'todo' | 'in_progress' | 'waiting_approval' | 'in_review' | 'done' | 'canceled';
  interface Task { id: string; ownerInstanceId: string | null; status: TaskStatus; }
  const NON_CLAIMABLE: TaskStatus[] = ['done', 'canceled'];

  function simulateCASClaim(task: Task, agent: string) {
    if (task.ownerInstanceId === null && !NON_CLAIMABLE.includes(task.status)) return { count: 1 };
    return { count: 0 };
  }
  function simulateCASUnclaim(task: Task, agent: string) {
    if (task.ownerInstanceId === agent && !NON_CLAIMABLE.includes(task.status)) return { count: 1 };
    return { count: 0 };
  }

  it('claims unclaimed todo', () => expect(simulateCASClaim({ id: 't1', ownerInstanceId: null, status: 'todo' }, 'a').count).toBe(1));
  it('rejects when already owned', () => expect(simulateCASClaim({ id: 't2', ownerInstanceId: 'a', status: 'in_progress' }, 'b').count).toBe(0));
  it('rejects when done', () => expect(simulateCASClaim({ id: 't3', ownerInstanceId: null, status: 'done' }, 'a').count).toBe(0));
  it('rejects when canceled', () => expect(simulateCASClaim({ id: 't4', ownerInstanceId: null, status: 'canceled' }, 'a').count).toBe(0));
  it('unclaims when caller is owner', () => expect(simulateCASUnclaim({ id: 'u1', ownerInstanceId: 'a', status: 'in_progress' }, 'a').count).toBe(1));
  it('blocks unclaim when caller is not owner', () => expect(simulateCASUnclaim({ id: 'u2', ownerInstanceId: 'a', status: 'in_progress' }, 'b').count).toBe(0));

  it('exactly one of N concurrent agents wins the claim', () => {
    let task = { id: 'c1', ownerInstanceId: null as string | null, status: 'todo' as TaskStatus };
    let winners = 0;
    for (const agent of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      if (simulateCASClaim(task, agent).count === 1) {
        winners++;
        task = { ...task, ownerInstanceId: agent, status: 'in_progress' };
      }
    }
    expect(winners).toBe(1);
  });
});
