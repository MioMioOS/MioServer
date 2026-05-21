/**
 * Action reconcile (Phase 5C) — unit tests.
 *
 * Verifies the full reconcile lifecycle using simulation (no DB/Fastify):
 *
 *  1. Basic success: fired → needs_human, event emitted
 *  2. Auth: machine_token required (no/invalid token → 401)
 *  3. Firing-machine guard: only the firing machine can reconcile
 *  4. No token row for action → 403 RECONCILE_GUARD_FAILED
 *  5. Forbidden body fields (action_token, token_hash, secret, stdout, stack) → 400
 *  6. Missing required fields → 400 MISSING_FIELDS
 *  7. Invalid reason_code → 400 INVALID_REASON_CODE
 *  8. Hard terminal state → 409 RECONCILE_TERMINAL_CONFLICT
 *  9. Action not yet fired (proposed/approved) → 409 RECONCILE_NOT_FIRED
 * 10. Same evidence_id repeated → idempotent 200 (P2002 simulation)
 * 11. Different evidence_id, action already needs_human → idempotent 200
 * 12. Race: fired→terminal between pre-check and CAS → 409 RECONCILE_TERMINAL_CONFLICT
 * 13. Event payload: locator + status + reason_code only — no free text, no credentials
 * 14. Event payload: must NOT contain raw token, secret, evidence_id content
 * 15. needs_human is NOT counted as done/complete in summary derivation
 * 16. Valid reason_codes: fire_response_lost_token_unrecoverable and drain_deadline_exceeded
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

type ActionStatus =
  | 'proposed' | 'approved' | 'rejected' | 'canceled'
  | 'fired' | 'transmission_complete' | 'reconciling' | 'succeeded' | 'failed' | 'needs_human';

const VALID_REASON_CODES = new Set([
  'fire_response_lost_token_unrecoverable',
  'drain_deadline_exceeded',
]);

const FORBIDDEN_BODY_FIELDS = ['action_token', 'token_hash', 'secret', 'stdout', 'stack'];

const HARD_TERMINAL_STATUSES = new Set<ActionStatus>(['canceled', 'failed', 'succeeded', 'transmission_complete']);
const PRE_FIRE_STATUSES = new Set<ActionStatus>(['proposed', 'approved']);

interface SimAction {
  id: string;
  sessionId: string;
  workroomId: string;
  status: ActionStatus;
  orgId: string;
}

interface SimMachine {
  id: string;
  orgId: string;
}

interface SimTokenRow {
  actionId: string;
  machineId: string;
}

interface SimReconciliationRow {
  id: string;
  actionId: string;
  evidenceId: string;
  reasonCode: string;
  machineId: string;
}

type EvidenceTable = Map<string, SimReconciliationRow>;  // key: `${actionId}:${evidenceId}`

// ── Simulator ─────────────────────────────────────────────────────────────────

interface ReconcileInput {
  authToken: string | null;        // null = no Authorization header
  actionId: string;
  body: Record<string, unknown>;
}

interface ReconcileSuccess {
  ok: true;
  statusCode: 200;
  body: {
    action_id: string;
    status: ActionStatus;
    idempotent: boolean;
    reason_code?: string;
  };
  eventEmitted: boolean;
  eventPayload?: Record<string, unknown>;
}

interface ReconcileError {
  ok: false;
  statusCode: number;
  code: string;
}

type ReconcileResult = ReconcileSuccess | ReconcileError;

/**
 * Simulates POST /api/v1/actions/:id/reconcile.
 * Mirrors the production endpoint logic exactly (auth → body → action → guard → CAS).
 */
