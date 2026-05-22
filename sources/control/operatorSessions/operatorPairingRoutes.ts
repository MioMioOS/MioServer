/**
 * #153 — Mac→phone operator-session onboarding via OPAQUE pairing (the #151 model).
 *
 * Flow:
 *   1. Mac/daemon (machine_token) POSTs to create a pairing → server stores ONLY the pairing INTENT
 *      + sha256(opaque code), returns an OPAQUE payload (pairing_id, code, host, workroom display,
 *      scope label, TTL). The raw `op_sess_` is NEVER generated/stored here (mint-at-redeem) and the
 *      Mac never receives it — it only renders the opaque code as a QR / short code.
 *   2. Phone POSTs the opaque code to redeem (NO bearer auth — the code IS the one-time credential).
 *      Atomic CAS consume → mint a scoped `op_sess_` (via mintOperatorSession) → return it ONCE.
 *      Phone stores the raw token in Keychain only.
 *   3. Cancel/regenerate via DELETE (machine_token).
 *
 * SECURITY:
 *   - mint-at-redeem: nothing reversible is stored (only sha256(code) + intent), consistent with
 *     dev_ctl_ / op_sess_ / action_token.
 *   - redeem failures (expired / already-used / canceled / unknown / malformed) → UNIFORM
 *     403 PAIRING_NOT_REDEEMABLE (anti-enumeration).
 *   - create reuses the #140 machine_token ladder: 401 → 403 (token≠:id) → 409 (unbound) → 404
 *     (workroom not found OR cross-org, uniform).
 *   - The opaque `code` and raw `op_sess_` MUST NOT be logged. Only the code's sha256 hash is stored.
 *
 * HTTP paths use `/api/v1/.../pairings` (plural). This does NOT collide with the legacy device
 * pairing routes, which live under `/v1/pairing/...` (singular, no `/api` prefix).
 */
