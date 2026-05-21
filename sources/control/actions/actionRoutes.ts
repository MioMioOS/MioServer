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
 *   GET    /api/v1/actions/:id                    → get action
 *   PATCH  /api/v1/actions/:id                    → update non-terminal action
 *   POST   /api/v1/actions/:id/fire               → *** FIRE TRANSACTION (hard point) ***
 *   POST   /api/v1/actions/:id/cancel             → cancel action
 *
 *   POST   /api/v1/workrooms/:workroomId/approvals → create approval request
 *   GET    /api/v1/approvals/:id                  → get approval
 *   POST   /api/v1/approvals/:id/decide           → approve / reject / snooze
 */

import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { publishControlEvent, type ControlEventResult } from '@/control/events/publishControlEvent';
import { workroomBroadcaster } from '@/control/ws/workroomBroadcaster';

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
const TERMINAL_STATUSES = ['fired', 'canceled', 'failed', 'succeeded', 'transmission_complete'];

export async function actionRoutes(app: FastifyInstance) {
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
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const action = await db.controlAction.findUnique({
      where: { id },
      include: { approvalConsumption: true, workroom: { select: { orgId: true } } },
    });
    if (!action) {
      return reply.code(404).send({ error: { code: 'ACTION_NOT_FOUND', message: 'Action not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, action.workroomId, { orgId: action.workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

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
      const result = await db.controlAction.updateMany({
        where: {
          id: actionId,
          status: { notIn: TERMINAL_STATUSES },  // CAS: reject if already terminal
        },
        data: { status: 'fired', firedAt: now },
      });
      if (result.count === 0) {
        // Action transitioned to terminal between the earlier check and this update.
        const current = await db.controlAction.findUnique({ where: { id: actionId } });
        return reply.code(409).send({
          error: {
            code: 'ACTION_ALREADY_TERMINAL',
            message: `Action is already in terminal state: ${current?.status ?? 'unknown'}`,
          },
        });
      }

      // Emit action.status_changed — locator + status enum only. No free text, no credentials.
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

      return { action_id: actionId, fired: true, fired_at: now.toISOString() };
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

        return fired;
      });

      // Emit action.status_changed for irreversible_no_abort fire — after transaction commit.
      // Locator + status enum only. No free text, no credentials, no approval details in payload.
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

      return {
        action_id: firedAction.id,
        fired: true,
        fired_at: firedAction.firedAt?.toISOString(),
        approval_id,
        approved_at_snapshot: firedAction.approvedAtSnapshot?.toISOString() ?? null,
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
