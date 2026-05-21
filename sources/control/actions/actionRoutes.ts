/**
 * Action API — control plane
 *
 * HARD POINTS implemented here:
 *
 * 1. Action Fire Transaction (POST /api/v1/actions/:id/fire)
 *    For irreversible_no_abort actions:
 *    - MUST have an 'approved' approval
 *    - Prisma interactive transaction:
 *        (a) CAS approval status: updateMany WHERE status='approved' → status='consumed'
 *            → 0 rows = approval not in approved state → 409
 *        (b) INSERT control_action_approval_consumptions  (UNIQUE on approval_id + action_id)
 *            → unique violation = concurrent fire race → 409
 *        (c) UPDATE control_actions SET status='fired', fired_at, approved_at_snapshot
 *    For reversible / irreversible_abortable:
 *    - No approval required; direct status → 'fired'
 *
 * 2. Approval Consumption Write Path
 *    DB invariant: UNIQUE(approval_id) + UNIQUE(action_id) on
 *    control_action_approval_consumptions prevents double-fire.
 *    Server invariant: reversibility='irreversible_no_abort' ⟹ requires_approval=TRUE
 *    (enforced by CHECK constraint in migration SQL).
 *
 * Endpoints:
 *   POST   /api/v1/workrooms/:workroomId/actions  → create action proposal
 *   GET    /api/v1/actions/:id                    → get action (NO action_token in response)
 *   PATCH  /api/v1/actions/:id                    → update non-terminal action
 *   POST   /api/v1/actions/:id/fire               → *** FIRE TRANSACTION (hard point) ***
 *                                                    Returns action_token once; raw token unrecoverable after
 *   POST   /api/v1/actions/:id/token/consume      → *** CONSUME TOKEN (Phase 5B) ***
 *                                                    Auth: action_token bearer (NOT machine_token)
 *                                                    CAS atomic; returns secret_bundle v1=empty fixture
 *   POST   /api/v1/actions/:id/cancel             → cancel action
 *   POST   /api/v1/actions/:id/reconcile          → *** RECONCILE (Phase 5C) ***
 *                                                    Auth: machine_token (firing machine only)
 *                                                    CAS fired→needs_human; idempotent per evidence_id
 *
 *   POST   /api/v1/workrooms/:workroomId/approvals → create approval request
 *   GET    /api/v1/approvals/:id                  → get approval
 *   POST   /api/v1/approvals/:id/decide           → approve / reject / snooze
 */

import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { publishControlEvent, type ControlEventResult } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';
import { FIRE_GUARD_STATUSES, HARD_TERMINAL_STATUSES, ACTION_KIND_REQUIRES_CREDENTIAL } from '@/control/actionStatusSets';
import { type CredentialStore, CredentialStoreError } from '@/control/credentials/credentialStore';

