/**
 * reminderCadence.spec.ts — unit tests for the cadence grammar (Slice 4.1, Chunk F).
 *
 * All vectors use a FIXED `from` so the UTC-deterministic computation is reproducible
 * regardless of the host timezone. Run: npx vitest run sources/control/reminders/reminderCadence.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { parseCadence, computeNextFireAt } from './reminderCadence';

// 2026-05-25 is a MONDAY (UTC).
const MON_08_00 = new Date('2026-05-25T08:00:00Z');
const MON_10_00 = new Date('2026-05-25T10:00:00Z');

describe('parseCadence', () => {
  it('parses every:<int><unit>', () => {
    expect(parseCadence('every:1s')).toEqual({ kind: 'every', ms: 1_000 });
    expect(parseCadence('every:15m')).toEqual({ kind: 'every', ms: 15 * 60_000 });
    expect(parseCadence('every:2h')).toEqual({ kind: 'every', ms: 2 * 3_600_000 });
    expect(parseCadence('every:1d')).toEqual({ kind: 'every', ms: 86_400_000 });
  });

  it('parses daily@HH:MM', () => {
    expect(parseCadence('daily@09:00')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(parseCadence('daily@23:59')).toEqual({ kind: 'daily', hour: 23, minute: 59 });
  });

  it('parses weekly:<dow>@HH:MM', () => {
    expect(parseCadence('weekly:mon@09:00')).toEqual({ kind: 'weekly', dow: 1, hour: 9, minute: 0 });
    expect(parseCadence('weekly:sun@00:00')).toEqual({ kind: 'weekly', dow: 0, hour: 0, minute: 0 });
    expect(parseCadence('weekly:sat@18:30')).toEqual({ kind: 'weekly', dow: 6, hour: 18, minute: 30 });
  });

  it('throws on invalid rules', () => {
    expect(() => parseCadence('every:0m')).toThrow();
    expect(() => parseCadence('every:-5m')).toThrow();
    expect(() => parseCadence('every:5x')).toThrow();
    expect(() => parseCadence('daily@25:00')).toThrow();
    expect(() => parseCadence('daily@09:60')).toThrow();
    expect(() => parseCadence('weekly:xxx@09:00')).toThrow();
    expect(() => parseCadence('weekly:mon@09')).toThrow();
    expect(() => parseCadence('garbage')).toThrow();
    expect(() => parseCadence('')).toThrow();
    expect(() => parseCadence('  ')).toThrow();
  });
});

describe('computeNextFireAt — every', () => {
  it('every:15m → from + 15min', () => {
    expect(computeNextFireAt('every:15m', MON_08_00).toISOString()).toBe('2026-05-25T08:15:00.000Z');
  });
  it('every:2h → from + 2h', () => {
    expect(computeNextFireAt('every:2h', MON_08_00).toISOString()).toBe('2026-05-25T10:00:00.000Z');
  });
  it('every:1d → from + 1d', () => {
    expect(computeNextFireAt('every:1d', MON_08_00).toISOString()).toBe('2026-05-26T08:00:00.000Z');
  });
});

describe('computeNextFireAt — daily', () => {
  it('daily@09:00 from 08:00 → same day 09:00', () => {
    expect(computeNextFireAt('daily@09:00', MON_08_00).toISOString()).toBe('2026-05-25T09:00:00.000Z');
  });
  it('daily@09:00 from 10:00 → next day 09:00', () => {
    expect(computeNextFireAt('daily@09:00', MON_10_00).toISOString()).toBe('2026-05-26T09:00:00.000Z');
  });
  it('daily@09:00 exactly AT 09:00 → next day (strictly after)', () => {
    const at0900 = new Date('2026-05-25T09:00:00Z');
    expect(computeNextFireAt('daily@09:00', at0900).toISOString()).toBe('2026-05-26T09:00:00.000Z');
  });
});

describe('computeNextFireAt — weekly', () => {
  it('weekly:mon@09:00 from Monday 08:00 → SAME Monday 09:00', () => {
    // from is Mon 08:00; the target Mon 09:00 is later today → today.
    expect(computeNextFireAt('weekly:mon@09:00', MON_08_00).toISOString()).toBe('2026-05-25T09:00:00.000Z');
  });
  it('weekly:mon@09:00 from Monday 10:00 → NEXT Monday 09:00', () => {
    // from is Mon 10:00; today's Mon 09:00 already passed → +7 days.
    expect(computeNextFireAt('weekly:mon@09:00', MON_10_00).toISOString()).toBe('2026-06-01T09:00:00.000Z');
  });
  it('weekly:wed@09:00 from Monday 08:00 → that Wednesday 09:00', () => {
    expect(computeNextFireAt('weekly:wed@09:00', MON_08_00).toISOString()).toBe('2026-05-27T09:00:00.000Z');
  });
  it('weekly:sun@09:00 from Monday 08:00 → the upcoming Sunday 09:00', () => {
    // 2026-05-25 is Mon; next Sunday is 2026-05-31.
    expect(computeNextFireAt('weekly:sun@09:00', MON_08_00).toISOString()).toBe('2026-05-31T09:00:00.000Z');
  });
});

describe('computeNextFireAt — invalid', () => {
  it('throws on a garbage cadence', () => {
    expect(() => computeNextFireAt('garbage', MON_08_00)).toThrow();
    expect(() => computeNextFireAt('every:0m', MON_08_00)).toThrow();
  });
});