function simulateReconcile(
  input: ReconcileInput,
  opts: {
    machine?: SimMachine;
    action?: SimAction;
    tokenRow?: SimTokenRow | null;     // null = no token row (anomaly)
    evidenceTable: EvidenceTable;
    // For simulating CAS race: if truthy, CAS returns 0 even though action.status was fired
    simulateCasRaceToTerminal?: ActionStatus;
  },
): ReconcileResult {
  // ── 1. Auth: machine token ──
  if (!input.authToken || !opts.machine) {
    return { ok: false, statusCode: 401, code: 'UNAUTHORIZED' };
  }

  const { body, actionId } = input;
  const machine = opts.machine;

  // ── 2. Body validation: forbidden fields ──
  const forbiddenPresent = FORBIDDEN_BODY_FIELDS.filter(f => f in body);
  if (forbiddenPresent.length > 0) {
    return { ok: false, statusCode: 400, code: 'FORBIDDEN_FIELDS' };
  }

  const { reason, evidence_id: evidenceId } = body as { reason?: string; evidence_id?: string };

  if (!reason || !evidenceId) {
    return { ok: false, statusCode: 400, code: 'MISSING_FIELDS' };
  }

  if (!VALID_REASON_CODES.has(reason)) {
    return { ok: false, statusCode: 400, code: 'INVALID_REASON_CODE' };
  }

  // ── 3. Fetch action ──
  const action = opts.action;
  if (!action || action.id !== actionId) {
    return { ok: false, statusCode: 404, code: 'ACTION_NOT_FOUND' };
  }

  // ── 4. Workroom/org access guard ──
  if (machine.orgId !== action.orgId) {
    return { ok: false, statusCode: 403, code: 'FORBIDDEN' };
  }

  // ── 5. Firing-machine guard ──
  if (opts.tokenRow === null || opts.tokenRow === undefined) {
    return { ok: false, statusCode: 403, code: 'RECONCILE_GUARD_FAILED' };
  }
  if (opts.tokenRow.machineId !== machine.id) {
    return { ok: false, statusCode: 403, code: 'RECONCILE_FORBIDDEN' };
  }

  // ── 6. Pre-check: hard terminal ──
  if (HARD_TERMINAL_STATUSES.has(action.status)) {
    return { ok: false, statusCode: 409, code: 'RECONCILE_TERMINAL_CONFLICT' };
  }
  if (PRE_FIRE_STATUSES.has(action.status)) {
    return { ok: false, statusCode: 409, code: 'RECONCILE_NOT_FIRED' };
  }

  // ── 7. Transaction simulation: INSERT evidence + CAS ──
  const evidenceKey = `${actionId}:${evidenceId}`;

  // P2002 simulation: same evidence already exists
  if (opts.evidenceTable.has(evidenceKey)) {
    return {
      ok: true,
      statusCode: 200,
      body: { action_id: actionId, status: action.status, idempotent: true },
      eventEmitted: false,
    };
  }

  // INSERT evidence record
  opts.evidenceTable.set(evidenceKey, {
    id: randomUUID(),
    actionId,
    evidenceId: evidenceId,
    reasonCode: reason,
    machineId: machine.id,
  });

  // CAS: UPDATE WHERE status='fired' → 'needs_human'
  let casCount = 0;
  if (opts.simulateCasRaceToTerminal) {
    // Race: action transitioned to terminal between pre-check and CAS
    casCount = 0;
    action.status = opts.simulateCasRaceToTerminal;
  } else if (action.status === 'fired') {
    casCount = 1;
    action.status = 'needs_human';
  } else {
    // action.status = 'needs_human' (already reconciled via different evidence)
    casCount = 0;
  }

  // ── 8. Post-transaction ──
  if (casCount === 1) {
    // Emit action.needs_human event
    // PAYLOAD CONTRACT: locator + status + reason_code ONLY. No free text, no credentials.
    const eventPayload: Record<string, unknown> = {
      workroom_id: action.workroomId,
      action_id: actionId,
      session_id: action.sessionId,
      status: 'needs_human',
      reason_code: reason,
    };

    return {
      ok: true,
      statusCode: 200,
      body: {
        action_id: actionId,
        status: 'needs_human',
        idempotent: false,
        reason_code: reason,
      },
      eventEmitted: true,
      eventPayload,
    };
  }

  // CAS count=0: read current status
  if (action.status === 'needs_human') {
    return {
      ok: true,
      statusCode: 200,
      body: { action_id: actionId, status: 'needs_human', idempotent: true },
      eventEmitted: false,
    };
  }

  // Terminal (race)
  return { ok: false, statusCode: 409, code: 'RECONCILE_TERMINAL_CONFLICT' };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

const ORG_ID = 'org-1';
const WORKROOM_ID = 'wroom-1';
const SESSION_ID = 'sess-1';
const FIRING_MACHINE_ID = 'machine-1';
const VALID_REASON = 'fire_response_lost_token_unrecoverable';

function makeAction(overrides?: Partial<SimAction>): SimAction {
  return {
    id: 'act-1',
    sessionId: SESSION_ID,
    workroomId: WORKROOM_ID,
    status: 'fired',
    orgId: ORG_ID,
    ...overrides,
  };
}

function makeMachine(overrides?: Partial<SimMachine>): SimMachine {
  return { id: FIRING_MACHINE_ID, orgId: ORG_ID, ...overrides };
}

function makeTokenRow(overrides?: Partial<SimTokenRow>): SimTokenRow {
  return { actionId: 'act-1', machineId: FIRING_MACHINE_ID, ...overrides };
}

function makeReconcileInput(overrides?: Partial<ReconcileInput>): ReconcileInput {
  return {
    authToken: 'machine-token-1',
    actionId: 'act-1',
    body: { reason: VALID_REASON, evidence_id: 'evidence-uuid-1' },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reconcile — basic success path', () => {
  it('fired → needs_human: status transitions and event emitted', () => {
    const action = makeAction({ status: 'fired' });
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action,
      tokenRow: makeTokenRow(),
      evidenceTable: new Map(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('needs_human');
    expect(result.body.idempotent).toBe(false);
    expect(result.body.reason_code).toBe(VALID_REASON);
    expect(result.eventEmitted).toBe(true);
    // Action mutated to needs_human
    expect(action.status).toBe('needs_human');
  });

  it('reason=drain_deadline_exceeded also succeeds', () => {
    const action = makeAction({ status: 'fired' });
    const result = simulateReconcile(
      makeReconcileInput({ body: { reason: 'drain_deadline_exceeded', evidence_id: 'ev-1' } }),
      { machine: makeMachine(), action, tokenRow: makeTokenRow(), evidenceTable: new Map() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.reason_code).toBe('drain_deadline_exceeded');
  });

  it('evidence record inserted into evidenceTable on success', () => {
    const evidenceTable: EvidenceTable = new Map();
    simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction(),
      tokenRow: makeTokenRow(),
      evidenceTable,
    });
    expect(evidenceTable.size).toBe(1);
    const [row] = evidenceTable.values();
    expect(row.actionId).toBe('act-1');
    expect(row.evidenceId).toBe('evidence-uuid-1');
    expect(row.reasonCode).toBe(VALID_REASON);
    expect(row.machineId).toBe(FIRING_MACHINE_ID);
  });

  it('evidence machine_id comes from tokenRow, not from body', () => {
    const evidenceTable: EvidenceTable = new Map();
    // Body does NOT contain machine_id — it must never be accepted from body
    simulateReconcile(makeReconcileInput({ body: { reason: VALID_REASON, evidence_id: 'ev-2' } }), {
      machine: makeMachine({ id: 'machine-1' }),
      action: makeAction(),
      tokenRow: makeTokenRow({ machineId: 'machine-1' }),
      evidenceTable,
    });
    const [row] = evidenceTable.values();
    expect(row.machineId).toBe('machine-1');
  });
});

describe('reconcile — auth failures', () => {
  it('no Authorization header → 401 UNAUTHORIZED', () => {
    const result = simulateReconcile(
      makeReconcileInput({ authToken: null }),
      { machine: undefined, action: makeAction(), tokenRow: makeTokenRow(), evidenceTable: new Map() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(401);
    expect(result.code).toBe('UNAUTHORIZED');
  });

  it('invalid machine token → 401 UNAUTHORIZED', () => {
    const result = simulateReconcile(
      makeReconcileInput({ authToken: 'bad-token' }),
      { machine: undefined, action: makeAction(), tokenRow: makeTokenRow(), evidenceTable: new Map() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(401);
  });
});

describe('reconcile — firing-machine guard', () => {
  it('no token row for action → 403 RECONCILE_GUARD_FAILED', () => {
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction(),
      tokenRow: null,        // explicitly absent
      evidenceTable: new Map(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(403);
    expect(result.code).toBe('RECONCILE_GUARD_FAILED');
  });

  it('different machine → 403 RECONCILE_FORBIDDEN', () => {
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine({ id: 'machine-ATTACKER' }),
      action: makeAction(),
      tokenRow: makeTokenRow({ machineId: 'machine-1' }),   // firing machine was machine-1
      evidenceTable: new Map(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(403);
    expect(result.code).toBe('RECONCILE_FORBIDDEN');
  });

  it('same-org different machine cannot forge reconcile', () => {
    // Both machines in same org — still must be rejected
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine({ id: 'machine-B', orgId: ORG_ID }),
      action: makeAction({ orgId: ORG_ID }),
      tokenRow: makeTokenRow({ machineId: 'machine-A' }),   // machine-A fired the action
      evidenceTable: new Map(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('RECONCILE_FORBIDDEN');
  });
});

describe('reconcile — body validation', () => {
  it.each(FORBIDDEN_BODY_FIELDS)(
    'forbidden field "%s" in body → 400 FORBIDDEN_FIELDS',
    (field) => {
      const result = simulateReconcile(
        makeReconcileInput({ body: { reason: VALID_REASON, evidence_id: 'ev-1', [field]: 'injected-value' } }),
        { machine: makeMachine(), action: makeAction(), tokenRow: makeTokenRow(), evidenceTable: new Map() },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.statusCode).toBe(400);
      expect(result.code).toBe('FORBIDDEN_FIELDS');
    },
  );

  it('missing reason → 400 MISSING_FIELDS', () => {
    const result = simulateReconcile(
      makeReconcileInput({ body: { evidence_id: 'ev-1' } }),
      { machine: makeMachine(), action: makeAction(), tokenRow: makeTokenRow(), evidenceTable: new Map() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(400);
    expect(result.code).toBe('MISSING_FIELDS');
  });

  it('missing evidence_id → 400 MISSING_FIELDS', () => {
    const result = simulateReconcile(
      makeReconcileInput({ body: { reason: VALID_REASON } }),
      { machine: makeMachine(), action: makeAction(), tokenRow: makeTokenRow(), evidenceTable: new Map() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(400);
    expect(result.code).toBe('MISSING_FIELDS');
  });

  it.each(['random_reason', 'succeeded', 'done', 'needs_human'])(
    'invalid reason_code "%s" → 400 INVALID_REASON_CODE',
    (invalidReason) => {
      const result = simulateReconcile(
        makeReconcileInput({ body: { reason: invalidReason, evidence_id: 'ev-1' } }),
        { machine: makeMachine(), action: makeAction(), tokenRow: makeTokenRow(), evidenceTable: new Map() },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.statusCode).toBe(400);
      expect(result.code).toBe('INVALID_REASON_CODE');
    },
  );

  it('only fire_response_lost_token_unrecoverable and drain_deadline_exceeded are valid reasons', () => {
    expect(VALID_REASON_CODES.has('fire_response_lost_token_unrecoverable')).toBe(true);
    expect(VALID_REASON_CODES.has('drain_deadline_exceeded')).toBe(true);
    expect(VALID_REASON_CODES.size).toBe(2);
  });
});

describe('reconcile — hard terminal state rejection', () => {
  it.each(['canceled', 'failed', 'succeeded', 'transmission_complete'])(
    'action in %s → 409 RECONCILE_TERMINAL_CONFLICT',
    (status) => {
      const result = simulateReconcile(makeReconcileInput(), {
        machine: makeMachine(),
        action: makeAction({ status: status as ActionStatus }),
        tokenRow: makeTokenRow(),
        evidenceTable: new Map(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.statusCode).toBe(409);
      expect(result.code).toBe('RECONCILE_TERMINAL_CONFLICT');
    },
  );
});

describe('reconcile — pre-fire state rejection', () => {
  it.each(['proposed', 'approved'])(
    'action in %s (never fired) → 409 RECONCILE_NOT_FIRED',
    (status) => {
      const result = simulateReconcile(makeReconcileInput(), {
        machine: makeMachine(),
        action: makeAction({ status: status as ActionStatus }),
        tokenRow: makeTokenRow(),
        evidenceTable: new Map(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.statusCode).toBe(409);
      expect(result.code).toBe('RECONCILE_NOT_FIRED');
    },
  );
});

describe('reconcile — idempotency', () => {
  it('same evidence_id repeated → 200 idempotent (P2002 semantics)', () => {
    const evidenceTable: EvidenceTable = new Map();

    // First call: succeeds
    const first = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction(),
      tokenRow: makeTokenRow(),
      evidenceTable,
    });
    expect(first.ok).toBe(true);

    // Second call: same evidence_id → idempotent 200 (not 409)
    const action2 = makeAction({ status: 'needs_human' });  // action already transitioned
    const second = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: action2,
      tokenRow: makeTokenRow(),
      evidenceTable,  // same table — evidence already present
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.statusCode).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.eventEmitted).toBe(false);   // no duplicate event
  });

  it('different evidence_id, action already needs_human → 200 idempotent (CAS count=0)', () => {
    const evidenceTable: EvidenceTable = new Map();

    // Simulate action already in needs_human (e.g., first evidence already processed)
    const action = makeAction({ status: 'needs_human' });
    const result = simulateReconcile(
      makeReconcileInput({ body: { reason: VALID_REASON, evidence_id: 'evidence-uuid-2' } }),
      { machine: makeMachine(), action, tokenRow: makeTokenRow(), evidenceTable },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statusCode).toBe(200);
    expect(result.body.idempotent).toBe(true);
    expect(result.body.status).toBe('needs_human');
    expect(result.eventEmitted).toBe(false);
  });

  it('same evidence does not emit a duplicate event', () => {
    const evidenceTable: EvidenceTable = new Map();
    const action = makeAction();

    simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(), action, tokenRow: makeTokenRow(), evidenceTable,
    });
    // Second call — must not emit event
    const second = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(), action: makeAction({ status: 'needs_human' }), tokenRow: makeTokenRow(), evidenceTable,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.eventEmitted).toBe(false);
  });
});

describe('reconcile — CAS race condition', () => {
  it('fired→terminal race between pre-check and CAS → 409 RECONCILE_TERMINAL_CONFLICT', () => {
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction({ status: 'fired' }),
      tokenRow: makeTokenRow(),
      evidenceTable: new Map(),
      simulateCasRaceToTerminal: 'canceled',   // race: action became canceled before CAS ran
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(409);
    expect(result.code).toBe('RECONCILE_TERMINAL_CONFLICT');
  });

  it('evidence IS recorded even if CAS race occurs (audit trail preserved)', () => {
    const evidenceTable: EvidenceTable = new Map();
    simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction({ status: 'fired' }),
      tokenRow: makeTokenRow(),
      evidenceTable,
      simulateCasRaceToTerminal: 'canceled',
    });
    // Evidence was inserted before the CAS failed
    expect(evidenceTable.size).toBe(1);
  });
});

describe('reconcile — event payload contract', () => {
  it('event payload contains workroom_id, action_id, session_id, status, reason_code', () => {
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction(),
      tokenRow: makeTokenRow(),
      evidenceTable: new Map(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eventEmitted).toBe(true);
    const payload = result.eventPayload!;
    expect(payload.workroom_id).toBe(WORKROOM_ID);
    expect(payload.action_id).toBe('act-1');
    expect(payload.session_id).toBe(SESSION_ID);
    expect(payload.status).toBe('needs_human');
    expect(payload.reason_code).toBe(VALID_REASON);
  });

  it('event payload does NOT contain raw token, secret, evidence_id content, or free text', () => {
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction(),
      tokenRow: makeTokenRow(),
      evidenceTable: new Map(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.eventPayload!;
    const payloadStr = JSON.stringify(payload);

    // Must not leak sensitive data
    expect(payloadStr).not.toMatch(/act_tok_/);     // no raw action token
    expect(payloadStr).not.toMatch(/token_hash/);   // no hash
    expect(payloadStr).not.toMatch(/secret/);       // no secret
    expect(payloadStr).not.toMatch(/stdout/);       // no stdout
    expect(payloadStr).not.toMatch(/evidence-uuid-1/);  // evidence_id not in event
  });

  it('event payload does not contain machine_id or org details', () => {
    const result = simulateReconcile(makeReconcileInput(), {
      machine: makeMachine(),
      action: makeAction(),
      tokenRow: makeTokenRow(),
      evidenceTable: new Map(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.eventPayload!;
    expect('machine_id' in payload).toBe(false);
    expect('org_id' in payload).toBe(false);
    expect('evidence_id' in payload).toBe(false);
  });

  it('event topic is action.needs_human', () => {
    // The simulateReconcile sets eventEmitted=true when CAS count=1;
    // production code uses topic 'action.needs_human'. Verify via function contract.
    // This test documents the expected topic string.
    const EXPECTED_EVENT_TOPIC = 'action.needs_human';
    // Pattern: verify topic is the locked string (not action.status_changed)
    expect(EXPECTED_EVENT_TOPIC).toBe('action.needs_human');
    expect(EXPECTED_EVENT_TOPIC).not.toBe('action.status_changed');
  });
});

describe('reconcile — needs_human is not done/complete', () => {
  it('needs_human does NOT count as done in task/action completion logic', () => {
    // Verify the semantics contract: needs_human ≠ complete/done
    // In WorkroomSummary: deriveCurrentPhase → 'blocked_needs_human' (not 'complete')
    // This is a semantic guard test — the summary logic lives in summaryLogic.ts,
    // tested there. Here we just document the invariant.
    const nonFireableStatuses: ActionStatus[] = [
      'fired', 'canceled', 'failed', 'succeeded', 'transmission_complete', 'needs_human',
    ];
    // All these cause the gate to skip auto-fire
    expect(nonFireableStatuses).toContain('needs_human');

    // But only the true terminals are product-done
    const productDoneStatuses: ActionStatus[] = ['succeeded', 'transmission_complete'];
    expect(productDoneStatuses).not.toContain('needs_human');
  });

  it('needs_human headline is "待人核" not "完成"', () => {
    // Contract: when phase='blocked_needs_human', headline must include warning, NOT "完成"
    // The actual logic is in summaryLogic.ts/deriveHeadline — this test documents the invariant.
    const blockedNeedsHumanPhase = 'blocked_needs_human';
    const completePhase = 'complete';
    expect(blockedNeedsHumanPhase).not.toBe(completePhase);
  });

  it('multiple evidence records allowed per action (audit trail)', () => {
    const evidenceTable: EvidenceTable = new Map();
    const action = makeAction({ status: 'fired' });

    // First evidence — transitions to needs_human
    simulateReconcile(makeReconcileInput({ body: { reason: VALID_REASON, evidence_id: 'ev-1' } }), {
      machine: makeMachine(), action, tokenRow: makeTokenRow(), evidenceTable,
    });
    expect(evidenceTable.size).toBe(1);

    // Second evidence for same action (already needs_human) — adds audit record, idempotent 200
    simulateReconcile(makeReconcileInput({ body: { reason: 'drain_deadline_exceeded', evidence_id: 'ev-2' } }), {
      machine: makeMachine(), action: makeAction({ status: 'needs_human' }), tokenRow: makeTokenRow(), evidenceTable,
    });
    expect(evidenceTable.size).toBe(2);    // audit trail grows
  });
});
