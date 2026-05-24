/**
 * S3 Slock Task status translation — unit tests.
 *
 * The server keeps its own stored status vocabulary (todo|in_progress|
 * waiting_approval|in_review|done|canceled); the Slock iOS API speaks an
 * UPPERCASE vocabulary (TODO|IN_PROGRESS|IN_REVIEW|DONE|CLOSED). These helpers
 * translate at the API boundary. waiting_approval has no iOS counterpart so it
 * maps to IN_REVIEW on the way out (it is never a valid inbound value).
 */
import { describe, it, expect } from 'vitest';
import { slockToServerStatus, serverToSlockStatus } from './slockTaskStatus';

describe('slockToServerStatus (iOS → server)', () => {
  it('maps each Slock status to its server status', () => {
    expect(slockToServerStatus('TODO')).toBe('todo');
    expect(slockToServerStatus('IN_PROGRESS')).toBe('in_progress');
    expect(slockToServerStatus('IN_REVIEW')).toBe('in_review');
    expect(slockToServerStatus('DONE')).toBe('done');
    expect(slockToServerStatus('CLOSED')).toBe('canceled');
  });

  it('returns null for an unknown / invalid inbound status', () => {
    expect(slockToServerStatus('WAITING_APPROVAL')).toBeNull();
    expect(slockToServerStatus('todo')).toBeNull(); // lowercase is not the iOS vocab
    expect(slockToServerStatus('')).toBeNull();
    expect(slockToServerStatus('garbage')).toBeNull();
  });
});

describe('serverToSlockStatus (server → iOS)', () => {
  it('maps each server status to its Slock status', () => {
    expect(serverToSlockStatus('todo')).toBe('TODO');
    expect(serverToSlockStatus('in_progress')).toBe('IN_PROGRESS');
    expect(serverToSlockStatus('in_review')).toBe('IN_REVIEW');
    expect(serverToSlockStatus('done')).toBe('DONE');
    expect(serverToSlockStatus('canceled')).toBe('CLOSED');
  });

  it('maps waiting_approval → IN_REVIEW (no iOS waiting_approval state)', () => {
    expect(serverToSlockStatus('waiting_approval')).toBe('IN_REVIEW');
  });

  it('falls back to TODO for an unknown server status (never crashes the wire shape)', () => {
    expect(serverToSlockStatus('something_new')).toBe('TODO');
  });

  it('round-trips the canonical inbound statuses', () => {
    for (const s of ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const) {
      const server = slockToServerStatus(s);
      expect(server).not.toBeNull();
      expect(serverToSlockStatus(server!)).toBe(s);
    }
    // CLOSED → canceled → CLOSED.
    expect(serverToSlockStatus(slockToServerStatus('CLOSED')!)).toBe('CLOSED');
  });
});
