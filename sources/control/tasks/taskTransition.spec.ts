/**
 * Unit tests for validateTaskTransition.
 *
 * Uses the agent-facing status set: todo | in_progress | in_review | done | canceled.
 * waiting_approval is a server-only state — NOT a valid agent-facing status; any
 * transition from or to it is treated as unknown/invalid.
 */
import { describe, it, expect } from 'vitest';
import { validateTaskTransition } from './taskTransition';

describe('validateTaskTransition', () => {
  // ── Legal transitions ──────────────────────────────────────────────────────

  it('todo → in_progress is valid', () => {
    expect(validateTaskTransition('todo', 'in_progress')).toEqual({ ok: true });
  });

  it('in_progress → in_review is valid', () => {
    expect(validateTaskTransition('in_progress', 'in_review')).toEqual({ ok: true });
  });

  it('in_review → done is valid', () => {
    expect(validateTaskTransition('in_review', 'done')).toEqual({ ok: true });
  });

  it('in_review → in_progress is valid (send back for rework)', () => {
    expect(validateTaskTransition('in_review', 'in_progress')).toEqual({ ok: true });
  });

  it('in_progress → done is valid (bypass review)', () => {
    expect(validateTaskTransition('in_progress', 'done')).toEqual({ ok: true });
  });

  // ── Terminal sources (done / canceled → anything) ─────────────────────────

  it('done → todo is invalid (terminal source)', () => {
    expect(validateTaskTransition('done', 'todo')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('done → in_progress is invalid (terminal source)', () => {
    expect(validateTaskTransition('done', 'in_progress')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('done → done is invalid (terminal source)', () => {
    expect(validateTaskTransition('done', 'done')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('canceled → todo is invalid (terminal source)', () => {
    expect(validateTaskTransition('canceled', 'todo')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('canceled → in_progress is invalid (terminal source)', () => {
    expect(validateTaskTransition('canceled', 'in_progress')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  // ── Illegal (no path in the transition table) ─────────────────────────────

  it('todo → done is invalid (no direct path)', () => {
    expect(validateTaskTransition('todo', 'done')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('todo → in_review is invalid', () => {
    expect(validateTaskTransition('todo', 'in_review')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('todo → canceled is invalid', () => {
    expect(validateTaskTransition('todo', 'canceled')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('in_review → todo is invalid', () => {
    expect(validateTaskTransition('in_review', 'todo')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('in_progress → todo is invalid', () => {
    expect(validateTaskTransition('in_progress', 'todo')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  // ── waiting_approval — server-only, not agent-facing → always invalid ──────

  it('waiting_approval → in_review is invalid (server-only state)', () => {
    expect(validateTaskTransition('waiting_approval', 'in_review')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('in_progress → waiting_approval is invalid (server-only state)', () => {
    expect(validateTaskTransition('in_progress', 'waiting_approval')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  // ── Completely unknown strings ─────────────────────────────────────────────

  it('unknown from-status is invalid', () => {
    expect(validateTaskTransition('PENDING', 'in_progress')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('unknown to-status is invalid', () => {
    expect(validateTaskTransition('todo', 'UNKNOWN')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });

  it('both unknown is invalid', () => {
    expect(validateTaskTransition('foo', 'bar')).toEqual({
      ok: false,
      code: 'INVALID_TASK_TRANSITION',
    });
  });
});
