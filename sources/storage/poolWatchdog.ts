/**
 * poolWatchdog — detects a wedged Prisma connection pool, captures the crime
 * scene, and (optionally) self-heals with a clean process exit.
 *
 * WHY: prod has repeatedly hit "Timed out fetching a new connection from the
 * connection pool" (25,935 occurrences in the error log by 2026-06-12). Each
 * incident degraded everything at once — machine heartbeats failed (agents
 * flapped offline), message sends 500'd, monitoring reads died — and because
 * the logs had no timestamps and nothing captured pg_stat_activity at incident
 * time, every "fix" so far was a guess. This watchdog ends the guessing:
 *
 *   1. PROBE  — every PROBE_INTERVAL_MS, run `SELECT 1` through the MAIN pool
 *               with a hard deadline. A healthy pool answers in microseconds;
 *               a timeout means all connections are pinned (the exact failure
 *               users experience).
 *   2. CAPTURE — on probe failure, query pg_stat_activity through a DEDICATED
 *               1-connection diagnostic client (reserved at boot, so it works
 *               even when the main pool is fully wedged) and log every busy
 *               backend: state, wait_event, xact age, blocking PIDs, query.
 *               The blocker that has been holding things up is named in the log.
 *   3. SELF-HEAL — after EXIT_AFTER_CONSECUTIVE consecutive failures (≈45s of
 *               hard outage) exit(1) so pm2 restarts us with a fresh pool.
 *               A 5-second blip beats a multi-hour wedge. Disable with
 *               POOL_WATCHDOG_EXIT=false (capture-only mode).
 */

import { PrismaClient } from '@prisma/client';
import { db } from './db';

const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;
const EXIT_AFTER_CONSECUTIVE = 3;

interface ActivityRow {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  xact_age: string | null;
  query_age: string | null;
  blocked_by: number[] | null;
  query: string | null;
}

let diagClient: PrismaClient | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;

function diagUrl(): string | null {
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  // Reserve exactly ONE connection for diagnostics, independent of the main pool.
  const sep = base.includes('?') ? '&' : '?';
  return `${base.split('?')[0]}${sep}connection_limit=1&pool_timeout=10`.replace('?&', '?');
}

async function probeMainPool(): Promise<boolean> {
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function captureCrimeScene(): Promise<void> {
  if (!diagClient) return;
  try {
    const rows = await diagClient.$queryRaw<ActivityRow[]>`
      SELECT a.pid,
             a.state,
             a.wait_event_type,
             a.wait_event,
             (now() - a.xact_start)::text  AS xact_age,
             (now() - a.query_start)::text AS query_age,
             pg_blocking_pids(a.pid)       AS blocked_by,
             left(a.query, 300)            AS query
      FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND (a.state <> 'idle' OR a.xact_start IS NOT NULL)
      ORDER BY a.xact_start NULLS LAST
    `;
    console.error(
      `[poolWatchdog] POOL WEDGED (${consecutiveFailures} consecutive probe failures). ` +
        `${rows.length} busy backend(s):`,
    );
    for (const r of rows) {
      const blockedBy = r.blocked_by && r.blocked_by.length ? ` BLOCKED_BY=${r.blocked_by.join(',')}` : '';
      console.error(
        `[poolWatchdog]   pid=${r.pid} state=${r.state} wait=${r.wait_event_type ?? '-'}/${r.wait_event ?? '-'} ` +
          `xact_age=${r.xact_age ?? '-'} query_age=${r.query_age ?? '-'}${blockedBy} query=${r.query ?? '-'}`,
      );
    }
  } catch (err) {
    console.error('[poolWatchdog] crime-scene capture failed:', (err as Error)?.message);
  }
}

/** Start the watchdog. Call once at boot, after db.$connect(). */
export function startPoolWatchdog(): void {
  const url = diagUrl();
  if (!url) {
    console.error('[poolWatchdog] DATABASE_URL missing — watchdog disabled');
    return;
  }
  diagClient = new PrismaClient({ datasources: { db: { url } } });

  timer = setInterval(async () => {
    const healthy = await probeMainPool();
    if (healthy) {
      if (consecutiveFailures > 0) {
        console.error(`[poolWatchdog] pool recovered after ${consecutiveFailures} failed probe(s)`);
      }
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures += 1;
    await captureCrimeScene();
    const exitEnabled = process.env.POOL_WATCHDOG_EXIT !== 'false';
    if (consecutiveFailures >= EXIT_AFTER_CONSECUTIVE && exitEnabled) {
      console.error(
        `[poolWatchdog] pool wedged for ${consecutiveFailures} consecutive probes ` +
          `(~${(consecutiveFailures * PROBE_INTERVAL_MS) / 1000}s) — exiting for a clean pm2 restart`,
      );
      process.exit(1);
    }
  }, PROBE_INTERVAL_MS);
  // Never keep the process alive just for the watchdog.
  timer.unref?.();
  console.log(
    `[poolWatchdog] armed (probe every ${PROBE_INTERVAL_MS / 1000}s, ` +
      `self-heal exit ${process.env.POOL_WATCHDOG_EXIT !== 'false' ? 'ON' : 'OFF'} ` +
      `after ${EXIT_AFTER_CONSECUTIVE} failures)`,
  );
}

/** Stop the watchdog and release the diagnostic connection (tests/shutdown). */
export async function stopPoolWatchdog(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  consecutiveFailures = 0;
  if (diagClient) { await diagClient.$disconnect().catch(() => {}); diagClient = null; }
}
