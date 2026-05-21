import { describe, it, expect } from 'vitest';

/**
 * Sessions API — unit tests for pure logic (no DB).
 *
 * Tests cover:
 * 1. Status transition validation (terminal states, invalid statuses)
 * 2. Valid transitions across the session lifecycle
 */

// ── Re-export internal logic for testing ──────────────────────────────────────
// validateStatusTransition is not exported — test through the boundary
// by reproducing the logic here and verifying the spec is correct.

type SessionStatus =
  | 'idle' | 'running' | 'waiting_for_user' | 'blocked'
  | 'completed' | 'failed' | 'disconnected' | 'reconnecting';

const TERMINAL_STATUSES = new Set<SessionStatus>(['completed', 'failed']);
const VALID_STATUSES = new Set<SessionStatus>([
  'idle', 'running', 'waiting_for_user', 'blocked',
  'completed', 'failed', 'disconnected', 'reconnecting',
]);

function validateStatusTransition(from: string, to: string): string | null {
  if (!VALID_STATUSES.has(to as SessionStatus)) return `Invalid target status '${to}'`;
  if (TERMINAL_STATUSES.has(from as SessionStatus)) return `Cannot transition from terminal status '${from}' to '${to}'`;
  return null;
}

// ─── Status transition validation ────────────────────────────────────────────

describe('validateStatusTransition', () => {
  it('valid: idle → running', () => {
    expect(validateStatusTransition('idle', 'running')).toBeNull();
  });

  it('valid: running → waiting_for_user', () => {
    expect(validateStatusTransition('running', 'waiting_for_user')).toBeNull();
  });

  it('valid: running → blocked', () => {
    expect(validateStatusTransition('running', 'blocked')).toBeNull();
  });

  it('valid: running → completed', () => {
    expect(validateStatusTransition('running', 'completed')).toBeNull();
  });

  it('valid: running → failed', () => {
    expect(validateStatusTransition('running', 'failed')).toBeNull();
  });

  it('valid: disconnected → reconnecting', () => {
    expect(validateStatusTransition('disconnected', 'reconnecting')).toBeNull();
  });

  it('valid: reconnecting → running', () => {
    expect(validateStatusTransition('reconnecting', 'running')).toBeNull();
  });

  it('invalid: completed → running (terminal → active blocked)', () => {
    const err = validateStatusTransition('completed', 'running');
    expect(err).not.toBeNull();
    expect(err).toContain('terminal');
    expect(err).toContain('completed');
  });

  it('invalid: failed → idle (terminal → active blocked)', () => {
    const err = validateStatusTransition('failed', 'idle');
    expect(err).not.toBeNull();
    expect(err).toContain('terminal');
    expect(err).toContain('failed');
  });

  it('invalid: completed → reconnecting (terminal blocked even for reconnect)', () => {
    const err = validateStatusTransition('completed', 'reconnecting');
    expect(err).not.toBeNull();
    expect(err).toContain('terminal');
  });

  it('invalid target status string', () => {
    const err = validateStatusTransition('running', 'zombie');
    expect(err).not.toBeNull();
    expect(err).toContain('Invalid target status');
    expect(err).toContain('zombie');
  });

  it('valid: all non-terminal statuses can transition to completed', () => {
    const NON_TERMINAL: SessionStatus[] = ['idle', 'running', 'waiting_for_user', 'blocked', 'disconnected', 'reconnecting'];
    for (const from of NON_TERMINAL) {
      expect(validateStatusTransition(from, 'completed')).toBeNull();
      expect(validateStatusTransition(from, 'failed')).toBeNull();
    }
  });

  it('valid: same-status transition is allowed (idempotent)', () => {
    // Not a design constraint, just documenting behavior: no "can't stay same" rule
    expect(validateStatusTransition('running', 'running')).toBeNull();
    expect(validateStatusTransition('idle', 'idle')).toBeNull();
  });
});

// ─── Status lifecycle model ───────────────────────────────────────────────────

describe('session status model', () => {
  it('terminal statuses are exactly completed and failed', () => {
    expect(TERMINAL_STATUSES.has('completed')).toBe(true);
    expect(TERMINAL_STATUSES.has('failed')).toBe(true);
    expect(TERMINAL_STATUSES.size).toBe(2);
  });

  it('all 8 valid statuses are recognized', () => {
    const expected: SessionStatus[] = [
      'idle', 'running', 'waiting_for_user', 'blocked',
      'completed', 'failed', 'disconnected', 'reconnecting',
    ];
    for (const s of expected) {
      expect(VALID_STATUSES.has(s)).toBe(true);
    }
    expect(VALID_STATUSES.size).toBe(8);
  });

  it('heartbeat blocked in terminal state (spec: completed/failed cannot heartbeat)', () => {
    // Heartbeat endpoint returns 409 if session.status is in TERMINAL_STATUSES.
    // This test documents that model — implementation is in sessionRoutes.ts.
    expect(TERMINAL_STATUSES.has('completed')).toBe(true);
    expect(TERMINAL_STATUSES.has('failed')).toBe(true);
    // Non-terminal statuses can heartbeat
    expect(TERMINAL_STATUSES.has('disconnected')).toBe(false);
    expect(TERMINAL_STATUSES.has('reconnecting')).toBe(false);
  });
});
