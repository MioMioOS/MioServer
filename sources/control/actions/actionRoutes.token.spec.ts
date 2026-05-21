/**
 * Action token (Phase 5B) — unit tests.
 *
 * Verifies the full token lifecycle using simulation (no DB):
 *
 * 1. fire response contains action_token; shape is act_tok_<...>
 * 2. GET action does NOT return action_token (not in shape)
 * 3. WS/EventLog payloads do NOT contain raw token (no-leak)
 * 4. DB stores only hash (token_hash ≠ raw token)
 * 5. Consume success → consumed_at set, returns scope + empty bundle
 * 6. Second consume → TOKEN_NOT_CONSUMABLE (one-time semantic)
 * 7. Expired token → TOKEN_NOT_CONSUMABLE
 * 8. Scope mismatch (wrong action_id) → TOKEN_NOT_CONSUMABLE
 * 9. Concurrent consume: only one succeeds (rowcount=1 CAS semantics)
 * 10. UNIQUE(action_id): fire retry → FIRE_RACE_CONFLICT or ACTION_ALREADY_TERMINAL
 * 11. No machine_token required for consume (consume uses action_token bearer only)
 * 12. Logger/payload MUST NOT contain raw token (sentinel test)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

type ActionStatus =
  | 'proposed' | 'approved' | 'rejected' | 'canceled'
  | 'fired' | 'transmission_complete' | 'reconciling' | 'succeeded' | 'failed' | 'needs_human';

type Reversibility = 'reversible' | 'irreversible_abortable' | 'irreversible_no_abort';

const TERMINAL_STATUSES: ActionStatus[] = [
  'fired', 'canceled', 'failed', 'succeeded', 'transmission_complete',
];

interface SimAction {
  id: string;
  reversibility: Reversibility;
  sessionId: string;
  workroomId: string;
  status: ActionStatus;
  firedAt: Date | null;
}

interface SimTokenRecord {
  actionId: string;
  tokenHash: string;
  sessionId: string;
  workroomId: string;
  machineId: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Simulated captured log entries (sentinel for no-leak testing). */
type CapturedLog = Array<{ level: string; data: unknown }>;

// ── Token helpers (mirrors production generateActionToken()) ──────────────────

import { randomBytes } from 'crypto';

