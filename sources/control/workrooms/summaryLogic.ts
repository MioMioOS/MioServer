/**
 * WorkroomSummary logic — pure functions, no DB access.
 *
 * HARD CONSTRAINTS enforced here:
 * 1. All inputs come from structured DB fields only.
 *    Chat text (ControlMessage) is NEVER read.
 * 2. headline MUST NOT contain "完成" / "done" unless humanAckedAt is set.
 *    Intermediate states must be expressed explicitly.
 * 3. Artifact milestone state is the canonical source for phase + headline.
 *    External confirmation alone (externalConfirmedAt only) does NOT mean done.
 */

import { SUMMARY_EXECUTING_STATUSES } from '../actionStatusSets.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArtifactMilestones {
  id: string;
  type: string;
  title: string;
  status: string;          // created | verified | external_confirmed | accepted | superseded | disposed | ...
  verifiedAt: Date | null;
  externalConfirmedAt: Date | null;
  humanAckedAt: Date | null;
}

export type ArtifactCompletionState =
  | 'pending_verify'         // not yet agent-verified
  | 'pending_external'       // verified by agent, waiting external system
  | 'pending_human_ack'      // external confirmed, waiting human review
  | 'accepted'               // all 3 milestones — truly done
  | 'disposed';              // superseded / disposed — no longer active

export interface TaskCounts {
  todo: number;
  in_progress: number;
  waiting_approval: number;
  in_review: number;
  done: number;
  canceled: number;
}

export interface ActiveAction {
  id: string;
  kind: string;
  summary: string;
  status: string;
  reversibility: string;
  actorAgentId: string;
}

export interface PendingApproval {
  id: string;
  actionId: string | null;
  artifactId: string | null;
  kind: string;
  riskSummary: string;
}

export interface BlockedItem {
  type: 'approval_pending' | 'artifact_awaiting_ack' | 'task_waiting_approval' | 'action_needs_human';
  id: string;
  label: string;
  detail?: string;
}

export interface SummaryInputs {
  workroomName: string;
  currentGoalTitle?: string;
  taskCounts: TaskCounts;
  activeActions: ActiveAction[];
  artifacts: ArtifactMilestones[];
  pendingApprovals: PendingApproval[];
  agentOwnership: Array<{ agentId: string; taskCount: number; actionCount: number }>;
}

export interface SummaryOutput {
  headline: string;
  currentPhase: string;
  activeOwnerSummary: Record<string, { taskCount: number; actionCount: number }>;
  needsAttentionCount: number;
  blockedItems: BlockedItem[];
  nextRecommendedAction: string;
}

// ─── Artifact state logic ─────────────────────────────────────────────────────

/**
 * Derive the completion state of a single artifact from its three milestone timestamps.
 * This is the canonical source of truth — status field is secondary.
 */
export function deriveArtifactCompletionState(a: ArtifactMilestones): ArtifactCompletionState {
  if (a.status === 'superseded' || a.status === 'disposed' || a.status === 'ignored' || a.status === 'rolled_forward') {
    return 'disposed';
  }
  if (a.humanAckedAt) return 'accepted';
  if (a.externalConfirmedAt) return 'pending_human_ack';
  if (a.verifiedAt) return 'pending_external';
  return 'pending_verify';
}

/**
 * Produce a human-readable milestone label for an artifact.
 *
 * RULE: NEVER produce a label that implies completion unless humanAckedAt is set.
 * Artifact-type-specific strings are used for well-known publish types.
 */
export function deriveArtifactLabel(a: ArtifactMilestones): string {
  const state = deriveArtifactCompletionState(a);
  const title = a.title;

  // Publish-type artifacts: ipa_upload, deployment_url
  // These have domain-specific intermediate labels per PM requirement.
  if (a.type === 'ipa_upload') {
    switch (state) {
      case 'pending_verify':    return `${title}：等待本地验证`;
      case 'pending_external':  return `${title}：已上传并本地验证，等待 Apple 处理`;
      case 'pending_human_ack': return `${title}：TestFlight 已可见，等待人工确认`;
      case 'accepted':          return `${title}：发布确认完成`;
      case 'disposed':          return `${title}（已废弃）`;
    }
  }

  if (a.type === 'deployment_url') {
    switch (state) {
      case 'pending_verify':    return `${title}：部署进行中，等待验证`;
      case 'pending_external':  return `${title}：本地验证通过，等待外部确认`;
      case 'pending_human_ack': return `${title}：部署已确认，等待人工审核`;
      case 'accepted':          return `${title}：部署完成`;
      case 'disposed':          return `${title}（已废弃）`;
    }
  }

  // Generic fallback
  switch (state) {
    case 'pending_verify':    return `${title}：等待验证`;
    case 'pending_external':  return `${title}：已本地验证，等待外部确认`;
    case 'pending_human_ack': return `${title}：外部已确认，等待人工审核`;
    case 'accepted':          return `${title}：已确认完成`;
    case 'disposed':          return `${title}（已废弃）`;
  }
}

