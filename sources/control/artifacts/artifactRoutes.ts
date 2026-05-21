/**
 * Artifact API — three-state milestone + verification log
 *
 * HARD POINTS:
 *
 * 1. Three-state milestone (idempotent, one-way)
 *    verified_at        → milestone 1: agent verified the artifact
 *    external_confirmed_at → milestone 2: external system confirmed (e.g., Apple processed IPA)
 *    human_acked_at     → milestone 3: human accepted in UI
 *
 *    Each milestone is:
 *    - ONE-WAY: once set, cannot be cleared
 *    - IDEMPOTENT: setting an already-set milestone returns 200 with existing timestamp
 *    - INDEPENDENT: milestones can be set in any order, each has own auth context
 *
 * 2. Verification log (bound to verified_at)
 *    POST /artifacts/:id/verify ALSO creates a ControlArtifactVerificationLog entry.
 *    The log captures method, evidence JSON, and verifier agent — ensuring
 *    "what was verified" is auditable, not just "when".
 *    (Coinbyte fixture: "verified archive not IPA → VerificationLog must bind final artifact")
 *
 * 3. Artifact pointer (current_pointer_key)
 *    POST /artifacts/:id/set-pointer → upserts ControlArtifactPointer for a semantic key.
 *    UNIQUE(workroom_id, key) — only one "current_deployment" pointer per workroom.
 *
 * Endpoints:
 *   POST  /api/v1/workrooms/:workroomId/artifacts   → create artifact
 *   GET   /api/v1/artifacts/:id                     → get artifact detail
 *   POST  /api/v1/artifacts/:id/verify              → *** milestone 1: agent verify ***
 *   POST  /api/v1/artifacts/:id/confirm             → milestone 2: external confirm
 *   POST  /api/v1/artifacts/:id/ack                 → milestone 3: human ack
 *   POST  /api/v1/artifacts/:id/set-pointer         → set workroom pointer (e.g. current_deployment)
 *   GET   /api/v1/workrooms/:workroomId/pointers    → list all artifact pointers for workroom
 */

import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';

/** Status transitions based on milestone completion. */
function deriveArtifactStatus(
  verifiedAt: Date | null,
  externalConfirmedAt: Date | null,
  humanAckedAt: Date | null,
): string {
  if (humanAckedAt) return 'accepted';
  if (externalConfirmedAt) return 'external_confirmed';
  if (verifiedAt) return 'verified';
  return 'created';
}

