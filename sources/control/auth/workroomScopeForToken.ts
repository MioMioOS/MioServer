/**
 * workroomScopeForToken — generic WS subscribe workroom-scope helper.
 *
 * Given an opaque `token` string (Bearer prefix NOT required — raw token value)
 * and a target `workroomId`, tries the three recognised token classes in order
 * and returns the first one that both validates AND is scoped to the workroom:
 *
 *   1. machine_token   — verifyMachineToken + requireMachineAccessToWorkroom
 *   2. dev_ctl_ token  — verifyDevControlToken + token.workroomId === workroomId
 *   3. op_sess_ token  — verifyOperatorSession + session.workroomId === workroomId
 *
 * Returns:
 *   { ok: true, mode: 'machine' | 'dev' | 'operator' }  — authorised
 *   null                                                  — not authorised (any failure)
 *
 * Callers MUST treat null as a hard rejection (error + disconnect).
 * This function performs NO DB writes; it is a pure auth check.
 *
 * NOTE: token is passed as a raw string WITHOUT a "Bearer " prefix because WS
 * subscribe messages carry a plain token field (not an HTTP Authorization header).
 * Each verifier receives "Bearer <token>" to satisfy the existing header-format
 * expectations of verifyMachineToken / verifyDevControlToken / verifyOperatorSession.
 */

import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { verifyDevControlToken } from '@/control/devTokens/devTokenAuth';
import { verifyOperatorSession } from '@/control/operatorSessions/operatorSessionAuth';

export type WorkroomScopeMode = 'machine' | 'dev' | 'operator';

export interface WorkroomScopeOk {
  ok: true;
  mode: WorkroomScopeMode;
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

  // ── 1. machine_token ─────────────────────────────────────────────────────
  const machine = await verifyMachineToken(bearerHeader);
  if (machine) {
    const access = await requireMachineAccessToWorkroom(machine, workroomId);
    if (access.ok) return { ok: true, mode: 'machine' };
    // machine token valid but not scoped to this workroom → null (reject)
    return null;
  }

  // ── 2. dev_ctl_ token ────────────────────────────────────────────────────
  const devToken = await verifyDevControlToken(bearerHeader);
  if (devToken) {
    if (devToken.workroomId === workroomId) return { ok: true, mode: 'dev' };
    // dev token valid but scoped to a different workroom → null (reject)
    return null;
  }

  // ── 3. op_sess_ token ────────────────────────────────────────────────────
  const session = await verifyOperatorSession(bearerHeader);
  if (session) {
    if (session.workroomId === workroomId) return { ok: true, mode: 'operator' };
    // session valid but scoped to a different workroom → null (reject)
    return null;
  }

  // None of the three token classes matched → reject.
  return null;
}