// ─── Phase and headline derivation ───────────────────────────────────────────

/**
 * Derive the workroom's current phase from task + action + artifact state.
 * Phase is a concise string describing the primary work mode right now.
 *
 * Priority (highest → lowest):
 *   1. Any action in needs_human → blocked_needs_human
 *   2. Any approval pending → waiting_approval
 *   3. Any artifact in pending_human_ack → waiting_review
 *   4. Any artifact in pending_external → waiting_external
 *   5. Any action in fired/transmission_complete/reconciling → executing
 *   6. Any task in_progress → in_progress
 *   7. All active tasks done → complete (only if artifacts all accepted)
 *   8. No tasks → planning
 */
export function deriveCurrentPhase(inputs: Pick<SummaryInputs, 'taskCounts' | 'activeActions' | 'artifacts' | 'pendingApprovals'>): string {
  const { taskCounts, activeActions, artifacts, pendingApprovals } = inputs;

  // Active artifacts only (not disposed)
  const activeArtifacts = artifacts.filter(a => deriveArtifactCompletionState(a) !== 'disposed');

  if (activeActions.some(a => a.status === 'needs_human')) {
    return 'blocked_needs_human';
  }
  if (pendingApprovals.length > 0) {
    return 'waiting_approval';
  }
  if (activeArtifacts.some(a => deriveArtifactCompletionState(a) === 'pending_human_ack')) {
    return 'waiting_review';
  }
  if (activeArtifacts.some(a => deriveArtifactCompletionState(a) === 'pending_external')) {
    return 'waiting_external';
  }
  if (activeActions.some(a => (SUMMARY_EXECUTING_STATUSES as readonly string[]).includes(a.status))) {
    return 'executing';
  }
  if (taskCounts.in_progress > 0 || taskCounts.in_review > 0) {
    return 'in_progress';
  }

  const totalActive = taskCounts.todo + taskCounts.in_progress + taskCounts.waiting_approval
    + taskCounts.in_review;
  const allTasksDone = totalActive === 0 && taskCounts.done > 0;

  // Only "complete" if all 3 milestones set on all active artifacts
  const allArtifactsAccepted = activeArtifacts.length === 0
    || activeArtifacts.every(a => deriveArtifactCompletionState(a) === 'accepted');

  if (allTasksDone && allArtifactsAccepted) {
    return 'complete';
  }

  if (taskCounts.todo > 0) return 'planning';
  return 'idle';
}

/**
 * Derive the workroom headline from structured state.
 *
 * RULE: headline MUST NOT use "完成" / "done" unless:
 *   - currentPhase === 'complete', AND
 *   - ALL active artifacts have humanAckedAt set.
 *
 * The headline picks the most urgent active artifact's label,
 * then prepends task progress context.
 */
