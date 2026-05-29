/**
 * reminderCadence.ts — cadence grammar parser + next-fire computation (Slice 4.1, Chunk F).
 *
 * A reminder's `cadence` string (null = one-shot) encodes a RECURRENCE rule. When a
 * recurring reminder fires, the server reschedules it by computing the NEXT fireAt
 * from this rule (see agentApiReminders fire endpoint).
 *
 * ── Grammar (ALL TIMES UTC) ──────────────────────────────────────────────────
 *   every:<int><unit>        unit ∈ s|m|h|d (seconds/minutes/hours/days), int > 0
 *                            → next = from + int * unit
 *                            e.g. every:30s, every:15m, every:2h, every:1d
 *                            (seconds exist mainly so the acceptance harness can prove
 *                            ≥2 natural fires in a bounded window; m|h|d are the normal use)
 *   daily@HH:MM              → the next HH:MM (UTC) strictly AFTER `from`
 *                            (today if HH:MM is later today, else tomorrow)
 *   weekly:<dow>@HH:MM       dow ∈ mon|tue|wed|thu|fri|sat|sun (lowercase)
 *                            → the next occurrence of that weekday at HH:MM UTC
 *                            strictly AFTER `from`
 *
 * Invalid rules throw a clear Error (the schedule/update routes map it to a 400
 * INVALID_CADENCE). All math uses Date UTC methods (getUTCHours etc.) so the result
 * is deterministic regardless of the host's local timezone.
 */

// ── Parsed shape ───────────────────────────────────────────────────────────────

export type ParsedCadence =
  | { kind: 'every'; ms: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; dow: number; hour: number; minute: number }; // dow: 0=Sun … 6=Sat (JS getUTCDay)

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// dow token → JS getUTCDay() index (Sunday = 0).
const DOW_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DAY_MS = 86_400_000;

/** Validate HH:MM (UTC) components; throw on out-of-range. */
function parseHourMinute(rule: string, hh: string, mm: string): { hour: number; minute: number } {
  const hour = Number(hh);
  const minute = Number(mm);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Invalid cadence "${rule}": hour must be 00-23`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`Invalid cadence "${rule}": minute must be 00-59`);
  }
  return { hour, minute };
}

/**
 * Parse a cadence rule string into a structured form. Throws a clear Error on any
 * malformed/invalid rule.
 */
export function parseCadence(rule: string): ParsedCadence {
  if (typeof rule !== 'string') {
    throw new Error('Invalid cadence: must be a string');
  }
  const trimmed = rule.trim();
  if (trimmed === '') {
    throw new Error('Invalid cadence: empty rule');
  }

  // every:<int><unit>
  const everyMatch = /^every:(\d+)(s|m|h|d)$/.exec(trimmed);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const unit = everyMatch[2];
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid cadence "${rule}": interval must be a positive integer`);
    }
    return { kind: 'every', ms: n * UNIT_MS[unit] };
  }

  // daily@HH:MM
  const dailyMatch = /^daily@(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (dailyMatch) {
    const { hour, minute } = parseHourMinute(rule, dailyMatch[1], dailyMatch[2]);
    return { kind: 'daily', hour, minute };
  }

  // weekly:<dow>@HH:MM
  const weeklyMatch = /^weekly:([a-z]{3})@(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (weeklyMatch) {
    const dowToken = weeklyMatch[1];
    if (!(dowToken in DOW_INDEX)) {
      throw new Error(`Invalid cadence "${rule}": day-of-week must be one of mon|tue|wed|thu|fri|sat|sun`);
    }
    const { hour, minute } = parseHourMinute(rule, weeklyMatch[2], weeklyMatch[3]);
    return { kind: 'weekly', dow: DOW_INDEX[dowToken], hour, minute };
  }

  throw new Error(
    `Invalid cadence "${rule}": expected every:<int>(m|h|d), daily@HH:MM, or weekly:<dow>@HH:MM`,
  );
}

/**
 * Compute the next fireAt (UTC-deterministic) for a cadence rule, strictly after `from`.
 *
 *   every:<int><unit> → from + N*unit (drift-from-now is intended: each reschedule
 *                       anchors off the ACTUAL fire time, matching skip-backlog).
 *   daily@HH:MM       → the next HH:MM UTC strictly after `from`.
 *   weekly:<dow>@HH:MM→ the next occurrence of that weekday at HH:MM UTC strictly after `from`.
 *
 * Throws on an invalid rule (delegates to parseCadence).
 */
export function computeNextFireAt(cadence: string, from: Date): Date {
  const parsed = parseCadence(cadence);

  if (parsed.kind === 'every') {
    return new Date(from.getTime() + parsed.ms);
  }

  // daily / weekly: build today's candidate at the target HH:MM:00.000 UTC.
  const candidate = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      parsed.hour,
      parsed.minute,
      0,
      0,
    ),
  );

  if (parsed.kind === 'daily') {
    // If today's HH:MM is not strictly after `from`, roll to tomorrow.
    if (candidate.getTime() <= from.getTime()) {
      return new Date(candidate.getTime() + DAY_MS);
    }
    return candidate;
  }

  // weekly: advance to the target day-of-week, strictly after `from`.
  // Days to add to reach the target dow (0..6).
  const fromDow = from.getUTCDay();
  let dayDelta = (parsed.dow - fromDow + 7) % 7;
  let target = new Date(candidate.getTime() + dayDelta * DAY_MS);
  // If that lands on (or before) `from` — e.g. it IS today/this-instant or earlier —
  // push to the same weekday next week.
  if (target.getTime() <= from.getTime()) {
    target = new Date(target.getTime() + 7 * DAY_MS);
  }
  return target;
}
