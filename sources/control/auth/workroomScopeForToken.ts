/**
 * workroomScopeForToken — generic WS subscribe workroom-scope helper.
 *
 * Given an opaque `token` string (Bearer prefix NOT required — raw token value)
 * and a target `workroomId`, tries the recognised token classes in order and
 * returns the first one that both validates AND is scoped to the workroom:
 *
 *   1. user_sess_ token  — resolveUserSession + UserWorkroomMembership row required
 *                          (Slice 7 B2-e: iOS sends user_sess_ in the same `token`
 *                          field — wire protocol unchanged.)
 *   2. machine_token     — verifyMachineToken + requireMachineAccessToWorkroom
 *
 * (Slice 7 B3 removed the legacy dev_ctl_ and op_sess_ branches: those token
 * classes are no longer minted by any LIVE route, and no consumer accepts them
 * post-B3.)
 *
 * Returns:
 *   { ok: true, mode: 'machine' | 'user' }  — authorised
 *   null                                     — not authorised (any failure)
 *
 * Callers MUST treat null as a hard rejection (error + disconnect).
 * This function performs NO DB writes; it is a pure auth check.
 *
 * NOTE: token is passed as a raw string WITHOUT a "Bearer " prefix because WS
 * subscribe messages carry a plain token field (not an HTTP Authorization header).
 * Each verifier receives "Bearer <token>" to satisfy the existing header-format
 * expectations of verifyMachineToken / resolveUserSession.
 */

import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { db } from '@/storage/db';

export type WorkroomScopeMode = 'machine' | 'user';

export interface WorkroomScopeOk {
  ok: true;
  mode: WorkroomScopeMode;
  /** Viewer identity for per-subscriber channel-visibility filtering:
   *  User.id (cuid) when mode='user', ControlMachine.id (uuid) when mode='machine'. */
  viewerId: string;
}

/**
 * Determine whether `token` (raw, no Bearer prefix) grants access to `workroomId`.
 *
 * @returns WorkroomScopeOk on success, null on any failure (invalid, expired,
 *          wrong workroom, unknown token class).
 */
export async function tokenInWorkroom(
  token: string,
  workroomId: string,
): Promise<WorkroomScopeOk | null> {
  const bearerHeader = `Bearer ${token}`;

  // ── 1. user_sess_ — Slice 7 B2-e ─────────────────────────────────────────
  // Prefix-dispatched so the machine verifier doesn't burn a DB lookup on a
  // user_sess_ token that it would reject anyway.
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(bearerHeader);
    if (!session) return null;
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId } },
    });
    if (!mem) return null;
    return { ok: true, mode: 'user', viewerId: session.userId };
  }

  // ── 2. machine_token ─────────────────────────────────────────────────────
  const machine = await verifyMachineToken(bearerHeader);
  if (machine) {
    const access = await requireMachineAccessToWorkroom(machine, workroomId);
    if (access.ok) return { ok: true, mode: 'machine', viewerId: machine.id };
    // machine token valid but not scoped to this workroom → null (reject)
    return null;
  }

  // Neither token class matched → reject.
  return null;
}