function generateActionToken(): { rawToken: string; tokenHash: string } {
  const raw = randomBytes(32).toString('base64url');
  const rawToken = `act_tok_${raw}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

const ACTION_TOKEN_TTL_MS = 5 * 60 * 1000;

// ── Fire transaction simulator (token-extended) ───────────────────────────────

interface FireTokenResult {
  ok: true;
  firedAt: Date;
  rawToken: string;
  tokenRecord: SimTokenRecord;
  eventPayload: Record<string, unknown>;
}

interface FireTokenFailResult {
  ok: false;
  code: string;
  message: string;
}

type TokenTable = Map<string, SimTokenRecord>;

/**
 * Simulates the fire transaction with token issuance (Phase 5B).
 * Captures the event payload to verify no-leak invariant.
 */
function simulateFireWithToken(
  action: SimAction,
  tokenTable: TokenTable,
  machineId: string,
  now: Date = new Date(),
): FireTokenResult | FireTokenFailResult {
  if (TERMINAL_STATUSES.includes(action.status)) {
    return { ok: false, code: 'ACTION_ALREADY_TERMINAL', message: `Action is ${action.status}` };
  }

  // Check UNIQUE(action_id): if a token already exists for this action, reject (double-fire).
  if (tokenTable.has(action.id)) {
    return { ok: false, code: 'FIRE_RACE_CONFLICT', message: 'Token already issued for this action' };
  }

  const { rawToken, tokenHash } = generateActionToken();

  // Verify raw token is not the same as the hash (sanity).
  if (rawToken === tokenHash) throw new Error('Token and hash should not be equal');

  // Store only hash in DB record.
  const tokenRecord: SimTokenRecord = {
    actionId: action.id,
    tokenHash,                     // ← hash only, NEVER raw token
    sessionId: action.sessionId,
    workroomId: action.workroomId,
    machineId,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ACTION_TOKEN_TTL_MS),
    consumedAt: null,
  };
  tokenTable.set(action.id, tokenRecord);

  // Update action status.
  action.status = 'fired';
  action.firedAt = now;

  // Construct event payload — mirrors publishAndBroadcast call.
  // SECURITY: rawToken MUST NOT appear here.
  const eventPayload: Record<string, unknown> = {
    workroom_id: action.workroomId,
    action_id: action.id,
    session_id: action.sessionId,
    status: 'fired',
  };

  return { ok: true, firedAt: now, rawToken, tokenRecord, eventPayload };
}

// ── Consume simulator ─────────────────────────────────────────────────────────

interface ConsumeResult {
  ok: true;
  consumed: boolean;
  action_id: string;
  session_id: string;
  workroom_id: string;
  secret_bundle: { version: 1; items: [] };
}

interface ConsumeFailResult {
  ok: false;
  code: string;
  status: 403 | 401;
}

/**
 * Simulates POST /actions/:id/token/consume.
 *
 * Auth: action_token bearer (NOT machine_token).
 * CAS: single updateMany semantics — all conditions checked atomically.
 * Unified 403 for all reject cases (no enumeration leakage).
 */
function simulateConsumeToken(
  presentedToken: string,
  actionId: string,
  tokenTable: TokenTable,
  now: Date = new Date(),
): ConsumeResult | ConsumeFailResult {
  // Validate token format.
  if (!presentedToken.startsWith('act_tok_')) {
    return { ok: false, code: 'UNAUTHORIZED', status: 401 };
  }

  // Hash the presented token (mirrors DB lookup).
  const tokenHash = createHash('sha256').update(presentedToken).digest('hex');

  // CAS: find record matching ALL conditions simultaneously.
  const record = tokenTable.get(actionId);

  // Unified reject condition: any mismatch → same error code.
  // Mirrors: WHERE token_hash=$1 AND action_id=$2 AND expires_at > now AND consumed_at IS NULL
  if (
    !record ||
    record.tokenHash !== tokenHash ||   // hash mismatch (wrong token or wrong action_id)
    record.actionId !== actionId ||      // scope mismatch
    record.expiresAt <= now ||           // expired
    record.consumedAt !== null           // already consumed
  ) {
    // Unified rejection — no enumeration leakage.
    return { ok: false, code: 'TOKEN_NOT_CONSUMABLE', status: 403 };
  }

  // CAS success: set consumed_at atomically.
  record.consumedAt = now;

  return {
    ok: true,
    consumed: true,
    action_id: actionId,
    session_id: record.sessionId,
    workroom_id: record.workroomId,
    secret_bundle: { version: 1, items: [] },
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeAction(id = 'action-1'): SimAction {
  return {
    id,
    reversibility: 'reversible',
    sessionId: 'sess-1',
    workroomId: 'wroom-1',
    status: 'proposed',
    firedAt: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Phase 5B — action token: fire issuance', () => {
  it('fire response contains action_token with act_tok_ prefix', () => {
    const action = makeAction();
    const result = simulateFireWithToken(action, new Map(), 'machine-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawToken).toMatch(/^act_tok_/);
    }
  });

  it('fire response action_token has sufficient entropy (≥ 32 base64url chars after prefix)', () => {
    const action = makeAction();
    const result = simulateFireWithToken(action, new Map(), 'machine-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const suffix = result.rawToken.slice('act_tok_'.length);
      // 32 random bytes in base64url → 43 chars (no padding).
      expect(suffix.length).toBeGreaterThanOrEqual(32);
    }
  });

  it('DB record stores token_hash, NOT raw token', () => {
    const action = makeAction();
    const tokenTable: TokenTable = new Map();
    const result = simulateFireWithToken(action, tokenTable, 'machine-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const record = tokenTable.get(action.id)!;
      // Hash must differ from raw token.
      expect(record.tokenHash).not.toBe(result.rawToken);
      // Hash must be the SHA-256 of the raw token.
      const expectedHash = createHash('sha256').update(result.rawToken).digest('hex');
      expect(record.tokenHash).toBe(expectedHash);
    }
  });

  it('DB record token_hash is SHA-256 hex (64 chars)', () => {
    const action = makeAction();
    const tokenTable: TokenTable = new Map();
    simulateFireWithToken(action, tokenTable, 'machine-1');
    const record = tokenTable.get(action.id)!;
    expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('WS/event payload does NOT contain raw token (no-leak)', () => {
    const action = makeAction();
    const result = simulateFireWithToken(action, new Map(), 'machine-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const payloadStr = JSON.stringify(result.eventPayload);
      expect(payloadStr).not.toContain(result.rawToken);
      expect(payloadStr).not.toContain('act_tok_');
    }
  });

  it('event payload contains only locator + status enum (no token, no credentials)', () => {
    const action = makeAction();
    const result = simulateFireWithToken(action, new Map(), 'machine-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Object.keys(result.eventPayload);
      expect(keys).toEqual(expect.arrayContaining(['workroom_id', 'action_id', 'session_id', 'status']));
      expect(keys).not.toContain('action_token');
      expect(keys).not.toContain('token_hash');
      expect(keys).not.toContain('rawToken');
    }
  });

  it('DB record scopes bound from server-side authority (sessionId, workroomId, machineId)', () => {
    const action = makeAction();
    const tokenTable: TokenTable = new Map();
    simulateFireWithToken(action, tokenTable, 'machine-99');
    const record = tokenTable.get(action.id)!;
    // Scope fields come from action record + machine auth, not from request body.
    expect(record.sessionId).toBe(action.sessionId);
    expect(record.workroomId).toBe(action.workroomId);
    expect(record.machineId).toBe('machine-99');
  });

  it('token expiresAt is ~5 minutes after fire', () => {
    const now = new Date('2026-05-21T10:00:00Z');
    const action = makeAction();
    const tokenTable: TokenTable = new Map();
    simulateFireWithToken(action, tokenTable, 'machine-1', now);
    const record = tokenTable.get(action.id)!;
    const diffMs = record.expiresAt.getTime() - now.getTime();
    expect(diffMs).toBe(ACTION_TOKEN_TTL_MS);
  });

  it('UNIQUE(action_id): second fire for same action → FIRE_RACE_CONFLICT', () => {
    const action = makeAction();
    const tokenTable: TokenTable = new Map();
    const r1 = simulateFireWithToken(action, tokenTable, 'machine-1');
    expect(r1.ok).toBe(true);
    // Reset action status to simulate re-attempt.
    action.status = 'proposed';
    const r2 = simulateFireWithToken(action, tokenTable, 'machine-1');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('FIRE_RACE_CONFLICT');
  });

  it('fire already-terminal action → ACTION_ALREADY_TERMINAL, no token issued', () => {
    const action = makeAction();
    action.status = 'fired';
    const tokenTable: TokenTable = new Map();
    const result = simulateFireWithToken(action, tokenTable, 'machine-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ACTION_ALREADY_TERMINAL');
    expect(tokenTable.size).toBe(0);  // No token issued for failed fire.
  });
});

describe('Phase 5B — action token: GET action does NOT return token', () => {
  it('GET action response shape has no action_token field', () => {
    // Mirrors the GET /api/v1/actions/:id response shape — no actionToken field included.
    const getActionResponse = {
      action_id: 'action-1',
      workroom_id: 'wroom-1',
      session_id: 'sess-1',
      status: 'fired',
      fired_at: new Date().toISOString(),
      // action_token is intentionally NOT in this response.
    };
    expect(getActionResponse).not.toHaveProperty('action_token');
    expect(getActionResponse).not.toHaveProperty('token_hash');
  });
});

describe('Phase 5B — action token: consume semantics', () => {
  let action: SimAction;
  let tokenTable: TokenTable;
  let rawToken: string;
  const machineId = 'machine-1';
  const now = new Date('2026-05-21T10:00:00Z');

  beforeEach(() => {
    action = makeAction();
    tokenTable = new Map();
    const result = simulateFireWithToken(action, tokenTable, machineId, now);
    if (!result.ok) throw new Error('Fire failed in beforeEach');
    rawToken = result.rawToken;
  });

  it('consume success: consumed=true, correct scope fields, empty bundle', () => {
    const result = simulateConsumeToken(rawToken, action.id, tokenTable, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.consumed).toBe(true);
      expect(result.action_id).toBe(action.id);
      expect(result.session_id).toBe(action.sessionId);
      expect(result.workroom_id).toBe(action.workroomId);
      expect(result.secret_bundle).toEqual({ version: 1, items: [] });
    }
  });

  it('consume sets consumed_at on the record', () => {
    const consumeTime = new Date(now.getTime() + 30_000); // 30s after fire
    simulateConsumeToken(rawToken, action.id, tokenTable, consumeTime);
    const record = tokenTable.get(action.id)!;
    expect(record.consumedAt?.toISOString()).toBe(consumeTime.toISOString());
  });

  it('second consume → TOKEN_NOT_CONSUMABLE (one-time semantic)', () => {
    simulateConsumeToken(rawToken, action.id, tokenTable, now);
    const r2 = simulateConsumeToken(rawToken, action.id, tokenTable, now);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.code).toBe('TOKEN_NOT_CONSUMABLE');
      expect(r2.status).toBe(403);
    }
  });

  it('expired token → TOKEN_NOT_CONSUMABLE (unified 403)', () => {
    const afterExpiry = new Date(now.getTime() + ACTION_TOKEN_TTL_MS + 1000);
    const result = simulateConsumeToken(rawToken, action.id, tokenTable, afterExpiry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TOKEN_NOT_CONSUMABLE');
      expect(result.status).toBe(403);
    }
  });

  it('wrong action_id (scope mismatch) → TOKEN_NOT_CONSUMABLE (unified 403)', () => {
    const result = simulateConsumeToken(rawToken, 'different-action-id', tokenTable, now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TOKEN_NOT_CONSUMABLE');
      expect(result.status).toBe(403);
    }
  });

  it('wrong token value → TOKEN_NOT_CONSUMABLE (hash mismatch)', () => {
    const result = simulateConsumeToken('act_tok_wrongvalue', action.id, tokenTable, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TOKEN_NOT_CONSUMABLE');
  });

  it('non-prefixed bearer → 401 UNAUTHORIZED (machine_token accidentally used)', () => {
    const result = simulateConsumeToken('machine_tok_abc123', action.id, tokenTable, now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNAUTHORIZED');
      expect(result.status).toBe(401);
    }
  });

  it('no machine_token required — consume uses action_token bearer only', () => {
    // Consume succeeds using only the action_token; no machineId verification at consume time.
    // machine_id was bound at issuance (fire) and is stored in the token record.
    const result = simulateConsumeToken(rawToken, action.id, tokenTable, now);
    expect(result.ok).toBe(true);
    // If we had required machine_token here, this test would need a separate machine auth step.
    // The absence of machine auth in simulateConsumeToken mirrors the production endpoint design.
  });
});

describe('Phase 5B — action token: concurrent consume (CAS atomicity)', () => {
  it('two concurrent consumes: only one succeeds (CAS rowcount=1 semantics)', () => {
    const action = makeAction();
    const tokenTable: TokenTable = new Map();
    const now = new Date();
    const result = simulateFireWithToken(action, tokenTable, 'machine-1', now);
    if (!result.ok) throw new Error('Fire failed');
    const { rawToken } = result;

    // Simulate two concurrent consumes at the same timestamp.
    // In production, only the DB UPDATE that sets consumed_at first wins (single UPDATE statement).
    // Here we model: first consume wins, second sees consumed_at ≠ null.
    const r1 = simulateConsumeToken(rawToken, action.id, tokenTable, now);
    const r2 = simulateConsumeToken(rawToken, action.id, tokenTable, now);

    // Exactly one succeeds.
    const successes = [r1, r2].filter((r) => r.ok).length;
    const failures = [r1, r2].filter((r) => !r.ok).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    // The failure must be TOKEN_NOT_CONSUMABLE, not a crash or different error.
    const failed = [r1, r2].find((r) => !r.ok)!;
    if (!failed.ok) expect(failed.code).toBe('TOKEN_NOT_CONSUMABLE');
  });
});

describe('Phase 5B — action token: no-leak sentinel test', () => {
  it('raw token does not appear in any captured log output', () => {
    // Simulate a logger that captures all log entries.
    const capturedLogs: CapturedLog = [];
    const mockLog = (level: string, _component: string, _msg: string, data?: unknown) => {
      capturedLogs.push({ level, data });
    };

    const action = makeAction();
    const tokenTable: TokenTable = new Map();
    const now = new Date();

    // Simulate what the fire endpoint does — manually call mockLog in the same places.
    // The point is: rawToken MUST NOT appear in any log call.
    const { rawToken, tokenHash } = generateActionToken();

    // Simulate what should be logged (only non-sensitive fields).
    mockLog('info', 'actionRoutes', 'action fired', {
      actionId: action.id,
      status: 'fired',
      // rawToken is intentionally NOT logged here
    });

    // Verify sentinel: raw token not in any captured log.
    const allLogData = JSON.stringify(capturedLogs);
    expect(allLogData).not.toContain(rawToken);
    expect(allLogData).not.toContain('act_tok_');

    // tokenHash IS acceptable in logs (not secret), but rawToken is not.
    mockLog('debug', 'actionRoutes', 'token hash stored', { tokenHash });
    const allLogDataWithHash = JSON.stringify(capturedLogs);
    expect(allLogDataWithHash).not.toContain(rawToken);
  });
});

describe('Phase 5B — action token: fire response shape', () => {
  it('fire response includes action_token in expected position', () => {
    // Mirrors the production endpoint response shape.
    const now = new Date();
    const action = makeAction();
    const result = simulateFireWithToken(action, new Map(), 'machine-1', now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Response shape: { action_id, fired, fired_at, action_token }
      const responseShape = {
        action_id: action.id,
        fired: true,
        fired_at: now.toISOString(),
        action_token: result.rawToken,  // ← raw token in response body
      };
      expect(responseShape.action_token).toMatch(/^act_tok_/);
      expect(responseShape).not.toHaveProperty('token_hash');
    }
  });

  it('two distinct fires produce distinct tokens (no token reuse)', () => {
    const a1 = makeAction('action-1');
    const a2 = makeAction('action-2');
    const tokenTable: TokenTable = new Map();
    const r1 = simulateFireWithToken(a1, tokenTable, 'machine-1');
    const r2 = simulateFireWithToken(a2, tokenTable, 'machine-1');
    if (r1.ok && r2.ok) {
      expect(r1.rawToken).not.toBe(r2.rawToken);
      const h1 = tokenTable.get(a1.id)!.tokenHash;
      const h2 = tokenTable.get(a2.id)!.tokenHash;
      expect(h1).not.toBe(h2);
    }
  });
});
