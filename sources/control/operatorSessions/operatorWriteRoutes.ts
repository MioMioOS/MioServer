/**
 * Operator write endpoints — 4 control-plane POSTs driven by an iOS/CodeLight operator
 * OR a daemon machine token. Originally #97 (op_sess_ only); converted in Slice 7 B2-e
 * to the unified user_sess_ / machine_token auth model. The wire shape (URL + body) is
 * unchanged.
 *
 *   POST /api/v1/actions/:id/acknowledge     → acknowledge_needs_human
 *   POST /api/v1/actions/:id/mark-reviewed   → mark_reviewed
 *   POST /api/v1/actions/:id/approve         → approve   (V1: helper returns 422 COMMAND_NOT_IN_V1)
 *   POST /api/v1/actions/:id/retry           → retry     (V1: helper returns 422 COMMAND_NOT_IN_V1)
 *
 * These change CONTROL-PLANE state only (operator ack/review timestamps) + write an audit row +
 * publish an event the daemon picks up. They never touch a secret (server is secret-blind;
 * local Claude/Codex auth lives on the user's machine).
 *
 * AUTH (Slice 7 B2-e):
 *   - user_sess_  → must be a workroom OWNER. Membership absent → uniform 404 (anti-enum,
 *                   derived-workroom). Non-owner member → 403.
 *   - machine_token → must be org-scoped to the action's workroom. Cross-org / no-org →
 *                     uniform 404 (anti-enum, derived-workroom).
 *   - missing / unknown → 401 BEFORE any action lookup (anti-enum: an unauth caller never
 *                         learns whether an action id exists).
 *
 * The granular operator-session `allowedCommands` gate is gone; replaced by:
 *   - role gate (owner) on the user path,
 *   - the helper's V1-gate (approve/retry → 422) which still runs unconditionally.
 *
 * Order (preserves anti-enumeration from the #97 doc + adds the derived-workroom 404):
 *   1. Auth class + token validity → 401 on missing/invalid. No action lookup yet.
 *   2. client_idempotency_key → 400 if absent.
 *   3. Load action; if missing → 404 ACTION_NOT_FOUND.
 *   4. Workroom scope:
 *        user_sess_   → UserWorkroomMembership lookup; absent → 404 (derived-workroom).
 *                       Present + role !== 'owner' → 403.
 *        machine_token → requireMachineAccessToWorkroom; cross-org → 404 (derived-workroom).
 *   5. executeOperatorCommand — atomic mutation + audit, status CAS in-tx, V1-gate (422),
 *      duplicate-idempotency (409), in-tx workroom re-check (404). We hand it a synthetic
 *      VerifiedOperatorSession with the full V1 command set so the helper's allowedCommands
 *      gate never short-circuits; the role gate above is the user-side replacement.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';
import { executeOperatorCommand, type OperatorCommandKey } from './operatorCommandTransaction.js';

/** URL segment → command key. */
const ROUTE_COMMANDS: ReadonlyArray<readonly [string, OperatorCommandKey]> = [
  ['acknowledge', 'acknowledge_needs_human'],
  ['mark-reviewed', 'mark_reviewed'],
  ['approve', 'approve'],
  ['retry', 'retry'],
];

/**
 * Full V1+V2 command set passed to the helper. The role gate (user_sess_ owner) and the
 * helper's V1-gate (approve/retry → 422) together replace the legacy allowedCommands
 * granularity. We synthesise the full set so the helper's COMMAND_NOT_ALLOWED 403 branch
 * is unreachable here — leaving V1-gate (422) and status CAS (409) as the only post-auth
 * failure modes.
 */
const ALL_COMMANDS: OperatorCommandKey[] = ['acknowledge_needs_human', 'mark_reviewed', 'approve', 'retry'];