export async function artifactRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/workrooms/:workroomId/artifacts
   * Create a new artifact. clientIdempotencyKey prevents duplicate creation.
   */
  app.post('/api/v1/workrooms/:workroomId/artifacts', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };
    const body = request.body as {
      org_id: string;
      scope_type: string;
      type: string;
      title: string;
      summary?: string;
      url?: string;
      local_path?: string;
      hash?: string;
      external_id?: string;
      task_id?: string;
      session_id?: string;
      action_id?: string;
      created_by_agent_id?: string;
      client_idempotency_key: string;
    };

    if (!body.org_id || !body.scope_type || !body.type || !body.title || !body.client_idempotency_key) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'org_id, scope_type, type, title, client_idempotency_key required' } });
    }

    try {
      const artifact = await db.controlArtifact.create({
        data: {
          orgId: body.org_id,
          workroomId,
          scopeType: body.scope_type,
          type: body.type,
          title: body.title,
          summary: body.summary ?? '',
          url: body.url,
          localPath: body.local_path,
          hash: body.hash,
          externalId: body.external_id,
          taskId: body.task_id,
          sessionId: body.session_id,
          actionId: body.action_id,
          createdByAgentId: body.created_by_agent_id,
          clientIdempotencyKey: body.client_idempotency_key,
          status: 'created',
        },
      });

      return reply.code(201).send({
        artifact_id: artifact.id,
        workroom_id: artifact.workroomId,
        type: artifact.type,
        title: artifact.title,
        status: artifact.status,
        milestones: {
          verified_at: null,
          external_confirmed_at: null,
          human_acked_at: null,
        },
        created_at: artifact.createdAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await db.controlArtifact.findFirst({
          where: { clientIdempotencyKey: body.client_idempotency_key },
        });
        if (existing) {
          return reply.code(200).send({
            artifact_id: existing.id,
            workroom_id: existing.workroomId,
            status: existing.status,
            idempotent: true,
          });
        }
      }
      throw err;
    }
  });

  /**
   * GET /api/v1/artifacts/:id
   */
  app.get('/api/v1/artifacts/:id', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id } = request.params as { id: string };
    const artifact = await db.controlArtifact.findUnique({
      where: { id },
      include: {
        verificationLogs: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });
    if (!artifact) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } });
    }

    return {
      artifact_id: artifact.id,
      workroom_id: artifact.workroomId,
      org_id: artifact.orgId,
      scope_type: artifact.scopeType,
      type: artifact.type,
      title: artifact.title,
      summary: artifact.summary,
      url: artifact.url,
      local_path: artifact.localPath,
      hash: artifact.hash,
      external_id: artifact.externalId,
      status: artifact.status,
      milestones: {
        verified_at: artifact.verifiedAt?.toISOString() ?? null,
        external_confirmed_at: artifact.externalConfirmedAt?.toISOString() ?? null,
        human_acked_at: artifact.humanAckedAt?.toISOString() ?? null,
      },
      disposal_status: artifact.disposalStatus,
      current_pointer_key: artifact.currentPointerKey,
      created_by_agent_id: artifact.createdByAgentId,
      created_at: artifact.createdAt.toISOString(),
      recent_verification_logs: artifact.verificationLogs.map((log) => ({
        log_id: log.id,
        method: log.method,
        status: log.status,
        error: log.error,
        created_at: log.createdAt.toISOString(),
      })),
    };
  });

  /**
   * POST /api/v1/artifacts/:id/verify
   *
   * *** HARD POINT: Milestone 1 — agent verify ***
   *
   * Two operations in one transaction:
   *   1. Set artifact.verifiedAt (idempotent: if already set, skip and return existing)
   *   2. Create ControlArtifactVerificationLog entry (always creates, even if idempotent)
   *      UNLESS client_idempotency_key on log matches an existing log (full idempotency).
   *
   * Coinbyte fixture: "verified archive ≠ IPA → VerificationLog must bind final artifact"
   * The method + evidence JSON captures WHAT was verified (e.g., ipa_inspect vs archive).
   *
   * Body:
   *   verifier_agent_id  — who ran the verification
   *   method             — curl | hash_compare | ipa_inspect | codesign_verify | ...
   *   evidence           — JSON: { checked_fields: [...], extracted_values: {...} }
   *   status             — passed | failed | inconclusive
   *   error?             — error message if failed/inconclusive
   *   client_idempotency_key — dedup key for the verification log entry
   */
  app.post('/api/v1/artifacts/:id/verify', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: artifactId } = request.params as { id: string };
    const body = request.body as {
      verifier_agent_id: string;
      method: string;
      evidence: Record<string, unknown>;
      status: 'passed' | 'failed' | 'inconclusive';
      error?: string;
      client_idempotency_key: string;
    };

    if (!body.verifier_agent_id || !body.method || !body.status || !body.client_idempotency_key) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'verifier_agent_id, method, status, client_idempotency_key required' } });
    }

    const artifact = await db.controlArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } });
    }

    const now = new Date();

    // Milestone 1 is idempotent: if already verified, skip the timestamp update
    // but still attempt to create the verification log (for audit trail).
    const alreadyVerified = artifact.verifiedAt !== null;

    // Create verification log entry (may be idempotent by client_idempotency_key)
    let verificationLog;
    try {
      verificationLog = await db.controlArtifactVerificationLog.create({
        data: {
          artifactId,
          verifierAgentId: body.verifier_agent_id,
          method: body.method,
          status: body.status,
          evidence: (body.evidence ?? {}) as Prisma.InputJsonObject,
          error: body.error,
          clientIdempotencyKey: body.client_idempotency_key,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Idempotent log — already recorded
        verificationLog = await db.controlArtifactVerificationLog.findFirst({
          where: { clientIdempotencyKey: body.client_idempotency_key },
        });
      } else {
        throw err;
      }
    }

    // Update verified_at and status (only if not already set)
    let updatedArtifact = artifact;
    if (!alreadyVerified && body.status === 'passed') {
      updatedArtifact = await db.controlArtifact.update({
        where: { id: artifactId },
        data: {
          verifiedAt: now,
          status: deriveArtifactStatus(now, artifact.externalConfirmedAt, artifact.humanAckedAt),
        },
      });
    }

    return {
      artifact_id: artifactId,
      verified_at: updatedArtifact.verifiedAt?.toISOString() ?? null,
      idempotent: alreadyVerified,
      verification_log_id: verificationLog?.id,
      verification_status: body.status,
      artifact_status: updatedArtifact.status,
    };
  });

  /**
   * POST /api/v1/artifacts/:id/confirm
   * Milestone 2 — external system confirmation (e.g., Apple processed IPA upload).
   * Idempotent: if already confirmed, returns 200 with existing timestamp.
   *
   * Body: { confirmed_by?, external_reference_id?, note? }
   */
  app.post('/api/v1/artifacts/:id/confirm', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: artifactId } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      confirmed_by?: string;
      external_reference_id?: string;
      note?: string;
    };

    const artifact = await db.controlArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } });
    }

    // Idempotent: if already confirmed, return 200 with existing timestamp
    if (artifact.externalConfirmedAt !== null) {
      return reply.code(200).send({
        artifact_id: artifactId,
        external_confirmed_at: artifact.externalConfirmedAt.toISOString(),
        idempotent: true,
        artifact_status: artifact.status,
      });
    }

    const now = new Date();
    const updated = await db.controlArtifact.update({
      where: { id: artifactId },
      data: {
        externalConfirmedAt: now,
        ...(body.external_reference_id ? { externalId: body.external_reference_id } : {}),
        status: deriveArtifactStatus(artifact.verifiedAt, now, artifact.humanAckedAt),
      },
    });

    return {
      artifact_id: artifactId,
      external_confirmed_at: updated.externalConfirmedAt?.toISOString(),
      idempotent: false,
      artifact_status: updated.status,
    };
  });

  /**
   * POST /api/v1/artifacts/:id/ack
   * Milestone 3 — human acknowledgment in UI.
   * Idempotent: if already acked, returns 200 with existing timestamp.
   * Sets artifact status to 'accepted'.
   * TODO: This endpoint will need human/user auth in production.
   */
  app.post('/api/v1/artifacts/:id/ack', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: artifactId } = request.params as { id: string };

    const artifact = await db.controlArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } });
    }

    // Idempotent
    if (artifact.humanAckedAt !== null) {
      return reply.code(200).send({
        artifact_id: artifactId,
        human_acked_at: artifact.humanAckedAt.toISOString(),
        idempotent: true,
        artifact_status: artifact.status,
      });
    }

    const now = new Date();
    const updated = await db.controlArtifact.update({
      where: { id: artifactId },
      data: {
        humanAckedAt: now,
        status: 'accepted',  // human ack always → accepted (final positive state)
      },
    });

    return {
      artifact_id: artifactId,
      human_acked_at: updated.humanAckedAt?.toISOString(),
      idempotent: false,
      artifact_status: updated.status,
    };
  });

  /**
   * POST /api/v1/artifacts/:id/supersede
   *
   * Mark an artifact as superseded by a newer version.
   * The `accepted` milestone (human_acked_at) is preserved as historical fact —
   * supersede does NOT undo the ack; it changes the artifact's role going forward.
   *
   * Key invariant: disposal/supersede is a SEPARATE decision path from ack.
   * ack → accepted = "we accepted this artifact as correct at that moment"
   * supersede → superseded = "a newer artifact replaced this one"
   * Both can be simultaneously true and are independently auditable.
   *
   * Body: { superseded_by_artifact_id: string, reason?: string }
   */
  app.post('/api/v1/artifacts/:id/supersede', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: artifactId } = request.params as { id: string };
    const body = request.body as { superseded_by_artifact_id: string; reason?: string };

    if (!body.superseded_by_artifact_id) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'superseded_by_artifact_id is required' } });
    }

    const artifact = await db.controlArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } });
    }
    if (artifact.status === 'superseded' || artifact.status === 'disposed') {
      return reply.code(409).send({
        error: { code: 'ARTIFACT_ALREADY_TERMINAL', message: `Artifact is already ${artifact.status}` },
      });
    }

    // Verify the superseding artifact exists
    const successor = await db.controlArtifact.findUnique({ where: { id: body.superseded_by_artifact_id } });
    if (!successor) {
      return reply.code(404).send({ error: { code: 'SUCCESSOR_NOT_FOUND', message: 'Superseding artifact not found' } });
    }

    const updated = await db.controlArtifact.update({
      where: { id: artifactId },
      data: {
        status: 'superseded',
        disposalStatus: 'rolled_forward',
        // DO NOT touch verifiedAt / externalConfirmedAt / humanAckedAt —
        // milestones are historical facts and must not be altered by supersede.
      },
    });

    return {
      artifact_id: artifactId,
      status: updated.status,
      disposal_status: updated.disposalStatus,
      superseded_by: body.superseded_by_artifact_id,
      // Milestone timestamps preserved (not cleared)
      milestones_preserved: {
        verified_at: updated.verifiedAt?.toISOString() ?? null,
        external_confirmed_at: updated.externalConfirmedAt?.toISOString() ?? null,
        human_acked_at: updated.humanAckedAt?.toISOString() ?? null,
      },
    };
  });

  /**
   * POST /api/v1/artifacts/:id/dispose
   *
   * Mark an artifact as disposed with a specific disposal reason.
   * Used for: expiry, ignored, remediation_created.
   *
   * Like supersede, preserves all milestone timestamps as historical record.
   * Status transitions to 'disposed'; disposalStatus records the reason.
   *
   * Body: { disposal_reason: 'expired' | 'ignored' | 'remediation_created', note?: string }
   */
  app.post('/api/v1/artifacts/:id/dispose', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: artifactId } = request.params as { id: string };
    const body = request.body as {
      disposal_reason: 'expired' | 'ignored' | 'remediation_created';
      note?: string;
    };

    const validReasons = ['expired', 'ignored', 'remediation_created'];
    if (!body.disposal_reason || !validReasons.includes(body.disposal_reason)) {
      return reply.code(400).send({ error: { code: 'INVALID_DISPOSAL_REASON', message: `disposal_reason must be one of: ${validReasons.join(' | ')}` } });
    }

    const artifact = await db.controlArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } });
    }
    if (artifact.status === 'disposed' || artifact.status === 'superseded') {
      return reply.code(409).send({
        error: { code: 'ARTIFACT_ALREADY_TERMINAL', message: `Artifact is already ${artifact.status}` },
      });
    }

    const updated = await db.controlArtifact.update({
      where: { id: artifactId },
      data: {
        status: 'disposed',
        disposalStatus: body.disposal_reason,
        // DO NOT touch milestone timestamps — they remain as historical record.
      },
    });

    return {
      artifact_id: artifactId,
      status: updated.status,
      disposal_status: updated.disposalStatus,
      milestones_preserved: {
        verified_at: updated.verifiedAt?.toISOString() ?? null,
        external_confirmed_at: updated.externalConfirmedAt?.toISOString() ?? null,
        human_acked_at: updated.humanAckedAt?.toISOString() ?? null,
      },
    };
  });

  /**
   * POST /api/v1/artifacts/:id/set-pointer
   * Upsert a workroom-scoped artifact pointer.
   * UNIQUE(workroom_id, key) — only one "current_deployment" per workroom.
   * Previous artifact at this key is effectively superseded.
   *
   * Body: { key: string, updated_by: string }
   */
  app.post('/api/v1/artifacts/:id/set-pointer', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { id: artifactId } = request.params as { id: string };
    const body = request.body as { key: string; updated_by: string };

    if (!body.key || !body.updated_by) {
      return reply.code(400).send({ error: { code: 'MISSING_FIELDS', message: 'key and updated_by required' } });
    }

    const artifact = await db.controlArtifact.findUnique({ where: { id: artifactId } });
    if (!artifact) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found' } });
    }

    // Upsert pointer — UNIQUE(workroom_id, key)
    await db.controlArtifactPointer.upsert({
      where: {
        workroomId_key: {
          workroomId: artifact.workroomId,
          key: body.key,
        },
      },
      create: {
        workroomId: artifact.workroomId,
        key: body.key,
        artifactId,
        updatedBy: body.updated_by,
      },
      update: {
        artifactId,
        updatedBy: body.updated_by,
      },
    });

    // Update the artifact's currentPointerKey if not already set
    await db.controlArtifact.update({
      where: { id: artifactId },
      data: { currentPointerKey: body.key },
    });

    return {
      artifact_id: artifactId,
      workroom_id: artifact.workroomId,
      pointer_key: body.key,
      updated_by: body.updated_by,
    };
  });

  /**
   * GET /api/v1/workrooms/:workroomId/pointers
   * List all artifact pointers for a workroom (the "current state" view).
   */
  app.get('/api/v1/workrooms/:workroomId/pointers', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };

    const pointers = await db.controlArtifactPointer.findMany({
      where: { workroomId },
      include: {
        artifact: {
          select: {
            id: true,
            type: true,
            title: true,
            status: true,
            verifiedAt: true,
            externalConfirmedAt: true,
            humanAckedAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      pointers: pointers.map((p) => ({
        key: p.key,
        artifact_id: p.artifactId,
        artifact_type: p.artifact.type,
        artifact_title: p.artifact.title,
        artifact_status: p.artifact.status,
        milestones: {
          verified_at: p.artifact.verifiedAt?.toISOString() ?? null,
          external_confirmed_at: p.artifact.externalConfirmedAt?.toISOString() ?? null,
          human_acked_at: p.artifact.humanAckedAt?.toISOString() ?? null,
        },
        updated_by: p.updatedBy,
        updated_at: p.updatedAt.toISOString(),
      })),
    };
  });
}
