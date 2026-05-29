/**
 * Slock Slice 6 — Zero-touch machine enrollment (Mac daemon ↔ phone operator).
 *
 * Three endpoints mirroring the #153 pairing model (opaque code, mint-at-redeem, anti-enumeration):
 *
 *   POST /api/v1/enrollment-intents               (NO auth)         — Mac creates an enrollment intent
 *   POST /api/v1/enrollment-intents/:id/approve   (Bearer user_sess_) — Phone approves; mints machine_token
 *   GET  /api/v1/enrollment-intents/:id?code=...  (NO auth)          — Mac long-polls; one-shot token delivery
 *
 * SECURITY:
 *   - mint-at-redeem (same idea as #153): only sha256(opaque_code) is persisted server-side; the raw
 *     `opaque_code` is held by Mac (display via QR) until it round-trips back to the phone via the
 *     mio:// deeplink, then the phone sends it as the `code` body field at approve time.
 *   - approve mints a real machine_token via the same primitive as machineRoutes:29-31
 *     (randomBytes(32).toString('hex') → sha256 → tokenHash column). The raw token is stashed in
 *     `deliveredToken` ONLY long enough for the Mac's first long-poll to retrieve it; the GET
 *     handler does an optimistic-CAS clear of that column before returning, guaranteeing one-shot
 *     delivery (replay-safe).
 *   - ALL intent-redemption failure paths (expired / canceled / wrong code / already-delivered /
 *     approve-CAS-loss) return a UNIFORM 403 `ENROLLMENT_NOT_REDEEMABLE`. Auth-failure paths
 *     (no session, expired session, non-member of workroom) return 401 / 403 FORBIDDEN via
 *     `requireUserWrite` BEFORE the intent is touched — that distinction is intentional per
 *     spec §6.3: the phone owner needs to know "you can't approve into a workroom you don't own"
 *     separately from "this code is gone".
 *   - Slice 7: auth is `requireUserWrite({ workroomIdFrom: 'body', paramName: 'workroom_id' })`.
 *     The body MUST carry the workroom_id the phone wants this machine to live in; the middleware
 *     verifies the user is an OWNER of that workroom. No op_sess_ involvement anywhere.
 *   - The opaque_code and the minted machine_token MUST NOT be logged.
 */