type SubjectResolution =
  | { ok: true; subjectId: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * Auth + derived-workroom scope check for operator writes.
 *
 * action workroomId is already loaded — this resolves the subject (user or machine) against
 * that workroom. Failure modes follow the derived-workroom anti-enum contract.
 */
async function resolveWriteSubject(
  req: FastifyRequest,
  actionWorkroomId: string,
): Promise<SubjectResolution> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
  }
  const token = authHeader.slice(7);

  // ── Path 1: user_sess_ ──
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    const session = await resolveUserSession(authHeader);
    if (!session) {
      return { ok: false, status: 401, code: 'INVALID_SESSION', message: 'Invalid or expired session' };
    }
    const mem = await db.userWorkroomMembership.findUnique({
      where: { userId_workroomId: { userId: session.userId, workroomId: actionWorkroomId } },
    });
    if (!mem) {
      // Derived-workroom: non-member → 404 ACTION_NOT_FOUND (uniform with cross-org machine).
      return { ok: false, status: 404, code: 'ACTION_NOT_FOUND', message: 'Action not found' };
    }
    if (mem.role !== 'owner') {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' };
    }
    return { ok: true, subjectId: session.userId };
  }

  // ── Path 2: machine_token ──
  const machine = await verifyMachineToken(authHeader);
  if (!machine) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'Invalid or expired token' };
  }
  const access = await requireMachineAccessToWorkroom(machine, actionWorkroomId);
  if (!access.ok) {
    // Derived-workroom: cross-org / no-org → 404 (uniform with user non-member).
    return { ok: false, status: 404, code: 'ACTION_NOT_FOUND', message: 'Action not found' };
  }
  return { ok: true, subjectId: machine.id };
}

/**
 * Token-class pre-check for the "auth before action lookup" anti-enumeration step. Returns
 * 401 if neither path validates BEFORE we touch the action table; otherwise the per-action
 * workroom check runs via resolveWriteSubject after the action row is loaded.
 *
 * We deliberately do NOT cache the resolved user/machine here — we re-run the verification
 * inside resolveWriteSubject (now that we know the workroom) to keep the membership/role
 * gate co-located with its own short-circuit. The extra hash lookup is sub-ms and the
 * clarity is worth more than the duplication.
 */
async function authClassValid(req: FastifyRequest): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  if (token.startsWith(USER_SESSION_TOKEN_PREFIX)) {
    return !!(await resolveUserSession(authHeader));
  }
  return !!(await verifyMachineToken(authHeader));
}

export async function operatorWriteRoutes(app: FastifyInstance): Promise<void> {
  for (const [segment, commandKey] of ROUTE_COMMANDS) {
    app.post(`/api/v1/actions/:id/${segment}`, async (request, reply) => {
      // 1. AUTH FIRST (anti-enumeration): missing/invalid → 401 BEFORE any action lookup.
      if (!(await authClassValid(request))) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }

      // 2. Idempotency key required (helper's UNIQUE constraint is the dedupe backstop).
      const body = (request.body ?? {}) as { client_idempotency_key?: unknown };
      const idemKey = typeof body.client_idempotency_key === 'string' ? body.client_idempotency_key.trim() : '';
      if (!idemKey) {
        return reply.code(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'client_idempotency_key is required' } });
      }

      // 3. Resolve action (uniform 404 on missing OR malformed id).
      const { id: actionId } = request.params as { id: string };
      let action: { workroomId: string } | null = null;
      try {
        action = await db.controlAction.findUnique({ where: { id: actionId }, select: { workroomId: true } });
      } catch {
        return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
      }
      if (!action) {
        return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
      }

      // 4. Derived-workroom scope + role gate.
      const subject = await resolveWriteSubject(request, action.workroomId);
      if (!subject.ok) {
        return reply.code(subject.status).send({ error: { code: subject.code, message: subject.message } });
      }

      // 5. Atomic mutation + audit (#88). Helper still owns V1-gate (422), status CAS (409),
      // in-tx workroom re-check (404), and duplicate-idempotency (409). We synthesise a
      // VerifiedOperatorSession carrying the full command set — auth has already gated
      // user owner / machine org access; the helper's allowedCommands branch is unused.
      const result = await executeOperatorCommand({
        session: {
          // Audit-log sessionId column has no FK — a per-request UUID is acceptable.
          // Actor identity lives on operatorSubjectId (user.id or machine.id).
          sessionId: randomUUID(),
          workroomId: action.workroomId,
          operatorSubjectId: subject.subjectId,
          allowedCommands: ALL_COMMANDS,
        },
        actionId,
        commandKey,
        clientIdempotencyKey: idemKey,
      });

      if (result.ok) {
        return reply.code(200).send({ ok: true, action_id: actionId, command: commandKey });
      }
      // Controlled error: code + httpStatus from the helper; no internal detail / no secret.
      return reply.code(result.httpStatus).send({ error: { code: result.code, message: 'Operator command not applied' } });
    });
  }
}
