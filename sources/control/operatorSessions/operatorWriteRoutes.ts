/**
 * #97 Operator write endpoints — 4 control-plane POSTs driven by a human operator from CodeLight.
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
 * AUTH = simple writable bearer session (`op_sess_`, #96). NO Ed25519 / nonce (future hardening).
 *
 * Order is chosen for ANTI-ENUMERATION + no-leak:
 *   1. verifyOperatorSession  → 401 on missing/invalid/dev_ctl_/machine token. Runs BEFORE any action
 *      lookup, so an unauthenticated caller cannot probe action existence (401, not 404).
 *   2. client_idempotency_key → 400 if absent.
 *   3. resolve the action AND require it belongs to the session's workroom → 404 (uniform: action
 *      not found OR cross-workroom both return 404, never revealing cross-workroom existence). This
 *      is the ROUTE-layer workroom enforcement; the #88 helper re-checks workroom INSIDE the tx too
 *      (two-layer, both no-leak 404).
 *   4. executeOperatorCommand (#88) — atomic mutation + audit, with CAS on status inside the tx.
 *      It owns the command checks: V1-gate (approve/retry → 422 COMMAND_NOT_IN_V1) BEFORE
 *      command-scope (403), plus status guard (409). We deliberately do NOT pre-check command scope
 *      in the route so approve/retry surface as 422 (not-in-V1) rather than 403.
 */

import type { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { verifyOperatorSession } from './operatorSessionAuth.js';
import { executeOperatorCommand, type OperatorCommandKey } from './operatorCommandTransaction.js';

/** URL segment → command key. */
const ROUTE_COMMANDS: ReadonlyArray<readonly [string, OperatorCommandKey]> = [
  ['acknowledge', 'acknowledge_needs_human'],
  ['mark-reviewed', 'mark_reviewed'],
  ['approve', 'approve'],
  ['retry', 'retry'],
];

export async function operatorWriteRoutes(app: FastifyInstance): Promise<void> {
  for (const [segment, commandKey] of ROUTE_COMMANDS) {
    app.post(`/api/v1/actions/:id/${segment}`, async (request, reply) => {
      // 1. AUTH FIRST (anti-enumeration): op_sess_ only; dev_ctl_/machine/missing → 401.
      const session = await verifyOperatorSession(request.headers.authorization);
      if (!session) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      }

      // 2. Idempotency key required (helper's UNIQUE constraint is the dedupe backstop).
      const body = (request.body ?? {}) as { client_idempotency_key?: unknown };
      const idemKey = typeof body.client_idempotency_key === 'string' ? body.client_idempotency_key.trim() : '';
      if (!idemKey) {
        return reply.code(400).send({ error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'client_idempotency_key is required' } });
      }

      // 3. Resolve action + ROUTE-layer workroom enforcement (server-side; never trust client).
      //    Action not found OR not in this session's workroom → uniform 404 (no cross-workroom leak).
      const { id: actionId } = request.params as { id: string };
      let inScope = false;
      try {
        const action = await db.controlAction.findUnique({ where: { id: actionId }, select: { workroomId: true } });
        inScope = !!action && action.workroomId === session.workroomId;
      } catch {
        inScope = false; // malformed id → deny (uniform 404)
      }
      if (!inScope) {
        return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
      }

      // 4. Atomic mutation + audit (#88). Helper owns command V1-gate (422)/scope (403), status CAS
      //    (409), in-tx workroom re-check (404), and duplicate-idempotency (409).
      const result = await executeOperatorCommand({
        session: {
          sessionId: session.id,
          workroomId: session.workroomId,
          operatorSubjectId: session.operatorSubjectId,
          allowedCommands: session.allowedCommands,
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
