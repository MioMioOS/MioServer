/**
 * #179 (Track 4) — connection access + revoke endpoints.
 *
 * The connection credential (long-lived Keychain root) is exchanged here for SHORT-LIVED access
 * tokens, and revoked here (single kill switch). The credential itself is NEVER a data-plane bearer.
 *
 *   POST /api/v1/connections/access
 *     auth: Bearer connection_credential. Mints a short-lived read access token (dev_ctl_) and, iff
 *     the connection has operator scope, a short-lived operator access token (op_sess_). 401 if the
 *     connection is invalid/expired/revoked → iOS goes to needs_reconnect.
 *
 *   POST /api/v1/connections/:connectionId/revoke
 *     auth: Bearer connection_credential (SELF-revoke — phone "disconnect", must not depend on Mac)
 *           OR machine_token (Mac/daemon device management, org-scoped). Flips the kill switch;
 *     derived access dies within the access TTL. Uniform 404 on not-found/cross-org (anti-enumeration).
 *
 * SECURITY: access tokens are short-lived internal credentials — never surfaced in UI/logs (PM
 * decision). Operator access is minted ONLY when 'operator' ∈ connection.scopes (no escalation).
 */
import { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { mintOperatorSession, OperatorSessionMintError } from '@/control/operatorSessions/operatorSessionMint';
import { mintDevControlToken } from '@/control/devTokens/mintDevToken';
import { verifyConnectionCredential, revokeConnectionCredential } from './connectionCredential';

/** Derived access TTLs (hours) — short by design; revoke bounds exposure to this window. */
const READ_ACCESS_TTL_HOURS = 1;
const OPERATOR_ACCESS_TTL_HOURS = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

export async function connectionRoutes(app: FastifyInstance) {
  /** Exchange the connection credential for short-lived read (+ operator) access tokens. */
  app.post('/api/v1/connections/access', async (request, reply) => {
    const conn = await verifyConnectionCredential(request.headers.authorization);
    if (!conn) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired connection' } });
    }

    // Read access is always minted (read is the base scope).
    let read;
    try {
      read = await mintDevControlToken({ orgId: conn.orgId, workroomId: conn.workroomId, ttlHours: READ_ACCESS_TTL_HOURS });
    } catch {
      // Workroom/org drift (e.g. workroom deleted) → connection no longer usable.
      return reply.code(422).send({ error: { code: 'ACCESS_MINT_FAILED', message: 'Could not mint access' } });
    }

    const resp: Record<string, unknown> = {
      read_access_token: read.rawToken,
      read_expires_at: read.expiresAt.toISOString(),
    };

    // Operator access ONLY when granted (no silent escalation). A failure here degrades to read-only
    // rather than failing the whole exchange (read should still work).
    if (conn.scopes.includes('operator') && conn.operatorSubjectId) {
      try {
        const op = await mintOperatorSession({
          orgId: conn.orgId,
          workroomId: conn.workroomId,
          operatorSubjectId: conn.operatorSubjectId,
          issuedBy: `connection:${conn.connectionId}`,
          allowedCommands: conn.allowedCommands.length > 0 ? conn.allowedCommands : undefined,
          ttlHours: OPERATOR_ACCESS_TTL_HOURS,
        });
        resp.operator_access_token = op.rawToken;
        resp.operator_expires_at = op.expiresAt.toISOString();
        resp.allowed_commands = op.allowedCommands;
      } catch (err) {
        if (!(err instanceof OperatorSessionMintError)) throw err;
        // degrade to read-only access (operator omitted) — never surface provider/mint detail
      }
    }

    await db.controlConnectionCredential.update({
      where: { id: conn.connectionId },
      data: { lastRefreshAt: new Date() },
    });

    return reply.code(200).send(resp);
  });

  /** Revoke a connection (kill switch). Self via connection credential, or machine_token (org-scoped). */
  app.post('/api/v1/connections/:connectionId/revoke', async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };
    const notFound = () => reply.code(404).send({ error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found' } });
    if (!isUuid(connectionId)) return notFound();

    const authHeader = request.headers.authorization;

    // Path 1: SELF-revoke via the connection credential (phone disconnect; no Mac dependency).
    const conn = await verifyConnectionCredential(authHeader);
    if (conn) {
      // Can only self-revoke OWN connection.
      if (conn.connectionId !== connectionId) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Cannot revoke another connection' } });
      }
      await revokeConnectionCredential(connectionId);
      return reply.code(200).send({ connection_id: connectionId, revoked: true });
    }

    // Path 2: machine_token (Mac/daemon device management) — org-scoped.
    const machine = await verifyMachineToken(authHeader);
    if (machine) {
      if (!machine.orgId) return reply.code(409).send({ error: { code: 'MACHINE_NOT_BOUND', message: 'Machine is not bound to an org' } });
      const rec = await db.controlConnectionCredential.findUnique({ where: { id: connectionId }, select: { orgId: true } });
      // No-leak: not-found OR cross-org → uniform 404.
      if (!rec || rec.orgId !== machine.orgId) return notFound();
      await revokeConnectionCredential(connectionId);
      return reply.code(200).send({ connection_id: connectionId, revoked: true });
    }

    return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  });
}