import { FastifyInstance } from 'fastify';
import { randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import {
  mintOperatorSession,
  OperatorSessionMintError,
  OPERATOR_SESSION_DEFAULT_TTL_HOURS,
  OPERATOR_SESSION_MAX_TTL_HOURS,
  V1_OPERATOR_COMMANDS,
} from '@/control/operatorSessions/operatorSessionMint';

const PAIRING_CODE_TTL_DEFAULT_S = 600;  // pairing code valid 10 min before redeem
const PAIRING_CODE_TTL_MAX_S = 3600;     // hard cap 1 hour
const SCOPE_LABEL_V1 = 'Review actions only';

/** 144-bit opaque pairing code (base64url ~24 chars). Encoded in the QR; manual entry possible. */
function generatePairingCode(): string {
  return randomBytes(18).toString('base64url');
}
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

export async function operatorPairingRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/machines/:id/operator-pairings  (machine_token)
   * Create a one-time opaque pairing. Returns opaque metadata ONLY — never a raw token.
   */
  app.post('/api/v1/machines/:id/pairings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { workroom_id?: string; ttl_seconds?: number; op_sess_ttl_hours?: number };

    // Auth ladder identical to #140.
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    if (machine.id !== id) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Token does not match machine id' } });
    if (!machine.orgId) return reply.code(409).send({ error: { code: 'MACHINE_NOT_BOUND', message: 'Machine is not bound to an org' } });

    if (!isUuid(body.workroom_id)) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'workroom_id (uuid) is required' } });
    }

    // Workroom must belong to THIS machine's org. No-leak: not-found OR cross-org → 404.
    const workroom = await db.controlWorkroom.findUnique({ where: { id: body.workroom_id }, select: { orgId: true, name: true } });
    if (!workroom || workroom.orgId !== machine.orgId) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    // pairing-code TTL (how long the QR is valid before redeem).
    const ttlSeconds = body.ttl_seconds ?? PAIRING_CODE_TTL_DEFAULT_S;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > PAIRING_CODE_TTL_MAX_S) {
      return reply.code(400).send({ error: { code: 'INVALID_TTL', message: `ttl_seconds must be 1..${PAIRING_CODE_TTL_MAX_S}` } });
    }
    // op_sess_ TTL minted AT redeem — validated against operator-session bounds.
    const opSessTtlHours = body.op_sess_ttl_hours ?? OPERATOR_SESSION_DEFAULT_TTL_HOURS;
    if (!Number.isFinite(opSessTtlHours) || opSessTtlHours <= 0 || opSessTtlHours > OPERATOR_SESSION_MAX_TTL_HOURS) {
      return reply.code(400).send({ error: { code: 'INVALID_TTL', message: `op_sess_ttl_hours must be 1..${OPERATOR_SESSION_MAX_TTL_HOURS}` } });
    }

    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const pairing = await db.controlOperatorPairing.create({
      data: {
        codeHash: hashCode(code),
        orgId: machine.orgId,
        workroomId: body.workroom_id,
        allowedCommands: [...V1_OPERATOR_COMMANDS],
        ttlHours: opSessTtlHours,
        scopeLabel: SCOPE_LABEL_V1,
        createdByMachineId: machine.id,
        expiresAt,
      },
    });
    await db.controlMachine.update({ where: { id: machine.id }, data: { lastSeenAt: new Date() } });

    // OPAQUE payload only — no raw token (mint-at-redeem). `code` is the one-time handle for the QR.
    // server_host = the host the daemon connected to (where the phone redeems); not a secret.
    return reply.code(201).send({
      pairing_id: pairing.id,
      code,
      server_host: (request.headers.host as string | undefined) ?? null,
      workroom_display: workroom.name,
      scope_label: SCOPE_LABEL_V1,
      expires_at: expiresAt.toISOString(),
    });
  });

  /**
   * POST /api/v1/operator-pairings/:code/redeem  (NO bearer — the opaque code is the credential)
   * Atomic CAS consume → mint op_sess_ → return raw token ONCE. Uniform 403 on any failure.
   */
  app.post('/api/v1/pairings/:code/redeem', async (request, reply) => {
    const { code } = request.params as { code: string };
    const fail = () => reply.code(403).send({ error: { code: 'PAIRING_NOT_REDEEMABLE', message: 'Pairing not redeemable' } });
    if (!code || typeof code !== 'string') return fail();

    const codeHash = hashCode(code);
    const now = new Date();

    // Atomic one-time consume: expired / already-consumed / canceled all → count 0 (uniform 403).
    const cas = await db.controlOperatorPairing.updateMany({
      where: { codeHash, expiresAt: { gt: now }, consumedAt: null, canceledAt: null },
      data: { consumedAt: now },
    });
    if (cas.count === 0) return fail();

    const pairing = await db.controlOperatorPairing.findUnique({ where: { codeHash } });
    if (!pairing) return fail(); // unreachable (just consumed); fail-closed.

    try {
      // mint-at-redeem: raw op_sess_ generated here, returned ONCE, stored only as hash by the mint.
      const result = await mintOperatorSession({
        orgId: pairing.orgId,
        workroomId: pairing.workroomId,
        operatorSubjectId: `pairing:${pairing.id}`,
        issuedBy: `machine:${pairing.createdByMachineId}`,
        allowedCommands: pairing.allowedCommands,
        ttlHours: pairing.ttlHours,
      });
      // SECURITY: op_sess_token appears ONLY here (TLS body) → iOS Keychain. Never log it.
      return reply.code(200).send({
        op_sess_token: result.rawToken,
        workroom_id: pairing.workroomId,
        org_id: pairing.orgId,
        allowed_commands: result.allowedCommands,
        expires_at: result.expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof OperatorSessionMintError) {
        // Pairing already consumed (one-time honored). Mint failed (e.g. workroom changed) → re-pair.
        return reply.code(422).send({ error: { code: 'MINT_FAILED', message: 'Operator session could not be minted' } });
      }
      throw err;
    }
  });

  /**
   * DELETE /api/v1/machines/:id/operator-pairings/:pairingId  (machine_token)
   * Cancel an outstanding pairing (regenerate = cancel old + create new).
   */
  app.delete('/api/v1/machines/:id/pairings/:pairingId', async (request, reply) => {
    const { id, pairingId } = request.params as { id: string; pairingId: string };
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    if (machine.id !== id) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Token does not match machine id' } });
    if (!isUuid(pairingId)) return reply.code(404).send({ error: { code: 'PAIRING_NOT_FOUND', message: 'Pairing not found' } });

    // Only the creating machine can cancel; not-found / not-yours / already-terminal → uniform 404.
    const res = await db.controlOperatorPairing.updateMany({
      where: { id: pairingId, createdByMachineId: machine.id, consumedAt: null, canceledAt: null },
      data: { canceledAt: new Date() },
    });
    if (res.count === 0) return reply.code(404).send({ error: { code: 'PAIRING_NOT_FOUND', message: 'Pairing not found' } });
    return reply.code(200).send({ pairing_id: pairingId, canceled: true });
  });
}