export function deriveHeadline(inputs: SummaryInputs, phase: string): string {
  const { workroomName, currentGoalTitle, taskCounts, artifacts, activeActions } = inputs;

  const totalTasks = taskCounts.todo + taskCounts.in_progress + taskCounts.waiting_approval
    + taskCounts.in_review + taskCounts.done + taskCounts.canceled;
  const activeTasks = taskCounts.todo + taskCounts.in_progress + taskCounts.waiting_approval
    + taskCounts.in_review;

  // Task progress context — use "进度 X/Y" NOT "完成" here,
  // so "完成" in the headline appears ONLY when phase === 'complete'.
  const taskContext = totalTasks > 0
    ? `进度 ${taskCounts.done}/${totalTasks}`
    : null;

  // Find the most urgent active artifact (priority: pending_human_ack > pending_external > pending_verify)
  const activeArtifacts = artifacts.filter(a => deriveArtifactCompletionState(a) !== 'disposed' && deriveArtifactCompletionState(a) !== 'accepted');
  const priorityOrder: ArtifactCompletionState[] = ['pending_human_ack', 'pending_external', 'pending_verify'];
  let focusArtifact: ArtifactMilestones | undefined;
  for (const priority of priorityOrder) {
    focusArtifact = activeArtifacts.find(a => deriveArtifactCompletionState(a) === priority);
    if (focusArtifact) break;
  }

  if (phase === 'complete') {
    const goal = currentGoalTitle || workroomName;
    // "完成" only appears here — this is the ONLY legitimate use.
    return taskContext ? `${goal} — 所有产物已确认完成（${taskContext}）` : `${goal} — 所有任务和产物已确认完成`;
  }

  if (phase === 'blocked_needs_human') {
    const action = activeActions.find(a => a.status === 'needs_human');
    return `⚠ 等待人工介入：${action?.summary ?? '操作需要人工处理'}`;
  }

  if (phase === 'waiting_approval') {
    const count = inputs.pendingApprovals.length;
    return `等待审批（${count} 条待确认）${taskContext ? `，${taskContext}` : ''}`;
  }

  if (focusArtifact) {
    const artifactLabel = deriveArtifactLabel(focusArtifact);
    return taskContext ? `${artifactLabel}，${taskContext}` : artifactLabel;
  }

  if (phase === 'executing') {
    const action = activeActions.find(a => (SUMMARY_EXECUTING_STATUSES as readonly string[]).includes(a.status));
    return `执行中：${action?.summary ?? '操作进行中'}${taskContext ? `，${taskContext}` : ''}`;
  }

  if (phase === 'in_progress') {
    const goal = currentGoalTitle || workroomName;
    return taskContext ? `${goal} — ${taskContext}，任务进行中` : `${goal} — 任务进行中`;
  }

  // idle / planning
  const goal = currentGoalTitle || workroomName;
  return taskContext ? `${goal} — ${taskContext}` : `${goal} — 准备中`;
}

/**
 * Derive the list of items that need human attention.
 * These populate blockedItems[] and drive needsAttentionCount.
 */
export function deriveBlockedItems(inputs: SummaryInputs): BlockedItem[] {
  const items: BlockedItem[] = [];

  // Pending approvals need human decision
  for (const approval of inputs.pendingApprovals) {
    items.push({
      type: 'approval_pending',
      id: approval.id,
      label: `等待审批：${approval.riskSummary || '操作需要审批'}`,
      detail: approval.actionId ?? undefined,
    });
  }

  // Actions in needs_human status
  for (const action of inputs.activeActions) {
    if (action.status === 'needs_human') {
      items.push({
        type: 'action_needs_human',
        id: action.id,
        label: `操作需要人工介入：${action.summary}`,
        detail: action.kind,
      });
    }
  }

  // Artifacts awaiting human ack (external confirmed but not yet human-reviewed)
  for (const artifact of inputs.artifacts) {
    if (deriveArtifactCompletionState(artifact) === 'pending_human_ack') {
      items.push({
        type: 'artifact_awaiting_ack',
        id: artifact.id,
        label: deriveArtifactLabel(artifact),
      });
    }
  }

  return items;
}

/**
 * Derive the "next recommended action" text.
 * Single concise instruction for the most important pending item.
 */
export function deriveNextRecommendedAction(items: BlockedItem[], phase: string): string {
  if (items.length === 0) {
    if (phase === 'complete') return '无待办事项';
    if (phase === 'executing') return '等待执行结果';
    if (phase === 'waiting_external') return '等待外部系统确认';
    return '继续推进任务';
  }

  // Priority: approval_pending > action_needs_human > artifact_awaiting_ack
  const approval = items.find(i => i.type === 'approval_pending');
  if (approval) return approval.label;

  const needsHuman = items.find(i => i.type === 'action_needs_human');
  if (needsHuman) return needsHuman.label;

  const awaitingAck = items.find(i => i.type === 'artifact_awaiting_ack');
  if (awaitingAck) return awaitingAck.label;

  return items[0].label;
}

/**
 * Main entry point: compute all WorkroomSummary fields from structured inputs.
 */
export function computeWorkroomSummary(inputs: SummaryInputs): SummaryOutput {
  const phase = deriveCurrentPhase(inputs);
  const headline = deriveHeadline(inputs, phase);
  const blockedItems = deriveBlockedItems(inputs);
  const nextRecommendedAction = deriveNextRecommendedAction(blockedItems, phase);

  const activeOwnerSummary: Record<string, { taskCount: number; actionCount: number }> = {};
  for (const owner of inputs.agentOwnership) {
    activeOwnerSummary[owner.agentId] = {
      taskCount: owner.taskCount,
      actionCount: owner.actionCount,
    };
  }

  return {
    headline,
    currentPhase: phase,
    activeOwnerSummary,
    needsAttentionCount: blockedItems.length,
    blockedItems,
    nextRecommendedAction,
  };
}
