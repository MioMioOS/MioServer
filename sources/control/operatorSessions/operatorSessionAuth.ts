/**
 * Operator session WRITE auth (#96) — SIMPLE bearer, no signing / no nonce.
 *
 * V1 product is single-user controlling their OWN agents (phone CodeLight → server → own daemon),
 * over HTTPS. So operator write authorization is a plain bearer check on the `op_sess_` token
 * (a separate credential class from the read-only `dev_ctl_`): exists + not expired + not revoked +
 * command in the session's allow-list + workroom in scope. Ed25519 request-signing / nonce
 * anti-replay are deliberately NOT used here (future hardening only — see
 * docs/operator-session-signing-keymaterial-decision.md).
 *
 * SECURITY:
 *   - only sha256(token) is stored (mint side, #86); raw token never persisted.
 *   - `dev_ctl_` (read-only) can NEVER authorize a write: it's a different token class in a
 *     different table, and the op_sess_ prefix check + table lookup both exclude it.
 *   - command allow-list is fail-closed: a command not in session.allowedCommands is denied.
 *   - any failure → caller returns a uniform 401/403 (no expired-vs-revoked-vs-scope distinction).
 */

import type { FastifyRequest } from 'fastify';
import { createHash } from 'crypto';
import { db } from '@/storage/db';
import { OPERATOR_SESSION_TOKEN_PREFIX } from './operatorSessionMint.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OperatorSessionContext {
  id: string;
  orgId: string;
  workroomId: string;
  allowedCommands: string[];
  operatorSubjectId: string;
}

/**
 * Verify a Bearer `op_sess_` token. Returns the session context if valid (exists + not expired +
 * not revoked), else null. Mirrors verifyDevControlToken's hash-lookup (sha256, never store raw).
 * Only matches `op_sess_` tokens — a `dev_ctl_` (read-only) token returns null (cannot write).
 */
export async function verifyOperatorSession(
  authHeader: string | undefined,
): Promise<OperatorSessionContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  if (!token || !token.startsWith(OPERATOR_SESSION_TOKEN_PREFIX)) return null;
  const hash = hashToken(token);

  const rec = await db.controlOperatorSession.findFirst({
    where: { tokenHash: hash, expiresAt: { gt: new Date() }, revokedAt: null },
  });
  if (!rec) return null;
  return {
    id: rec.id,
    orgId: rec.orgId,
    workroomId: rec.workroomId,
    allowedCommands: rec.allowedCommands,
    operatorSubjectId: rec.operatorSubjectId,
  };
}

/** True iff this session may run `command` against `workroomId` (scope + command allow-list). */
export function operatorSessionAllows(
  session: OperatorSessionContext,
  command: string,
  workroomId: string,
): boolean {
  return session.workroomId === workroomId && session.allowedCommands.includes(command);
}

/** Result of authorizing an operator write request. */
export type OperatorWriteAuth =
  | { ok: true; session: OperatorSessionContext }
  | { ok: false; status: number; code: string; message: string };

/**
 * Authorize an operator WRITE request for a specific command + target workroom.
 *
 * Operator-write endpoints are `op_sess_`-ONLY: machine_token (daemon) and dev_ctl_ (read-only)
 * are both rejected here. Any failure (no/invalid token, command not allowed, wrong workroom)
 * returns a uniform 401/403 — no detail leak.
 *
 *   - missing/invalid op_sess_ token         → 401
 *   - valid token but command/workroom denied → 403
 *
 * Note: `dev_ctl_` is hard-rejected as a write credential. A machine_token is also NOT an operator;
 * if a machine_token is presented to a write endpoint it is treated as not-an-operator → 401.
 */
export async function authorizeOperatorWrite(
  request: FastifyRequest,
  opts: { command: string; workroomId: string },
): Promise<OperatorWriteAuth> {
  const authHeader = request.headers.authorization;

  // Defense-in-depth: explicitly reject a dev_ctl_ read token on write endpoints, even though it
  // also fails the op_sess_ lookup below (it's a different token class).
  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (rawToken.startsWith('dev_ctl_')) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
  }

  const session = await verifyOperatorSession(authHeader);
  if (!session) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
  }
  if (!operatorSessionAllows(session, opts.command, opts.workroomId)) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
  }
  return { ok: true, session };
}