import type { FastifyPluginAsync } from 'fastify';
import { randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';
import { requireUser } from '@/auth/userSession/requireUser';
// R2.3 (CORRECTED MODEL): a workspace == one ControlWorkroom, created COMPUTER-SIDE at
// machine enrollment. When the approving user has no workroom to bind the machine to, we
// provision one here. Another agent owns this module; if it is not present at typecheck time
// that is a known gap (see structured output), not a logic error in this file.
import { provisionPersonalWorkspace } from '@/control/workrooms/provisionPersonalWorkspace';

const MACHINE_ENROLLMENT_TTL_S = 300; // 5 min — bootstrap path, shorter than #153 pairing
const MACHINE_TOKEN_TTL_DAYS = 365;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
function generateOpaqueCode(): string {
  return randomBytes(18).toString('base64url'); // 144-bit, ~24 chars
}
function generateMachineToken(): string {
  return randomBytes(32).toString('hex'); // mirrors machineRoutes.ts:29-31
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const machineEnrollmentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/v1/enrollment-intents  (NO auth)
   * Mac creates a fresh intent. Server stores ONLY sha256(opaque_code) + device metadata.
   */
  app.post('/api/v1/enrollment-intents', async (request, reply) => {
    const body = request.body as { device_name?: unknown; platform?: unknown; arch?: unknown } | null;
    if (
      !body ||
      typeof body.device_name !== 'string' || body.device_name.length === 0 ||
      typeof body.platform !== 'string' || body.platform.length === 0 ||
      typeof body.arch !== 'string' || body.arch.length === 0
    ) {
      return reply.code(400).send({
        error: { code: 'INVALID_BODY', message: 'device_name, platform, arch required (non-empty strings)' },
      });
    }
    const opaque = generateOpaqueCode();
    const expiresAt = new Date(Date.now() + MACHINE_ENROLLMENT_TTL_S * 1000);
    const intent = await db.controlMachineEnrollment.create({
      data: {
        codeHash: hashCode(opaque),
        deviceName: body.device_name,
        platform: body.platform,
        arch: body.arch,
        expiresAt,
      },
    });
    // SECURITY: opaque_code appears ONLY here (TLS body) → Mac terminal/QR. Never log it.
    return reply.code(201).send({
      intent_id: intent.id,
      opaque_code: opaque,
      expires_at: expiresAt.toISOString(),
    });
  });

  /**
   * POST /api/v1/enrollment-intents/:id/approve  (Bearer user_sess_)
   *
   * CORRECTED MODEL (R2.3): a "workspace" == one ControlWorkroom, created COMPUTER-SIDE at
   * enrollment. The phone is merely APPROVING the computer's enrollment; it does not pre-own
   * a workspace. So `workroom_id` in the body is now OPTIONAL:
   *   - workroom_id PRESENT → bind the machine into an EXISTING workspace the caller owns
   *     (workroom_already_bound = true, kind = 'both'). The caller MUST be an owner of it.
   *   - workroom_id ABSENT  → there is no workspace yet; we CREATE a personal one via
   *     provisionPersonalWorkspace (workroom_already_bound = false, kind = 'workspace').
   *
   * Auth: `requireUser()` (NO workroom loc) runs as a preHandler — it authenticates the Bearer
   * but does NOT do the workroom ownership check, because that check is conditional now (only
   * applies when workroom_id is present). So:
   *   - missing/invalid/expired Bearer        → 401 INVALID_SESSION   (no intent touched)
   *   - workroom_id present but caller is not  → 403 FORBIDDEN          (no intent touched;
   *     an OWNER of it                            checked at top of handler, BEFORE the CAS)
   * The auth/ownership-fail (403 FORBIDDEN) vs intent-fail (403 ENROLLMENT_NOT_REDEEMABLE)
   * split is preserved per spec §6.3 (T14 vs T16): the ownership check returns FORBIDDEN and
   * leaves the intent untouched.
   *
   * After auth+ownership: atomic CAS consume + (provision workspace if needed) + ControlMachine
   * REUSE-or-create + token stash, all in one $transaction. ControlMachine is idempotent: if a
   * machine for this physical mac already exists in the target workspace's org (matched by an
   * existing Device.controlMachineId bridge, or by an already-bound machine with the same
   * displayName in this org), we REUSE it (rotating its token) instead of creating a duplicate.
   * Any failure inside the tx (wrong code, expired, double-approve race, FK violation, injected
   * mid-tx throw) → uniform 403 ENROLLMENT_NOT_REDEEMABLE.
   *
   * Response: { kind: 'workspace'|'both', machine_id, workroom_id, workroom_already_bound }
   *   - kind = 'workspace' → a fresh workspace was provisioned for this enrollment.
   *   - kind = 'both'      → machine bound into an existing workspace the caller already owned.
   * The iOS confirm dialog uses workroom_already_bound to warn honestly ("this Mac will join
   * your existing workspace X" vs "a new workspace will be created").
   */
  app.post(
    '/api/v1/enrollment-intents/:id/approve',
    { preHandler: requireUser() },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { code?: unknown; workroom_id?: unknown } | null;
      const fail403 = () =>
        reply.code(403).send({ error: { code: 'ENROLLMENT_NOT_REDEEMABLE', message: 'Not redeemable' } });

      if (!body || typeof body.code !== 'string' || body.code.length === 0) {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'code required' } });
      }
      // workroom_id is OPTIONAL. When present it must be a string.
      if (body.workroom_id !== undefined && typeof body.workroom_id !== 'string') {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'workroom_id must be a string when present' } });
      }
      const requestedWorkroomId = typeof body.workroom_id === 'string' ? body.workroom_id : undefined;
      const userId = request.user!.id;

      // OWNERSHIP CHECK (only when binding into an existing workspace). Done BEFORE touching the
      // intent so the failure surfaces as 403 FORBIDDEN (auth-fail), never as the intent-fail code.
      if (requestedWorkroomId) {
        const membership = await db.userWorkroomMembership.findUnique({
          where: { userId_workroomId: { userId, workroomId: requestedWorkroomId } },
        });
        if (!membership || membership.role !== 'owner') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Not an owner of that workspace' } });
        }
      }

      const codeHash = hashCode(body.code);
      const now = new Date();
      const rawToken = generateMachineToken();
      const tokenHash = hashToken(rawToken);
      const tokenExpiresAt = new Date(Date.now() + MACHINE_TOKEN_TTL_DAYS * 86400000);

      try {
        const result = await db.$transaction(async (tx) => {
          // CAS consume — mirror operatorPairingRoutes.ts:131-138 atomic updateMany pattern.
          // approvedWorkroomId is left for after we resolve/provision the workroom below.
          const cas = await tx.controlMachineEnrollment.updateMany({
            where: {
              id,
              codeHash,
              approvedAt: null,
              canceledAt: null,
              expiresAt: { gt: now },
            },
            data: {
              approvedAt: now,
              approvedByUserId: userId,
            },
          });
          if (cas.count === 0) throw new Error('NOT_REDEEMABLE');

          // Re-read post-CAS for the fresh fields (deviceName/platform/arch).
          const intent = await tx.controlMachineEnrollment.findUniqueOrThrow({ where: { id } });

          // Resolve the workspace to bind into. PRESENT → reuse existing (ownership already
          // verified above). ABSENT → provision a fresh personal workspace for this enrollment.
          let workroomId: string;
          let workroomAlreadyBound: boolean;
          if (requestedWorkroomId) {
            workroomId = requestedWorkroomId;
            workroomAlreadyBound = true;
          } else {
            const provisioned = await provisionPersonalWorkspace(tx, userId);
            workroomId = provisioned.workroomId;
            workroomAlreadyBound = false;
          }

          const workroom = await tx.controlWorkroom.findUniqueOrThrow({ where: { id: workroomId } });

          // ── ControlMachine REUSE-or-create (idempotency for the same physical mac) ──────────
          // Strongest reuse signal available from an enrollment payload is the (org, displayName)
          // pair plus any existing Device→ControlMachine bridge. A repeat enrollment of the same
          // Mac (re-run of `mio-agent login`, or MioIsland attaching after a terminal enroll) must
          // NOT spawn a duplicate workspace machine. We reuse the most recent bound machine in this
          // org whose displayName matches, OR a machine already bridged from a monitoring Device.
          let machineId: string | null = null;
          const bridgedDevice = await tx.device.findFirst({
            where: {
              userId,
              controlMachineId: { not: null },
              controlMachine: { is: { orgId: workroom.orgId } },
            },
            select: { controlMachineId: true },
          });
          if (bridgedDevice?.controlMachineId) {
            machineId = bridgedDevice.controlMachineId;
          } else {
            const existingMachine = await tx.controlMachine.findFirst({
              where: { orgId: workroom.orgId, displayName: intent.deviceName },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (existingMachine) machineId = existingMachine.id;
          }

          if (machineId) {
            // REUSE: rotate the token so the daemon re-receives a fresh machine_token (one-shot
            // delivery via the poll). boundAt refreshed; platform/arch left as-is.
            await tx.controlMachine.update({
              where: { id: machineId },
              data: { boundAt: now, tokenHash, tokenExpiresAt },
            });
          } else {
            const machine = await tx.controlMachine.create({
              data: {
                displayName: intent.deviceName,
                platform: intent.platform,
                arch: intent.arch,
                orgId: workroom.orgId,
                boundAt: now,
                tokenHash,
                tokenExpiresAt,
              },
            });
            machineId = machine.id;
          }

          await tx.controlMachineEnrollment.update({
            where: { id },
            data: { machineId, deliveredToken: rawToken, approvedWorkroomId: workroomId },
          });
          return { machineId, workroomId, workroomAlreadyBound };
        });
        return reply.code(200).send({
          kind: result.workroomAlreadyBound ? ('both' as const) : ('workspace' as const),
          machine_id: result.machineId,
          workroom_id: result.workroomId,
          workroom_already_bound: result.workroomAlreadyBound,
        });
      } catch {
        // Any failure inside the tx (CAS loss, FK violation, etc.) → uniform 403.
        return fail403();
      }
    },
  );

  /**
   * GET /api/v1/enrollment-intents/:id?code=<opaque>  (NO auth — `code` is the nonce)
   * Mac long-polls. Returns 202 pending until approve happens, then 200 with the machine_token
   * exactly ONCE (optimistic-CAS clear of deliveredToken inside the same tx).
   */
  app.get('/api/v1/enrollment-intents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { code } = request.query as { code?: string };
    const fail403 = () =>
      reply.code(403).send({ error: { code: 'ENROLLMENT_NOT_REDEEMABLE', message: 'Not redeemable' } });
    if (!code || typeof code !== 'string') return fail403();

    const codeHash = hashCode(code);
    const now = new Date();

    try {
      const out = await db.$transaction(async (tx) => {
        const intent = await tx.controlMachineEnrollment.findFirst({
          where: { id, codeHash, canceledAt: null, expiresAt: { gt: now } },
        });
        if (!intent) throw new Error('NOT_FOUND');
        if (!intent.approvedAt) return { status: 'pending' as const };
        if (!intent.deliveredToken || !intent.machineId || !intent.approvedWorkroomId) {
          // Already delivered (token cleared) or invariant violation → uniform 403.
          throw new Error('ALREADY_DELIVERED');
        }
        const tokenToReturn = intent.deliveredToken;
        const machineId = intent.machineId;
        const approvedWorkroomId = intent.approvedWorkroomId;

        // Optimistic-CAS clear so a concurrent GET cannot also read the token.
        const cleared = await tx.controlMachineEnrollment.updateMany({
          where: { id, deliveredToken: { not: null } },
          data: { deliveredToken: null },
        });
        if (cleared.count !== 1) throw new Error('ALREADY_DELIVERED');

        // org_id derived from the workroom we approved into (matches the ControlMachine's orgId).
        const workroom = await tx.controlWorkroom.findUniqueOrThrow({
          where: { id: approvedWorkroomId },
        });
        return {
          status: 'approved' as const,
          machine_token: tokenToReturn,
          machine_id: machineId,
          org_id: workroom.orgId,
          workroom_id: approvedWorkroomId,
        };
      });

      if (out.status === 'pending') return reply.code(202).send({ status: 'pending' });
      // SECURITY: machine_token appears ONLY here (TLS body) → Mac Keychain. Never log.
      return reply.code(200).send({
        machine_token: out.machine_token,
        machine_id: out.machine_id,
        org_id: out.org_id,
        workroom_id: out.workroom_id,
      });
    } catch {
      return fail403();
    }
  });
};