/** Publish an event to DB + broadcast to WS subscribers (write-before-broadcast). */
async function publishAndBroadcast(input: Parameters<typeof publishControlEvent>[0]): Promise<ControlEventResult> {
  const event = await publishControlEvent(input);
  if (!event.idempotent) {
    workroomBroadcaster.broadcast(input.workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
  }
  return event;
}

const IRREVERSIBLE_NO_ABORT = 'irreversible_no_abort';
const FIREABLE_STATUSES = ['proposed', 'approved'];
// FIRE_GUARD_STATUSES and HARD_TERMINAL_STATUSES imported from actionStatusSets.ts.
// Local alias for backward-compatible array usage in notIn query:
const TERMINAL_STATUSES = [...FIRE_GUARD_STATUSES];

/**
 * TTL for action tokens: 5 minutes.
 * Short enough to limit exposure; long enough for subprocess to complete the consume call.
 */
const ACTION_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Generate a one-time action capability token.
 * Format: `act_tok_<base64url(32 random bytes)>` (256-bit entropy).
 * Prefix enables log scanning for accidental leakage.
 *
 * SECURITY: raw token MUST be returned to caller and NEVER logged or stored.
 * Only the SHA-256 hash goes into the DB.
 */
function generateActionToken(): { rawToken: string; tokenHash: string } {
  const raw = randomBytes(32).toString('base64url');
  const rawToken = `act_tok_${raw}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

/**
 * Maps ControlCredential.kind (what it is) to secret_bundle item.kind (how to inject).
 * Subprocess uses item.kind to decide: 'env_var' → setenv; 'file' → write 0600 temp file.
 *
 * NOTE: This mapping is the server side of the #18/#19 inject contract.
 *       mio-agent consumeSubprocess MUST handle both values.
 *       Default: 'env_var' (API keys, tokens — the primary v1 use cases).
 *
 * v1 scope: publish_ios uses asc_api_key → file (.p8); deploy_web uses vercel_token → env_var.
 */
const CREDENTIAL_KIND_TO_INJECT: Readonly<Record<string, 'env_var' | 'file'>> = {
  asc_api_key: 'file',   // .p8 private key for App Store Connect — MUST be written to 0600 temp file
  cert:        'file',
  ssh_key:     'file',
};

function credentialInjectKind(kind: string): 'env_var' | 'file' {
  return CREDENTIAL_KIND_TO_INJECT[kind] ?? 'env_var';
}

interface ActionRoutesOptions {
  /**
   * Pluggable credential store for Phase 5D secret resolution.
   * If not provided, credential-requiring actions will transition to 'needs_human'
   * (fail-safe: no production credential store configured).
   *
   * PROD GUARD: FixtureCredentialStore / AesFileCredentialStore are forbidden in production.
   * Wire a production-grade KMS/Vault/Keychain adapter here.
   */
  credentialStore?: CredentialStore;
}

export async function actionRoutes(app: FastifyInstance, options: ActionRoutesOptions = {}) {
  const { credentialStore } = options;

  /**
   * POST /api/v1/workrooms/:workroomId/actions
   * Propose a new action. Server enforces the approval invariant:
   * if reversibility='irreversible_no_abort' → requires_approval=true (DB CHECK also enforces).
   */
  app.post('/api/v1/workrooms/:workroomId/actions', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
    const body = request.body as {
      session_id: string;
      actor_agent_id: string;
      task_id?: string;
      kind: string;
      summary: string;
      reversibility: string;
      risk_level: string;
      credential_alias_ref?: string;
      client_idempotency_key: string;
    };

    if (!body.session_id || !body.actor_agent_id || !body.kind || !body.summary || !body.reversibility || !body.risk_level || !body.client_idempotency_key) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'session_id, actor_agent_id, kind, summary, reversibility, risk_level, client_idempotency_key are required' } });
    }

    // Server invariant: irreversible_no_abort MUST require approval
    const requiresApproval = body.reversibility === IRREVERSIBLE_NO_ABORT ? true : false;

    const workroom = await db.controlWorkroom.findUnique({ where: { id: workroomId } });
    if (!workroom) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, workroomId, { orgId: workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    let action;
    try {
      action = await db.controlAction.create({
        data: {
          sessionId: body.session_id,
          workroomId,
          taskId: body.task_id,
          actorAgentId: body.actor_agent_id,
          kind: body.kind,
          summary: body.summary,
          reversibility: body.reversibility,
          riskLevel: body.risk_level,
          status: 'proposed',
          requiresApproval,
          credentialAliasRef: body.credential_alias_ref,
          clientIdempotencyKey: body.client_idempotency_key,
        },
      });
    } catch (err) {
      // Idempotency: if client_idempotency_key already exists, return existing action
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await db.controlAction.findFirst({
          where: { clientIdempotencyKey: body.client_idempotency_key },
        });
        if (existing) {
          return reply.code(200).send({
            action_id: existing.id,
            status: existing.status,
            requires_approval: existing.requiresApproval,
            idempotent: true,
          });
        }
      }
      throw err;
    }

    // Emit action.created — locator + controlled enum only; ActionGate must re-query for authority.
    // PAYLOAD CONTRACT: only locator IDs + status enums. No free text, no paths, no credentials.
    await publishAndBroadcast({
      workroomId,
      eventId: randomUUID(),
      topic: 'action.created',
      payload: {
        workroom_id: workroomId,
        action_id: action.id,
        session_id: action.sessionId,
        actor_agent_id: action.actorAgentId,
        reversibility: action.reversibility,          // controlled enum
        requires_approval: action.requiresApproval,
        status: action.status,                        // controlled enum
      },
    });

    return reply.code(201).send({
      action_id: action.id,
      workroom_id: action.workroomId,
      kind: action.kind,
      summary: action.summary,
      reversibility: action.reversibility,
      risk_level: action.riskLevel,
      status: action.status,
      requires_approval: action.requiresApproval,
      created_at: action.createdAt.toISOString(),
    });
  });

  /**
   * GET /api/v1/actions/:id
   */
  app.get('/api/v1/actions/:id', async (request, reply) => {
    // Dual-auth: machine_token (full) OR dev_control_token (read-only, allowlist + workroom-scope).
    const auth = await authorizeControlRead(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }

    const { id } = request.params as { id: string };
    const action = await db.controlAction.findUnique({
      where: { id },
      include: { approvalConsumption: true, workroom: { select: { orgId: true } } },
    });
    if (!action) {
      return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
    }

    // machine mode: enforce org/workroom access. dev mode: workroom-scope already
    // verified in authorizeControlRead (reverse-lookup of this action's workroom).
    if (auth.mode === 'machine') {
      const access = await requireMachineAccessToWorkroom(auth.machine, action.workroomId, { orgId: action.workroom.orgId });
      if (!access.ok) return reply.code(access.status).send({ error: access.error });
    }

    return {
      action_id: action.id,
      workroom_id: action.workroomId,
      session_id: action.sessionId,
      task_id: action.taskId,
      actor_agent_id: action.actorAgentId,
      kind: action.kind,
      summary: action.summary,
      reversibility: action.reversibility,
      risk_level: action.riskLevel,
      status: action.status,
      requires_approval: action.requiresApproval,
      approval_id: action.approvalId,
      approved_at_snapshot: action.approvedAtSnapshot?.toISOString() ?? null,
      fired_at: action.firedAt?.toISOString() ?? null,
      transmission_completed_at: action.transmissionCompletedAt?.toISOString() ?? null,
      external_confirmed_at: action.externalConfirmedAt?.toISOString() ?? null,
      credential_alias_ref: action.credentialAliasRef,
      approval_consumed: !!action.approvalConsumption,
      created_at: action.createdAt.toISOString(),
    };
  });

  /**
   * POST /api/v1/actions/:id/fire
   *
   * *** HARD POINT: ACTION FIRE TRANSACTION ***
   *
   * For irreversible_no_abort actions, this is a 3-step atomic transaction:
   *
   *   Step 1: CAS approval status 'approved' → 'consumed'
   *           (Prisma updateMany with WHERE status='approved')
   *           → If 0 rows: approval was consumed/rejected/expired → 409
   *
   *   Step 2: INSERT control_action_approval_consumptions
   *           UNIQUE(approval_id, action_id) is the backstop against races.
   *           → If P2002 unique violation: concurrent fire won the race → 409
   *
   *   Step 3: UPDATE control_actions SET status='fired', fired_at, approved_at_snapshot
   *
   * All three steps run inside a Prisma interactive transaction.
   * A failure at any step rolls back all three.
   *
   * Body: { approval_id?: string }  (required for irreversible_no_abort)
   */
  app.post('/api/v1/actions/:id/fire', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: actionId } = request.params as { id: string };
    const { approval_id } = (request.body ?? {}) as { approval_id?: string };

    // Fetch action
    const action = await db.controlAction.findUnique({
      where: { id: actionId },
      include: { workroom: { select: { orgId: true } } },
    });
    if (!action) {
      return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, action.workroomId, { orgId: action.workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    // Reject if already in terminal state
    if (TERMINAL_STATUSES.includes(action.status)) {
      return reply.code(409).send({
        error: {
          code: 'ACTION_ALREADY_TERMINAL',
          message: `Action is already in terminal state: ${action.status}`,
        },
      });
    }

    if (!FIREABLE_STATUSES.includes(action.status)) {
      return reply.code(422).send({
        error: {
          code: 'ACTION_NOT_FIREABLE',
          message: `Action status '${action.status}' is not fireable`,
        },
      });
    }

    const now = new Date();

    // ── Reversible / irreversible_abortable: no approval required ──
    // CAS on action status: only fire if still in a fireable state.
    // Prevents double-fire from concurrent retries or duplicate requests.
    if (action.reversibility !== IRREVERSIBLE_NO_ABORT) {
      // Generate action token BEFORE the status update so we can store it atomically.
      // Raw token returned in response ONCE — never logged, never stored in DB.
      const { rawToken, tokenHash } = generateActionToken();
      const tokenExpiresAt = new Date(now.getTime() + ACTION_TOKEN_TTL_MS);

      // Interactive transaction: CAS status update + token issuance atomically.
      let fireCount = 0;
      try {
        await db.$transaction(async (tx) => {
          const result = await tx.controlAction.updateMany({
            where: {
              id: actionId,
              status: { notIn: TERMINAL_STATUSES },  // CAS: reject if already terminal
            },
            data: { status: 'fired', firedAt: now },
          });
          fireCount = result.count;
          if (result.count === 0) {
            // Throw to abort the transaction.
            throw new FireConflictError('ACTION_ALREADY_TERMINAL', 'Action already in terminal state');
          }
          // INSERT token record inside the same transaction.
          // UNIQUE(action_id) + UNIQUE(token_hash): if a prior fire already issued a token,
          // this INSERT fails — same protection as approval double-consume backstop.
          await tx.controlActionToken.create({
            data: {
              actionId,
              tokenHash,
              sessionId: action.sessionId,
              workroomId: action.workroomId,
              machineId: machine.id,
              expiresAt: tokenExpiresAt,
            },
          });
        });
      } catch (err) {
        if (err instanceof FireConflictError) {
          const current = await db.controlAction.findUnique({ where: { id: actionId } });
          return reply.code(409).send({
            error: {
              code: 'ACTION_ALREADY_TERMINAL',
              message: `Action is already in terminal state: ${current?.status ?? 'unknown'}`,
            },
          });
        }
        // P2002 unique violation on token: concurrent double-fire slipped through CAS
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return reply.code(409).send({
            error: { code: 'FIRE_RACE_CONFLICT', message: 'Concurrent fire detected — token already issued' },
          });
        }
        throw err;
      }

      // Emit action.status_changed — locator + status enum only. No free text, no credentials.
      // SECURITY: action_token MUST NOT appear in event payloads, logs, or WS broadcasts.
      await publishAndBroadcast({
        workroomId: action.workroomId,
        eventId: randomUUID(),
        topic: 'action.status_changed',
        payload: {
          workroom_id: action.workroomId,
          action_id: actionId,
          session_id: action.sessionId,
          status: 'fired',                            // controlled enum
        },
      });

      // Return raw token ONCE. After this point, the raw token is unrecoverable.
      // SECURITY: rawToken MUST NOT be logged anywhere (not here, not by Fastify request logger).
      return { action_id: actionId, fired: true, fired_at: now.toISOString(), action_token: rawToken };
    }

    // ── irreversible_no_abort: APPROVAL CONSUMPTION TRANSACTION ──

    if (!approval_id) {
      return reply.code(400).send({
        error: {
          code: 'APPROVAL_REQUIRED',
          message: 'approval_id is required for irreversible_no_abort actions',
        },
      });
    }

    // Fetch approval for snapshot (decidedAt needed for approvedAtSnapshot)
    const approval = await db.controlApproval.findUnique({ where: { id: approval_id } });
    if (!approval) {
      return reply.code(404).send({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found' } });
    }
    if (approval.actionId !== actionId) {
      return reply.code(403).send({
        error: { code: 'APPROVAL_MISMATCH', message: 'Approval does not belong to this action' },
      });
    }

    // Generate action token BEFORE the transaction so we can store it atomically.
    const { rawToken: irreversibleRawToken, tokenHash: irreversibleTokenHash } = generateActionToken();
    const irreversibleTokenExpiresAt = new Date(now.getTime() + ACTION_TOKEN_TTL_MS);

    try {
      const firedAction = await db.$transaction(async (tx) => {
        // ── Step 1: CAS approval 'approved' → 'consumed' ──
        // updateMany atomically checks status AND expiry before updating.
        // Conditions for count=0:
        //   - approval already consumed, rejected, or in any non-approved state
        //   - approval is past expiresAt (wall-clock expired, even if status not yet flipped)
        const approvalCAS = await tx.controlApproval.updateMany({
          where: {
            id: approval_id,
            status: 'approved',  // CAS: only if still approved
            // Expiry check: accept if no expiry, or if expiry is in the future.
            // This rejects past-expiry approvals even if a cron hasn't flipped their status.
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          data: {
            status: 'consumed',
            // Do NOT overwrite decidedAt — it records when the human approved.
            // approvedAtSnapshot on the action captures that timestamp for audit.
          },
        });

        if (approvalCAS.count === 0) {
          // Distinguish expired vs. wrong status for a better error message.
          // Re-read inside tx for accuracy (already holding row-level intent lock via updateMany).
          throw new FireConflictError(
            'APPROVAL_NOT_APPROVED',
            `Approval is not in 'approved' state or has expired (may be consumed, rejected, or past expiresAt)`,
          );
        }

        // ── Step 2: INSERT consumption record (UNIQUE backstop) ──
        // UNIQUE(approval_id) + UNIQUE(action_id) catches any concurrent fire race
        // that slipped through the CAS above (e.g. non-serializable isolation edge case).
        await tx.controlActionApprovalConsumption.create({
          data: {
            approvalId: approval_id,
            actionId,
          },
        });

        // ── Step 3: UPDATE action to 'fired' ──
        const fired = await tx.controlAction.update({
          where: { id: actionId },
          data: {
            status: 'fired',
            firedAt: now,
            approvalId: approval_id,
            approvedAtSnapshot: approval.decidedAt,  // snapshot at time of fire
          },
        });

        // ── Step 4: INSERT action token (UNIQUE(action_id) + UNIQUE(token_hash) backstop) ──
        // Raw token NEVER stored — only the SHA-256 hash.
        // SECURITY: irreversibleRawToken MUST NOT be logged anywhere.
        await tx.controlActionToken.create({
          data: {
            actionId,
            tokenHash: irreversibleTokenHash,
            sessionId: action.sessionId,
            workroomId: action.workroomId,
            machineId: machine.id,
            expiresAt: irreversibleTokenExpiresAt,
          },
        });

        return fired;
      });

      // Emit action.status_changed for irreversible_no_abort fire — after transaction commit.
      // Locator + status enum only. No free text, no credentials, no approval details in payload.
      // SECURITY: action_token MUST NOT appear in event payloads, logs, or WS broadcasts.
      await publishAndBroadcast({
        workroomId: action.workroomId,
        eventId: randomUUID(),
        topic: 'action.status_changed',
        payload: {
          workroom_id: action.workroomId,
          action_id: firedAction.id,
          session_id: firedAction.sessionId,
          status: 'fired',                            // controlled enum
          approval_id,                                // locator only — daemon re-queries for details
        },
      });

      // Return raw token ONCE. After this point, the raw token is unrecoverable.
      // SECURITY: irreversibleRawToken MUST NOT be logged anywhere (not here, not by Fastify).
      return {
        action_id: firedAction.id,
        fired: true,
        fired_at: firedAction.firedAt?.toISOString(),
        approval_id,
        approved_at_snapshot: firedAction.approvedAtSnapshot?.toISOString() ?? null,
        action_token: irreversibleRawToken,
      };
    } catch (err) {
      if (err instanceof FireConflictError) {
        return reply.code(409).send({
          error: { code: err.code, message: err.message },
        });
      }

      // P2002 = Prisma unique constraint violation
      // This is the backstop: two concurrent transactions both passed the CAS,
      // but only one can insert into control_action_approval_consumptions.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(409).send({
          error: {
            code: 'FIRE_RACE_CONFLICT',
            message: 'Concurrent fire detected — approval or action already consumed',
          },
        });
      }

      throw err;
    }
  });

  /**
   * POST /api/v1/actions/:id/cancel
   * Cancel a non-terminal action.
   */
  app.post('/api/v1/actions/:id/cancel', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: actionId } = request.params as { id: string };
    const action = await db.controlAction.findUnique({
      where: { id: actionId },
      include: { workroom: { select: { orgId: true } } },
    });
    if (!action) {
      return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, action.workroomId, { orgId: action.workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    if (action.reversibility === IRREVERSIBLE_NO_ABORT && action.status === 'fired') {
      return reply.code(409).send({
        error: {
          code: 'CANCEL_FORBIDDEN',
          message: 'Cannot cancel an irreversible_no_abort action that has already been fired',
        },
      });
    }
    if (TERMINAL_STATUSES.includes(action.status) && action.status !== 'fired') {
      return reply.code(409).send({
        error: { code: 'ACTION_ALREADY_TERMINAL', message: `Action is already ${action.status}` },
      });
    }

    await db.controlAction.update({
      where: { id: actionId },
      data: { status: 'canceled' },
    });

    // Locator + status enum only. No free text, no credentials.
    await publishAndBroadcast({
      workroomId: action.workroomId,
      eventId: randomUUID(),
      topic: 'action.status_changed',
      payload: {
        workroom_id: action.workroomId,
        action_id: actionId,
        session_id: action.sessionId,
        status: 'canceled',                           // controlled enum
      },
    });

    return { action_id: actionId, canceled: true };
  });

  // ── ACTION TOKEN CONSUME ENDPOINT ───────────────────────────────────────────

  /**
   * POST /api/v1/actions/:id/token/consume
   *
   * Exchange a one-time action_token for scope confirmation + secret bundle.
   *
   * *** AUTHENTICATION: action_token bearer — NOT machine_token ***
   *   Authorization: Bearer act_tok_<...>
   *   The action_token itself is the bearer credential. verifyMachineToken() MUST NOT be called here.
   *   machine_id is bound at issuance time (fire) and is stored in control_action_tokens.
   *   It is NOT re-verified at consume time (subprocess never holds machine_token).
   *
   * *** ATOMIC CAS CONSUME ***
   *   Single-statement updateMany with all conditions in WHERE:
   *     token_hash + action_id + expires_at > now + consumed_at IS NULL
   *   rowcount=1 → success; rowcount=0 → unified 403 TOKEN_NOT_CONSUMABLE
   *   DO NOT read-then-write (concurrent double-consume race condition).
   *
   * v1: secret_bundle = { version: 1, items: [] }
   *   Fixture only. Real credential resolution in Phase 5C+.
   *   TODO (5C): resolve credential_alias_ref → actual secret bundle items.
   */
  app.post('/api/v1/actions/:id/token/consume', async (request, reply) => {
    // Extract action_token from Authorization header.
    // SECURITY: MUST NOT use verifyMachineToken() — consume uses action_token bearer.
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Bearer action_token required' } });
    }
    const rawToken = authHeader.slice(7);

    // Validate token prefix to catch accidental machine_token or malformed bearer usage.
    if (!rawToken.startsWith('act_tok_')) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid token format' } });
    }

    const { id: actionId } = request.params as { id: string };

    // Hash the presented token to look up the DB record.
    // Raw token is NEVER stored — only the hash.
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const now = new Date();

    // ── Atomic CAS consume ──
    // Single updateMany with all reject conditions in WHERE.
    // Unified rejection: rowcount=0 maps to TOKEN_NOT_CONSUMABLE regardless of which condition failed.
    // This prevents enumeration attacks (expired vs consumed vs wrong action vs scope mismatch
    // are all indistinguishable to the caller).
    const cas = await db.controlActionToken.updateMany({
      where: {
        tokenHash,
        actionId,                    // scope binding: token scoped to this exact action
        expiresAt: { gt: now },      // not expired
        consumedAt: null,            // not yet consumed
      },
      data: { consumedAt: now },
    });

    if (cas.count === 0) {
      // Unified rejection — do NOT reveal which condition failed.
      return reply.code(403).send({
        error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
      });
    }

    // Fetch token record — includes machineId for Phase 5D audit log.
    // Safe to read after CAS: consumed_at is now set, no race risk.
    const tokenRecord = await db.controlActionToken.findFirst({
      where: { tokenHash, actionId },
      select: { sessionId: true, workroomId: true, machineId: true },
    });

    const sessionId = tokenRecord?.sessionId ?? null;
    const consumeWorkroomId = tokenRecord?.workroomId ?? null;
    const machineId = tokenRecord?.machineId ?? null;

    // ── Phase 5D: Credential resolution ───────────────────────────────────────
    //
    // SECURITY INVARIANTS:
    //   1. ACTION_KIND_REQUIRES_CREDENTIAL is the ONLY server-authoritative gate.
    //      Daemon body fields MUST NOT influence this check.
    //   2. secretValue appears ONLY in the HTTP response body (TLS only).
    //      MUST NOT appear in logs, EventLog payloads, or WS fanout.
    //   3. All credential failures → uniform 403 TOKEN_NOT_CONSUMABLE (anti-enumeration).
    //      Internal reason lives in access_log.reasonCode + action.status only:
    //        auth/policy denial  → action=failed    (terminal)
    //        store_unavailable   → action=needs_human
    //        config_error        → action=needs_human
    //
    // Flow — failure semantics (product invariant):
    //   kind not in required set              → fast path: empty bundle
    //   kind required + no alias on action    → failed   (policy: action submitted without required field)
    //   alias not registered in org           → needs_human (config: operator must register credential)
    //   scope validation fails                → failed   (policy/auth: workroom/kind/revoked/expired)
    //   CredentialStore.resolve throws        → needs_human (recoverable config/transient error)
    //   resolve success                       → write access log, update lastUsedAt, return bundle
    //
    // Rule: `failed` = policy/auth denial — retrying won't help even if config is fixed.
    //       `needs_human` = configuration error — operator can fix and a human can assess.

    const action = await db.controlAction.findUnique({
      where: { id: actionId },
      select: {
        kind: true,
        credentialAliasRef: true,
        workroomId: true,
        workroom: { select: { orgId: true } },
      },
    });

    const actionKind = action?.kind ?? '';
    const credentialAliasRef = action?.credentialAliasRef ?? null;
    const workroomOrgId = action?.workroom?.orgId ?? null;

    const needsCredential = ACTION_KIND_REQUIRES_CREDENTIAL.has(actionKind);

    // Fast path: kind not in required set → return empty bundle regardless of alias
    if (!needsCredential) {
      return reply.code(200).send({
        consumed: true,
        action_id: actionId,
        session_id: sessionId,
        workroom_id: consumeWorkroomId,
        secret_bundle: { version: 1, items: [] },
      });
    }

    // ── Helper: transition action status + emit event on credential failure ────
    // PAYLOAD CONTRACT: locator IDs + status enum + reason_code only. NO secrets.
    //
    // SAFE CAS: updateMany WHERE status NOT IN HARD_TERMINAL_STATUSES.
    // Protects against concurrent reconcile or other paths having already advanced the action
    // to a hard terminal state (canceled, failed, succeeded, transmission_complete).
    // If the action is already terminal, the update is a no-op (count=0) — we still return the
    // 403/503 to the daemon; the daemon doesn't need to know the CAS was skipped.
    const failAction = async (status: 'failed' | 'needs_human', reasonCode: string): Promise<void> => {
      await db.controlAction.updateMany({
        where: { id: actionId, status: { notIn: [...HARD_TERMINAL_STATUSES] } },
        data: { status },
      });
      const topic = status === 'failed' ? 'action.failed' : 'action.needs_human';
      await publishAndBroadcast({
        workroomId: consumeWorkroomId ?? '',
        eventId: randomUUID(),
        topic,
        payload: {
          workroom_id: consumeWorkroomId,
          action_id: actionId,
          session_id: sessionId,
          status,
          reason_code: reasonCode,       // controlled enum — NOT secret value
        },
      }).catch(() => { /* broadcast failure is non-fatal */ });
    };

    // Credential required but no alias configured on this action
    if (!credentialAliasRef) {
      await failAction('failed', 'credential_denied');
      // Unified TOKEN_NOT_CONSUMABLE — external callers (subprocess) do not need the internal reason.
      // Reason lives in action.status=failed + access_log.reason_code only.
      return reply.code(403).send({
        error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
      });
    }

    // Anomaly: action has no workroom/org (should not happen; fail-safe)
    if (!workroomOrgId) {
      await failAction('needs_human', 'credential_configuration_invalid');
      return reply.code(403).send({
        error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
      });
    }

    // Fetch ControlCredential by (orgId, alias) — org match guaranteed by lookup key
    const credential = await db.controlCredential.findUnique({
      where: { orgId_alias: { orgId: workroomOrgId, alias: credentialAliasRef } },
      select: {
        id: true,
        kind: true,
        alias: true,
        storageRef: true,
        scopeMode: true,
        scopeWorkroomIds: true,
        allowedActionKinds: true,
        revoked: true,
        expiresAt: true,
      },
    });

    if (!credential) {
      // Alias not registered in this org — operator configuration error (not policy denial).
      // Operator can register the credential; human review required. → needs_human.
      // (Compare: scope/revoked/expired failures are policy denials → failed.)
      await failAction('needs_human', 'credential_configuration_invalid');
      return reply.code(403).send({
        error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
      });
    }

    // ── Helper: write ControlCredentialAccessLog ──────────────────────────────
    // SECURITY: reasonCode is a controlled enum. MUST NOT contain secret values.
    const writeAccessLog = async (success: boolean, reasonCode: string | null): Promise<void> => {
      if (!machineId) return;  // no machineId bound at token issuance — skip log
      await db.controlCredentialAccessLog.create({
        data: {
          credentialId: credential.id,
          actionId,
          machineId,
          success,
          reasonCode,
        },
      }).catch(() => { /* access log failure is non-fatal — do not block response */ });
    };

    // ── Scope validation (4 checks) ───────────────────────────────────────────
    const workroomInScope =
      credential.scopeMode === 'org' ||
      (consumeWorkroomId !== null && credential.scopeWorkroomIds.includes(consumeWorkroomId));
    const actionKindAllowed =
      credential.allowedActionKinds.length === 0 ||
      credential.allowedActionKinds.includes(actionKind);
    const notRevoked = !credential.revoked;
    const notExpired = !credential.expiresAt || credential.expiresAt > now;

    if (!workroomInScope || !actionKindAllowed || !notRevoked || !notExpired) {
      await writeAccessLog(false, 'credential_denied');
      await failAction('failed', 'credential_denied');
      return reply.code(403).send({
        error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
      });
    }

    // ── CredentialStore.resolve ───────────────────────────────────────────────
    if (!credentialStore) {
      // No store configured — fail-safe to needs_human (store_unavailable).
      // Return unified TOKEN_NOT_CONSUMABLE; internal reason in access_log + action.status.
      await writeAccessLog(false, 'credential_store_unavailable');
      await failAction('needs_human', 'credential_store_unavailable');
      return reply.code(403).send({
        error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
      });
    }

    let secretValue: string;
    try {
      secretValue = await credentialStore.resolve(credential.storageRef, {
        credentialId: credential.id,
        orgId: workroomOrgId,
      });
    } catch (err) {
      if (err instanceof CredentialStoreError) {
        if (err.reason === 'store_unavailable') {
          await writeAccessLog(false, 'credential_store_unavailable');
          await failAction('needs_human', 'credential_store_unavailable');
          return reply.code(403).send({
            error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
          });
        }
        // credential_not_found | credential_config_invalid — both map to config_error → needs_human
        await writeAccessLog(false, 'credential_configuration_invalid');
        await failAction('needs_human', 'credential_configuration_invalid');
        return reply.code(403).send({
          error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
        });
      }
      // Unexpected non-CredentialStoreError — treat as transient store_unavailable → needs_human
      await writeAccessLog(false, 'credential_store_unavailable');
      await failAction('needs_human', 'credential_store_unavailable');
      return reply.code(403).send({
        error: { code: 'TOKEN_NOT_CONSUMABLE', message: 'Token not consumable' },
      });
    }

    // ── Success: write audit log, update lastUsedAt, return bundle ────────────
    await writeAccessLog(true, null);
    // Update lastUsedAt — non-fatal if it fails (audit convenience, not security gate)
    await db.controlCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: now },
    }).catch(() => { /* non-fatal */ });

    // SECURITY: secretValue appears ONLY here in the HTTP response body (TLS).
    //           MUST NOT be written to logs, EventLog payloads, or WS fanout.
    return reply.code(200).send({
      consumed: true,
      action_id: actionId,
      session_id: sessionId,
      workroom_id: consumeWorkroomId,
      secret_bundle: {
        version: 1,
        items: [
          {
            key: credential.alias,
            value: secretValue,
            // inject kind: how subprocess consumes this item (env_var | file).
            // See CREDENTIAL_KIND_TO_INJECT mapping above.
            kind: credentialInjectKind(credential.kind),
          },
        ],
      },
    });
  });

  // ── RECONCILE ENDPOINT ─────────────────────────────────────────────────────

  /**
   * POST /api/v1/actions/:id/reconcile
   *
   * Report a daemon-detected unknown outcome for a fired action.
   * Transitions action to 'needs_human' if currently 'fired'.
   *
   * AUTH: machine_token + workroom/org guard + firing-machine binding
   *   (ControlActionToken[action_id].machine_id == authenticated machine.id)
   *   If no token row exists for the action: 403 (old data / anomaly — no reconcile allowed).
   *   machine_id is ALWAYS taken from the token row, NEVER from request body.
   *
   * BODY: { reason: enum, evidence_id: string }
   *   reason: controlled enum — fire_response_lost_token_unrecoverable | drain_deadline_exceeded
   *   evidence_id: stable daemon-generated file ID (e.g. UUID from evidence filename)
   *   FORBIDDEN fields: action_token, token_hash, secret, stdout, stack → 400 FORBIDDEN_FIELDS
   *
   * IDEMPOTENCY (per-evidence): same (action_id, evidence_id) → P2002 in transaction → 200 idempotent
   *   Different evidence IDs for same action are allowed (full audit trail).
   *
   * CAS: UPDATE control_actions WHERE id=:id AND status='fired' → status='needs_human'
   *   rowcount=1 → emit action.needs_human (locator + status + reason_code only; no free text)
   *   rowcount=0 → read current:
   *     needs_human → 200 idempotent (action already reconciled via different evidence)
   *     terminal    → 409 RECONCILE_TERMINAL_CONFLICT
   *
   * needs_human is NOT a product completion state. It means outcome unknown, human review needed.
   */
  app.post('/api/v1/actions/:id/reconcile', async (request, reply) => {
    // ── 1. Auth: machine_token ──
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: actionId } = request.params as { id: string };

    // ── 2. Body validation ──
    const body = request.body as Record<string, unknown>;

    // Reject forbidden fields: no raw token/secret/stdout in reconcile body (security boundary)
    const FORBIDDEN_FIELDS = ['action_token', 'token_hash', 'secret', 'stdout', 'stack'];
    const forbiddenPresent = FORBIDDEN_FIELDS.filter(f => f in body);
    if (forbiddenPresent.length > 0) {
      return reply.code(400).send({
        error: { code: 'FORBIDDEN_FIELDS', message: `Forbidden fields in body: ${forbiddenPresent.join(', ')}` },
      });
    }

    const { reason, evidence_id: evidenceId } = body as { reason?: string; evidence_id?: string };

    if (!reason || !evidenceId) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'reason and evidence_id are required' } });
    }

    const VALID_REASON_CODES = new Set([
      'fire_response_lost_token_unrecoverable',
      'drain_deadline_exceeded',
    ]);
    if (!VALID_REASON_CODES.has(reason)) {
      return reply.code(400).send({
        error: { code: 'INVALID_REASON_CODE', message: `reason must be one of: ${[...VALID_REASON_CODES].join(', ')}` },
      });
    }

    // ── 3. Fetch action ──
    const action = await db.controlAction.findUnique({ where: { id: actionId } });
    if (!action) {
      return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
    }

    // ── 4. Workroom/org access guard ──
    // No shortcut orgId override here: action has no orgId field, let requireMachineAccessToWorkroom
    // fetch the workroom from DB to get the authoritative orgId.
    const access = await requireMachineAccessToWorkroom(machine, action.workroomId);
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    // ── 5. Firing-machine guard ──
    // machine_id comes from ControlActionToken (bound at issuance), NEVER from request body.
    const tokenRecord = await db.controlActionToken.findFirst({ where: { actionId } });
    if (!tokenRecord) {
      // No token row: old data or anomaly — reconcile not allowed
      return reply.code(403).send({
        error: { code: 'RECONCILE_GUARD_FAILED', message: 'No token record for this action; reconcile not allowed' },
      });
    }
    if (tokenRecord.machineId !== machine.id) {
      return reply.code(403).send({
        error: { code: 'RECONCILE_FORBIDDEN', message: 'Machine is not the firing machine for this action' },
      });
    }

    // ── 6. Pre-check: hard terminal states ──
    if (HARD_TERMINAL_STATUSES.has(action.status)) {
      return reply.code(409).send({
        error: { code: 'RECONCILE_TERMINAL_CONFLICT', message: `Action is already in terminal state: ${action.status}` },
      });
    }
    // Action must have been fired to reconcile
    if (!['fired', 'needs_human'].includes(action.status)) {
      return reply.code(409).send({
        error: { code: 'RECONCILE_NOT_FIRED', message: `Action has not been fired (status: ${action.status}); cannot reconcile` },
      });
    }

    // ── 7. Transaction: CAS fired→needs_human THEN conditionally INSERT evidence ──
    //
    // ORDER IS CRITICAL: CAS before INSERT prevents orphan evidence rows.
    //
    // Scenario A (happy path): action is 'fired'
    //   → CAS count=1 → transition happened → INSERT evidence → 200
    //
    // Scenario B (race: action→terminal between pre-check and CAS):
    //   → CAS count=0 → status is terminal → NO evidence insert → 409
    //   (Pre-check caught the deterministic terminal case; this handles the race.)
    //
    // Scenario C (action already 'needs_human' — reconciled via different path):
    //   → CAS count=0 → status is needs_human → INSERT evidence (full audit trail)
    //   → P2002 on insert = same evidence_id = idempotent 200
    let casCount = 0;
    let casCurrentStatus: string | null = null;
    try {
      const txResult = await db.$transaction(async (tx) => {
        // Step 1: CAS — advance status only if currently 'fired'
        const cas = await tx.controlAction.updateMany({
          where: { id: actionId, status: 'fired' },
          data: { status: 'needs_human' },
        });

        if (cas.count === 1) {
          // Transition happened — insert evidence record
          await tx.controlActionReconciliation.create({
            data: {
              id: randomUUID(),
              actionId,
              evidenceId: evidenceId as string,
              reasonCode: reason,
              machineId: machine.id,            // bound from firing machine, NOT from body
            },
          });
          return { count: 1 as number, currentStatus: 'needs_human' };
        }

        // CAS count=0 — read current status inside the transaction
        const current = await tx.controlAction.findUnique({ where: { id: actionId }, select: { status: true } });
        const currentStatus = current?.status ?? null;

        if (currentStatus === 'needs_human') {
          // Already reconciled (different path) — insert evidence for full audit trail.
          // P2002 = same evidence_id already reported → idempotent (caught by outer catch).
          await tx.controlActionReconciliation.create({
            data: {
              id: randomUUID(),
              actionId,
              evidenceId: evidenceId as string,
              reasonCode: reason,
              machineId: machine.id,
            },
          });
        }
        // else: hard terminal race — DO NOT insert evidence (no orphan rows)

        return { count: 0 as number, currentStatus };
      });
      casCount = txResult.count;
      casCurrentStatus = txResult.currentStatus;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Same (action_id, evidence_id) already processed — idempotent 200
        const current = await db.controlAction.findUnique({ where: { id: actionId }, select: { status: true } });
        return reply.code(200).send({
          action_id: actionId,
          status: current?.status ?? 'unknown',
          idempotent: true,
        });
      }
      throw err;
    }

    // ── 8. Post-transaction: emit event if transition happened ──
    if (casCount === 1) {
      // Write-before-broadcast invariant: DB already committed above.
      // Event payload: locator + status + reason_code only. No free text, no credentials.
      await publishAndBroadcast({
        workroomId: action.workroomId,
        eventId: randomUUID(),
        topic: 'action.needs_human',
        payload: {
          workroom_id: action.workroomId,
          action_id: actionId,
          session_id: action.sessionId,
          status: 'needs_human',              // controlled enum
          reason_code: reason,                 // controlled enum
        },
      });

      return reply.code(200).send({
        action_id: actionId,
        status: 'needs_human',
        idempotent: false,
        reason_code: reason,
      });
    }

    // ── 9. CAS count=0 ──
    if (casCurrentStatus === 'needs_human') {
      // Already reconciled (via different evidence ID or path) — idempotent 200
      return reply.code(200).send({
        action_id: actionId,
        status: 'needs_human',
        idempotent: true,
      });
    }
    // Terminal race (fired→terminal between pre-check and CAS) — no evidence was inserted
    return reply.code(409).send({
      error: { code: 'RECONCILE_TERMINAL_CONFLICT', message: `Action status is ${casCurrentStatus ?? 'unknown'} — cannot reconcile` },
    });
  });

  // ── APPROVAL ENDPOINTS ──────────────────────────────────────────────────────

  /**
   * POST /api/v1/workrooms/:workroomId/approvals
   * Create an approval request (pre_action | disposal | artifact_review).
   */
  app.post('/api/v1/workrooms/:workroomId/approvals', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
    const body = request.body as {
      session_id?: string;
      task_id?: string;
      action_id?: string;
      artifact_id?: string;
      kind: string;
      risk_summary?: string;
      evidence_summary?: string;
      expires_at?: string;
    };

    if (!body.kind) {
      return reply.code(400).send({ error: { code: 'MISSING_KIND', message: 'kind is required' } });
    }

    const accessApproval = await requireMachineAccessToWorkroom(machine, workroomId);
    if (!accessApproval.ok) return reply.code(accessApproval.status).send({ error: accessApproval.error });

    const approval = await db.controlApproval.create({
      data: {
        workroomId,
        sessionId: body.session_id,
        taskId: body.task_id,
        actionId: body.action_id,
        artifactId: body.artifact_id,
        kind: body.kind,
        status: 'pending',
        riskSummary: body.risk_summary ?? '',
        evidenceSummary: body.evidence_summary ?? '',
        expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
      },
    });

    return reply.code(201).send({
      approval_id: approval.id,
      workroom_id: approval.workroomId,
      kind: approval.kind,
      status: approval.status,
      action_id: approval.actionId,
      expires_at: approval.expiresAt?.toISOString() ?? null,
      created_at: approval.createdAt.toISOString(),
    });
  });

  /**
   * GET /api/v1/approvals/:id
   */
  app.get('/api/v1/approvals/:id', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const approval = await db.controlApproval.findUnique({
      where: { id },
      include: { approvalConsumption: true, workroom: { select: { orgId: true } } },
    });
    if (!approval) {
      return reply.code(404).send({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found' } });
    }

    const accessApproval = await requireMachineAccessToWorkroom(machine, approval.workroomId, { orgId: approval.workroom.orgId });
    if (!accessApproval.ok) return reply.code(accessApproval.status).send({ error: accessApproval.error });

    return {
      approval_id: approval.id,
      workroom_id: approval.workroomId,
      kind: approval.kind,
      status: approval.status,
      action_id: approval.actionId,
      task_id: approval.taskId,
      artifact_id: approval.artifactId,
      reviewer_user_id: approval.reviewerUserId,
      risk_summary: approval.riskSummary,
      evidence_summary: approval.evidenceSummary,
      decided_at: approval.decidedAt?.toISOString() ?? null,
      expires_at: approval.expiresAt?.toISOString() ?? null,
      consumed: !!approval.approvalConsumption,
      created_at: approval.createdAt.toISOString(),
    };
  });

  /**
   * POST /api/v1/approvals/:id/decide
   * Human reviewer: approve | reject | snooze.
   * TODO: This endpoint will need human/user auth (not machine token) in production.
   *       For MVP, machine token auth is acceptable as a stub.
   */
  app.post('/api/v1/approvals/:id/decide', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: approvalId } = request.params as { id: string };
    const body = request.body as {
      decision: 'approved' | 'rejected' | 'snoozed';
      reviewer_user_id?: string;
      new_expires_at?: string;  // for snoozed
    };

    if (!body.decision || !['approved', 'rejected', 'snoozed'].includes(body.decision)) {
      return reply.code(400).send({
        error: { code: 'INVALID_DECISION', message: 'decision must be approved | rejected | snoozed' },
      });
    }

    const approval = await db.controlApproval.findUnique({
      where: { id: approvalId },
      include: { workroom: { select: { orgId: true } } },
    });
    if (!approval) {
      return reply.code(404).send({ error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval not found' } });
    }

    const accessApproval = await requireMachineAccessToWorkroom(machine, approval.workroomId, { orgId: approval.workroom.orgId });
    if (!accessApproval.ok) return reply.code(accessApproval.status).send({ error: accessApproval.error });

    if (approval.status !== 'pending' && approval.status !== 'snoozed') {
      return reply.code(409).send({
        error: {
          code: 'APPROVAL_NOT_DECIDABLE',
          message: `Approval is in state '${approval.status}' and cannot be decided`,
        },
      });
    }

    const now = new Date();
    const updated = await db.controlApproval.update({
      where: { id: approvalId },
      data: {
        status: body.decision,
        reviewerUserId: body.reviewer_user_id,
        decidedAt: body.decision !== 'snoozed' ? now : undefined,
        expiresAt: body.decision === 'snoozed' && body.new_expires_at
          ? new Date(body.new_expires_at)
          : undefined,
      },
    });

    // Emit approval.decided — locator + decision enum only; daemon re-queries before acting.
    // PAYLOAD CONTRACT: no free text, no reviewer identity, no risk details in broadcast.
    await publishAndBroadcast({
      workroomId: approval.workroomId,
      eventId: randomUUID(),
      topic: 'approval.decided',
      payload: {
        workroom_id: approval.workroomId,
        approval_id: updated.id,
        action_id: updated.actionId,                  // locator
        decision: updated.status,                     // controlled enum: 'approved' | 'rejected' | 'snoozed'
        decided_at: updated.decidedAt?.toISOString() ?? null,
      },
    });

    return {
      approval_id: updated.id,
      status: updated.status,
      decided_at: updated.decidedAt?.toISOString() ?? null,
      expires_at: updated.expiresAt?.toISOString() ?? null,
    };
  });
}

/**
 * Typed error thrown inside the fire transaction to signal a 409 conflict.
 * Caught outside the transaction so Prisma can roll back first.
 */
class FireConflictError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'FireConflictError';
  }
}
