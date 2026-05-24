/**
 * S3 Slock Task status translation at the API boundary.
 *
 * The server keeps its own stored status vocabulary; the Slock iOS API speaks an
 * UPPERCASE vocabulary. We translate at the edge so neither side leaks the other's
 * vocab.
 *
 *   iOS → server: TODO→todo, IN_PROGRESS→in_progress, IN_REVIEW→in_review,
 *                 DONE→done, CLOSED→canceled.
 *   server → iOS: todo→TODO, in_progress→IN_PROGRESS, in_review→IN_REVIEW,
 *                 done→DONE, canceled→CLOSED, waiting_approval→IN_REVIEW.
 *
 * waiting_approval is a server-only state with no iOS counterpart → it surfaces as
 * IN_REVIEW. It is NOT a valid inbound value (slockToServerStatus has no key for it).
 */

/** Slock (iOS) task status vocabulary. */
export type SlockTaskStatus = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CLOSED';

const SLOCK_TO_SERVER: Record<SlockTaskStatus, string> = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  IN_REVIEW: 'in_review',
  DONE: 'done',
  CLOSED: 'canceled',
};

const SERVER_TO_SLOCK: Record<string, SlockTaskStatus> = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  in_review: 'IN_REVIEW',
  done: 'DONE',
  canceled: 'CLOSED',
  waiting_approval: 'IN_REVIEW', // server-only state → surfaces as IN_REVIEW to iOS
};

/**
 * Translate a Slock (iOS) status to the server's stored status.
 * Returns null for any value not in the iOS vocab (caller → 400).
 */
export function slockToServerStatus(status: string): string | null {
  return SLOCK_TO_SERVER[status as SlockTaskStatus] ?? null;
}

/**
 * Translate a server status to the Slock (iOS) status.
 * Unknown server statuses fall back to TODO so the wire shape never breaks
 * (defensive — every current server status is mapped explicitly above).
 */
export function serverToSlockStatus(status: string): SlockTaskStatus {
  return SERVER_TO_SLOCK[status] ?? 'TODO';
}
