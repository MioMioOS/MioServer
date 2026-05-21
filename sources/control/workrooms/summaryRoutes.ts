/**
 * WorkroomSummary API — structured-state-only generation.
 *
 * HARD CONSTRAINTS (enforced in summaryLogic.ts):
 * 1. Summaries are derived ONLY from structured DB fields.
 *    ControlMessage (chat text) is NEVER queried.
 * 2. headline MUST NOT say "完成" unless humanAckedAt is set on all active artifacts.
 *    Intermediate milestone states are expressed explicitly.
 * 3. Artifact milestone timestamps are the canonical source; `status` field is secondary.
 *
 * Endpoints:
 *   POST /api/v1/workrooms/:workroomId/summary/generate  → compute from live DB state + persist
 *   GET  /api/v1/workrooms/:workroomId/summary           → get latest persisted summary (no recompute)
 */

import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { computeWorkroomSummary, SummaryInputs } from './summaryLogic';

export async function summaryRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/workrooms/:workroomId/summary/generate
   *
   * Reads structured state from DB, computes summary fields via summaryLogic,
   * persists a new ControlWorkroomSummary row, returns it.
   *
   * Chat text is NEVER read. ControlMessage is NOT queried here.
   */
  app.post('/api/v1/workrooms/:workroomId/summary/generate', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };

    // ── 1. Load workroom ─────────────────────────────────────────────────────
    const workroom = await db.controlWorkroom.findUnique({ where: { id: workroomId } });
    if (!workroom) {
      return reply.code(404).send({ error: { code: 'WORKROOM_NOT_FOUND', message: 'Workroom not found' } });
    }

    const access = await requireMachineAccessToWorkroom(machine, workroomId, { orgId: workroom.orgId });
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    // ── 2. Resolve current goal title (optional) ─────────────────────────────
    let currentGoalTitle: string | undefined;
    if (workroom.currentGoalId) {
      const goal = await db.controlGoal.findUnique({
        where: { id: workroom.currentGoalId },
        select: { title: true },
      });
      currentGoalTitle = goal?.title;
    }

    // ── 3. Task status counts ─────────────────────────────────────────────────
    // Grouped by status — no chat text read, just status fields.
    const taskGroups = await db.controlTask.groupBy({
      by: ['status'],
      where: { workroomId },
      _count: { _all: true },
    });
    const taskCounts = {
      todo: 0, in_progress: 0, waiting_approval: 0, in_review: 0, done: 0, canceled: 0,
    };
    for (const g of taskGroups) {
      const s = g.status as keyof typeof taskCounts;
      if (s in taskCounts) taskCounts[s] = g._count._all;
    }

    // ── 4. Active actions (not terminal) ─────────────────────────────────────
    const TERMINAL_ACTION_STATUSES = ['succeeded', 'failed', 'canceled', 'rejected'];
    const activeActions = await db.controlAction.findMany({
      where: { workroomId, status: { notIn: TERMINAL_ACTION_STATUSES } },
      select: { id: true, kind: true, summary: true, status: true, reversibility: true, actorAgentId: true },
    });

    // ── 5. Artifacts in this workroom (active — not disposed/superseded) ──────
    // We query all artifacts and filter disposed in logic layer.
    const artifacts = await db.controlArtifact.findMany({
      where: { workroomId },
      select: {
        id: true, type: true, title: true, status: true,
        verifiedAt: true, externalConfirmedAt: true, humanAckedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // ── 6. Pending approvals ──────────────────────────────────────────────────
    const pendingApprovals = await db.controlApproval.findMany({
      where: { workroomId, status: 'pending' },
      select: { id: true, actionId: true, artifactId: true, kind: true, riskSummary: true },
    });

    // ── 7. Latest artifact IDs (from pointers) ───────────────────────────────
    const pointers = await db.controlArtifactPointer.findMany({
      where: { workroomId },
      select: { artifactId: true },
    });
    const latestArtifactIds = pointers.map(p => p.artifactId);

    // ── 8. Agent ownership counts ─────────────────────────────────────────────
    // Task counts per owner (excluding done/canceled)
    const taskOwnerGroups = await db.controlTask.groupBy({
      by: ['ownerInstanceId'],
      where: {
        workroomId,
        ownerInstanceId: { not: null },
        status: { notIn: ['done', 'canceled'] },
      },
      _count: { _all: true },
    });
    // Action counts per actor (active only)
    const actionActorGroups = await db.controlAction.groupBy({
      by: ['actorAgentId'],
      where: { workroomId, status: { notIn: TERMINAL_ACTION_STATUSES } },
      _count: { _all: true },
    });

    const agentOwnershipMap = new Map<string, { taskCount: number; actionCount: number }>();
    for (const g of taskOwnerGroups) {
      if (!g.ownerInstanceId) continue;
      const entry = agentOwnershipMap.get(g.ownerInstanceId) ?? { taskCount: 0, actionCount: 0 };
      entry.taskCount = g._count._all;
      agentOwnershipMap.set(g.ownerInstanceId, entry);
    }
    for (const g of actionActorGroups) {
      const entry = agentOwnershipMap.get(g.actorAgentId) ?? { taskCount: 0, actionCount: 0 };
      entry.actionCount = g._count._all;
      agentOwnershipMap.set(g.actorAgentId, entry);
    }
    const agentOwnership = Array.from(agentOwnershipMap.entries()).map(([agentId, counts]) => ({
      agentId,
      ...counts,
    }));

    // ── 9. Compute summary (pure logic, no DB) ────────────────────────────────
    const summaryInputs: SummaryInputs = {
      workroomName: workroom.name,
      currentGoalTitle,
      taskCounts,
      activeActions,
      artifacts,
      pendingApprovals: pendingApprovals.map(a => ({
        id: a.id,
        actionId: a.actionId,
        artifactId: a.artifactId,
        kind: a.kind,
        riskSummary: a.riskSummary,
      })),
      agentOwnership,
    };
    const computed = computeWorkroomSummary(summaryInputs);

    // ── 10. Persist ───────────────────────────────────────────────────────────
    const summary = await db.controlWorkroomSummary.create({
      data: {
        workroomId,
        goalId: workroom.currentGoalId ?? undefined,
        headline: computed.headline,
        currentPhase: computed.currentPhase,
        activeOwnerSummary: computed.activeOwnerSummary,
        needsAttentionCount: computed.needsAttentionCount,
        latestArtifactIds,
        blockedItems: computed.blockedItems as unknown as Prisma.InputJsonValue,
        nextRecommendedAction: computed.nextRecommendedAction,
      },
    });

    return reply.code(201).send({
      id: summary.id,
      workroom_id: summary.workroomId,
      goal_id: summary.goalId,
      headline: summary.headline,
      current_phase: summary.currentPhase,
      active_owner_summary: summary.activeOwnerSummary,
      needs_attention_count: summary.needsAttentionCount,
      latest_artifact_ids: summary.latestArtifactIds,
      blocked_items: summary.blockedItems,
      next_recommended_action: summary.nextRecommendedAction,
      generated_at: summary.generatedAt.toISOString(),
    });
  });

  /**
   * GET /api/v1/workrooms/:workroomId/summary
   * Returns the most recently generated summary for this workroom.
   * Does NOT recompute — call /generate first to get fresh data.
   */
  app.get('/api/v1/workrooms/:workroomId/summary', async (request, reply) => {
    const machine = await verifyMachineToken(request.headers.authorization);
    if (!machine) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired machine token' } });
    }

    const { workroomId } = request.params as { workroomId: string };

    const access = await requireMachineAccessToWorkroom(machine, workroomId);
    if (!access.ok) return reply.code(access.status).send({ error: access.error });

    const summary = await db.controlWorkroomSummary.findFirst({
      where: { workroomId },
      orderBy: { generatedAt: 'desc' },
    });

    if (!summary) {
      return reply.code(404).send({
        error: { code: 'SUMMARY_NOT_FOUND', message: 'No summary generated yet for this workroom. Call POST /summary/generate first.' },
      });
    }

    return {
      id: summary.id,
      workroom_id: summary.workroomId,
      goal_id: summary.goalId,
      headline: summary.headline,
      current_phase: summary.currentPhase,
      active_owner_summary: summary.activeOwnerSummary,
      needs_attention_count: summary.needsAttentionCount,
      latest_artifact_ids: summary.latestArtifactIds,
      blocked_items: summary.blockedItems,
      next_recommended_action: summary.nextRecommendedAction,
      generated_at: summary.generatedAt.toISOString(),
    };
  });
}
