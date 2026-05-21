import { describe, it, expect } from 'vitest';

/**
 * WorkroomSummary logic unit tests.
 *
 * Tests cover:
 * 1. Artifact completion state derivation (all 3 milestones + disposal states)
 * 2. Artifact label derivation (ipa_upload, deployment_url, generic)
 *    — NEVER says "完成" / "done" unless humanAckedAt is set
 * 3. Phase derivation priority order
 * 4. Headline derivation — intermediate states, never premature "完成"
 * 5. Blocked items derivation
 * 6. Full compute integration (Coinbyte fixture)
 */

import {
  deriveArtifactCompletionState,
  deriveArtifactLabel,
  deriveCurrentPhase,
  deriveHeadline,
  deriveBlockedItems,
  computeWorkroomSummary,
  ArtifactMilestones,
  SummaryInputs,
  TaskCounts,
  ActiveAction,
} from './summaryLogic';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-05-21T10:00:00Z');
const EARLIER = new Date('2026-05-21T09:00:00Z');

function makeArtifact(overrides: Partial<ArtifactMilestones> = {}): ArtifactMilestones {
  return {
    id: 'art-1',
    type: 'build',
    title: '测试产物',
    status: 'created',
    verifiedAt: null,
    externalConfirmedAt: null,
    humanAckedAt: null,
    ...overrides,
  };
}

function makeTaskCounts(overrides: Partial<TaskCounts> = {}): TaskCounts {
  return { todo: 0, in_progress: 0, waiting_approval: 0, in_review: 0, done: 0, canceled: 0, ...overrides };
}

function makeAction(overrides: Partial<ActiveAction> = {}): ActiveAction {
  return {
    id: 'act-1',
    kind: 'deploy',
    summary: '部署到生产环境',
    status: 'proposed',
    reversibility: 'reversible',
    actorAgentId: 'agent-1',
    ...overrides,
  };
}

const BASE_INPUTS: SummaryInputs = {
  workroomName: '测试工作室',
  taskCounts: makeTaskCounts(),
  activeActions: [],
  artifacts: [],
  pendingApprovals: [],
  agentOwnership: [],
};

// ─── 1. Artifact completion state ─────────────────────────────────────────────

describe('deriveArtifactCompletionState', () => {
  it('returns pending_verify when no milestones set', () => {
    expect(deriveArtifactCompletionState(makeArtifact())).toBe('pending_verify');
  });

  it('returns pending_external when only verifiedAt is set', () => {
    expect(deriveArtifactCompletionState(makeArtifact({ verifiedAt: NOW }))).toBe('pending_external');
  });

  it('returns pending_human_ack when verifiedAt + externalConfirmedAt set but not humanAckedAt', () => {
    expect(deriveArtifactCompletionState(makeArtifact({
      verifiedAt: EARLIER,
      externalConfirmedAt: NOW,
    }))).toBe('pending_human_ack');
  });

  it('returns pending_human_ack when ONLY externalConfirmedAt set (any order valid)', () => {
    // Any order of milestones is valid — externalConfirmedAt alone → still needs human ack
    expect(deriveArtifactCompletionState(makeArtifact({
      externalConfirmedAt: NOW,
    }))).toBe('pending_human_ack');
  });

  it('returns accepted only when ALL 3 milestones are set', () => {
    expect(deriveArtifactCompletionState(makeArtifact({
      verifiedAt: EARLIER,
      externalConfirmedAt: EARLIER,
      humanAckedAt: NOW,
    }))).toBe('accepted');
  });

  it('returns accepted even if externalConfirmedAt is missing but humanAckedAt is set', () => {
    // humanAckedAt takes priority — if human said OK, we trust it
    expect(deriveArtifactCompletionState(makeArtifact({
      verifiedAt: EARLIER,
      humanAckedAt: NOW,
    }))).toBe('accepted');
  });

  it('returns disposed for status=superseded', () => {
    expect(deriveArtifactCompletionState(makeArtifact({ status: 'superseded', verifiedAt: NOW }))).toBe('disposed');
  });

  it('returns disposed for status=disposed', () => {
    expect(deriveArtifactCompletionState(makeArtifact({ status: 'disposed' }))).toBe('disposed');
  });

  it('returns disposed for status=ignored', () => {
    expect(deriveArtifactCompletionState(makeArtifact({ status: 'ignored' }))).toBe('disposed');
  });
});

// ─── 2. Artifact label derivation ─────────────────────────────────────────────

describe('deriveArtifactLabel — ipa_upload (Coinbyte fixture)', () => {
  const ipaArtifact = (overrides: Partial<ArtifactMilestones> = {}) =>
    makeArtifact({ type: 'ipa_upload', title: 'coinbyte-1.4.1+14', ...overrides });

  it('pending_verify → "等待本地验证" (not done)', () => {
    const label = deriveArtifactLabel(ipaArtifact());
    expect(label).toContain('等待本地验证');
    expect(label).not.toContain('完成');
    expect(label).not.toContain('done');
  });

  it('pending_external → "已上传并本地验证，等待 Apple 处理" (not done)', () => {
    const label = deriveArtifactLabel(ipaArtifact({ verifiedAt: NOW }));
    expect(label).toContain('已上传并本地验证，等待 Apple 处理');
    expect(label).not.toContain('完成');
    expect(label).not.toContain('done');
  });

  it('pending_human_ack → "TestFlight 已可见，等待人工确认" (not done)', () => {
    const label = deriveArtifactLabel(ipaArtifact({ verifiedAt: EARLIER, externalConfirmedAt: NOW }));
    expect(label).toContain('TestFlight 已可见，等待人工确认');
    expect(label).not.toContain('完成');
    expect(label).not.toContain('done');
  });

  it('accepted → only then says "完成"', () => {
    const label = deriveArtifactLabel(ipaArtifact({
      verifiedAt: EARLIER,
      externalConfirmedAt: EARLIER,
      humanAckedAt: NOW,
    }));
    expect(label).toContain('完成');
  });

  it('disposed → shows (已废弃)', () => {
    const label = deriveArtifactLabel(ipaArtifact({ status: 'superseded', verifiedAt: NOW }));
    expect(label).toContain('已废弃');
    expect(label).not.toContain('完成');
  });
});

describe('deriveArtifactLabel — deployment_url', () => {
  const deployArtifact = (overrides: Partial<ArtifactMilestones> = {}) =>
    makeArtifact({ type: 'deployment_url', title: 'Vercel 生产部署', ...overrides });

  it('pending_verify → 等待验证', () => {
    expect(deriveArtifactLabel(deployArtifact())).toContain('等待验证');
  });

  it('pending_external → 本地验证通过，等待外部确认', () => {
    const label = deriveArtifactLabel(deployArtifact({ verifiedAt: NOW }));
    expect(label).toContain('本地验证通过，等待外部确认');
    expect(label).not.toContain('完成');
  });

  it('pending_human_ack → 部署已确认，等待人工审核', () => {
    const label = deriveArtifactLabel(deployArtifact({ verifiedAt: EARLIER, externalConfirmedAt: NOW }));
    expect(label).toContain('部署已确认，等待人工审核');
    expect(label).not.toContain('完成');
  });

  it('accepted → says 完成', () => {
    expect(deriveArtifactLabel(deployArtifact({
      verifiedAt: EARLIER, externalConfirmedAt: EARLIER, humanAckedAt: NOW,
    }))).toContain('完成');
  });
});

describe('deriveArtifactLabel — generic type', () => {
  it('pending_verify → 等待验证', () => {
    const label = deriveArtifactLabel(makeArtifact({ type: 'test_report', title: '测试报告' }));
    expect(label).toContain('等待验证');
    expect(label).not.toContain('完成');
  });

  it('pending_human_ack → 外部已确认，等待人工审核', () => {
    const label = deriveArtifactLabel(makeArtifact({
      type: 'test_report', title: '测试报告',
      verifiedAt: EARLIER, externalConfirmedAt: NOW,
    }));
    expect(label).toContain('外部已确认，等待人工审核');
    expect(label).not.toContain('完成');
  });
});

// ─── 3. Phase derivation ──────────────────────────────────────────────────────

describe('deriveCurrentPhase', () => {
  it('blocked_needs_human when action.status = needs_human', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      activeActions: [makeAction({ status: 'needs_human' })],
      artifacts: [],
      pendingApprovals: [],
    });
    expect(phase).toBe('blocked_needs_human');
  });

  it('waiting_approval when pendingApprovals > 0', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      activeActions: [],
      artifacts: [],
      pendingApprovals: [{ id: 'appr-1', actionId: 'act-1', artifactId: null, kind: 'pre_action', riskSummary: '高风险' }],
    });
    expect(phase).toBe('waiting_approval');
  });

  it('waiting_review when artifact in pending_human_ack', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      activeActions: [],
      artifacts: [makeArtifact({ verifiedAt: EARLIER, externalConfirmedAt: NOW })],
      pendingApprovals: [],
    });
    expect(phase).toBe('waiting_review');
  });

  it('waiting_external when artifact in pending_external', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      activeActions: [],
      artifacts: [makeArtifact({ verifiedAt: NOW })],
      pendingApprovals: [],
    });
    expect(phase).toBe('waiting_external');
  });

  it('executing when action.status = fired', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      activeActions: [makeAction({ status: 'fired' })],
      artifacts: [],
      pendingApprovals: [],
    });
    expect(phase).toBe('executing');
  });

  it('in_progress when tasks in_progress and no urgent artifacts/approvals', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ in_progress: 2, done: 1 }),
      activeActions: [],
      artifacts: [],
      pendingApprovals: [],
    });
    expect(phase).toBe('in_progress');
  });

  it('complete when all tasks done AND all artifacts accepted', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ done: 3 }),
      activeActions: [],
      artifacts: [makeArtifact({ verifiedAt: EARLIER, externalConfirmedAt: EARLIER, humanAckedAt: NOW })],
      pendingApprovals: [],
    });
    expect(phase).toBe('complete');
  });

  it('NOT complete when all tasks done but artifact missing humanAckedAt', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ done: 3 }),
      activeActions: [],
      // externalConfirmedAt set but NOT humanAckedAt — not done!
      artifacts: [makeArtifact({ verifiedAt: EARLIER, externalConfirmedAt: NOW })],
      pendingApprovals: [],
    });
    // Should be waiting_review (external_confirmed → pending_human_ack)
    expect(phase).toBe('waiting_review');
    expect(phase).not.toBe('complete');
  });

  it('disposed artifacts do NOT block complete phase', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ done: 2 }),
      activeActions: [],
      artifacts: [
        makeArtifact({ verifiedAt: EARLIER, externalConfirmedAt: EARLIER, humanAckedAt: NOW }),
        makeArtifact({ status: 'superseded', verifiedAt: NOW }),  // disposed — ignored
      ],
      pendingApprovals: [],
    });
    expect(phase).toBe('complete');
  });

  it('planning when only todo tasks and no active artifacts', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ todo: 2 }),
      activeActions: [],
      artifacts: [],
      pendingApprovals: [],
    });
    expect(phase).toBe('planning');
  });

  it('blocked_needs_human takes priority over waiting_approval', () => {
    const phase = deriveCurrentPhase({
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      activeActions: [makeAction({ status: 'needs_human' })],
      artifacts: [],
      pendingApprovals: [{ id: 'a', actionId: 'x', artifactId: null, kind: 'pre_action', riskSummary: '' }],
    });
    expect(phase).toBe('blocked_needs_human');
  });
});

// ─── 4. Headline derivation ───────────────────────────────────────────────────

describe('deriveHeadline — no premature "完成"', () => {
  it('Coinbyte fixture: IPA uploaded+verified, waiting Apple', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ done: 2, in_progress: 1 }),
      artifacts: [makeArtifact({
        type: 'ipa_upload',
        title: 'coinbyte-1.4.1+14',
        verifiedAt: NOW,  // verified only — waiting Apple
      })],
    };
    const phase = deriveCurrentPhase(inputs);
    const headline = deriveHeadline(inputs, phase);
    expect(headline).toContain('已上传并本地验证，等待 Apple 处理');
    expect(headline).not.toContain('完成');
  });

  it('Coinbyte fixture: TestFlight visible, waiting Laurent', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ done: 3 }),
      artifacts: [makeArtifact({
        type: 'ipa_upload',
        title: 'coinbyte-1.4.1+14',
        verifiedAt: EARLIER,
        externalConfirmedAt: NOW,  // TestFlight visible — waiting human ack
      })],
    };
    const phase = deriveCurrentPhase(inputs);
    const headline = deriveHeadline(inputs, phase);
    expect(headline).toContain('TestFlight 已可见，等待人工确认');
    expect(headline).not.toContain('完成');
  });

  it('only says 完成 when ALL 3 milestones set AND all tasks done', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ done: 3 }),
      artifacts: [makeArtifact({
        type: 'ipa_upload',
        title: 'coinbyte-1.4.1+14',
        verifiedAt: EARLIER,
        externalConfirmedAt: EARLIER,
        humanAckedAt: NOW,  // All 3 set
      })],
    };
    const phase = deriveCurrentPhase(inputs);
    expect(phase).toBe('complete');
    const headline = deriveHeadline(inputs, phase);
    // "完成" is allowed here — it IS genuinely complete
    expect(headline).toContain('完成');
    // Task context uses 进度 X/Y format
    expect(headline).toContain('进度 3/3');
  });

  it('blocked headline includes warning when action needs_human', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      activeActions: [makeAction({ status: 'needs_human', summary: '上传失败，需要手动重试' })],
    };
    const phase = deriveCurrentPhase(inputs);
    const headline = deriveHeadline(inputs, phase);
    expect(headline).toContain('等待人工介入');
    expect(headline).toContain('上传失败，需要手动重试');
  });

  it('waiting_approval includes pending count', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ in_progress: 2 }),
      pendingApprovals: [
        { id: 'a1', actionId: 'x', artifactId: null, kind: 'pre_action', riskSummary: '' },
        { id: 'a2', actionId: 'y', artifactId: null, kind: 'pre_action', riskSummary: '' },
      ],
    };
    const phase = deriveCurrentPhase(inputs);
    const headline = deriveHeadline(inputs, phase);
    expect(phase).toBe('waiting_approval');
    expect(headline).toContain('2');
    expect(headline).toContain('审批');
    expect(headline).not.toContain('完成');
  });

  it('uses focus artifact with highest urgency (pending_human_ack over pending_external)', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ in_progress: 1 }),
      artifacts: [
        // lower priority: pending_external
        makeArtifact({ id: 'art-low', type: 'build', title: '构建产物', verifiedAt: NOW }),
        // higher priority: pending_human_ack
        makeArtifact({
          id: 'art-high',
          type: 'ipa_upload',
          title: 'coinbyte-1.4.1+14',
          verifiedAt: EARLIER,
          externalConfirmedAt: NOW,
        }),
      ],
    };
    const phase = deriveCurrentPhase(inputs);
    const headline = deriveHeadline(inputs, phase);
    // Should focus on the more urgent one (pending_human_ack)
    expect(headline).toContain('TestFlight 已可见，等待人工确认');
  });
});

// ─── 5. Blocked items ─────────────────────────────────────────────────────────

describe('deriveBlockedItems', () => {
  it('empty when no approvals, no actions needing human, no artifacts awaiting ack', () => {
    const items = deriveBlockedItems({ ...BASE_INPUTS });
    expect(items).toHaveLength(0);
  });

  it('includes approval_pending for each pending approval', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      pendingApprovals: [
        { id: 'a1', actionId: 'x', artifactId: null, kind: 'pre_action', riskSummary: '高风险操作' },
      ],
    };
    const items = deriveBlockedItems(inputs);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('approval_pending');
    expect(items[0].label).toContain('高风险操作');
  });

  it('includes action_needs_human for each needs_human action', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      activeActions: [makeAction({ status: 'needs_human', summary: '上传失败' })],
    };
    const items = deriveBlockedItems(inputs);
    const needsHuman = items.find(i => i.type === 'action_needs_human');
    expect(needsHuman).toBeDefined();
    expect(needsHuman!.label).toContain('上传失败');
  });

  it('includes artifact_awaiting_ack for externalConfirmed artifacts', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      artifacts: [makeArtifact({
        type: 'ipa_upload',
        title: 'coinbyte-1.4.1+14',
        verifiedAt: EARLIER,
        externalConfirmedAt: NOW,
      })],
    };
    const items = deriveBlockedItems(inputs);
    const artItem = items.find(i => i.type === 'artifact_awaiting_ack');
    expect(artItem).toBeDefined();
    expect(artItem!.label).toContain('TestFlight 已可见，等待人工确认');
  });

  it('does NOT include disposed artifacts in blocked items', () => {
    const inputs: SummaryInputs = {
      ...BASE_INPUTS,
      artifacts: [makeArtifact({ status: 'superseded', externalConfirmedAt: NOW })],
    };
    const items = deriveBlockedItems(inputs);
    expect(items).toHaveLength(0);
  });
});

// ─── 6. Integration — computeWorkroomSummary ─────────────────────────────────

describe('computeWorkroomSummary — integration', () => {
  it('returns all expected fields', () => {
    const inputs: SummaryInputs = {
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ in_progress: 1, done: 2 }),
      activeActions: [],
      artifacts: [],
      pendingApprovals: [],
      agentOwnership: [{ agentId: 'agent-1', taskCount: 1, actionCount: 0 }],
    };
    const result = computeWorkroomSummary(inputs);
    expect(result).toHaveProperty('headline');
    expect(result).toHaveProperty('currentPhase');
    expect(result).toHaveProperty('activeOwnerSummary');
    expect(result).toHaveProperty('needsAttentionCount');
    expect(result).toHaveProperty('blockedItems');
    expect(result).toHaveProperty('nextRecommendedAction');
    expect(result.activeOwnerSummary['agent-1']).toEqual({ taskCount: 1, actionCount: 0 });
  });

  it('Coinbyte full fixture: IPA at pending_external, 2/3 tasks done', () => {
    const inputs: SummaryInputs = {
      workroomName: 'Coinbyte 发版',
      currentGoalTitle: 'v1.4.1+14 发版',
      taskCounts: makeTaskCounts({ done: 2, in_progress: 1 }),
      activeActions: [],
      artifacts: [makeArtifact({
        type: 'ipa_upload',
        title: 'coinbyte-1.4.1+14',
        verifiedAt: NOW,
      })],
      pendingApprovals: [],
      agentOwnership: [{ agentId: 'agent-aaron', taskCount: 1, actionCount: 0 }],
    };
    const result = computeWorkroomSummary(inputs);
    expect(result.currentPhase).toBe('waiting_external');
    expect(result.headline).toContain('已上传并本地验证，等待 Apple 处理');
    expect(result.headline).not.toContain('完成');
    expect(result.needsAttentionCount).toBe(0); // no blocked items yet (external is automatic)
  });

  it('Coinbyte full fixture: IPA at pending_human_ack → blocked item', () => {
    const inputs: SummaryInputs = {
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ done: 3 }),
      activeActions: [],
      artifacts: [makeArtifact({
        type: 'ipa_upload',
        title: 'coinbyte-1.4.1+14',
        verifiedAt: EARLIER,
        externalConfirmedAt: NOW,
      })],
      pendingApprovals: [],
      agentOwnership: [],
    };
    const result = computeWorkroomSummary(inputs);
    expect(result.currentPhase).toBe('waiting_review');
    expect(result.headline).toContain('TestFlight 已可见，等待人工确认');
    expect(result.needsAttentionCount).toBe(1);
    expect(result.blockedItems[0].type).toBe('artifact_awaiting_ack');
    expect(result.nextRecommendedAction).toContain('TestFlight 已可见，等待人工确认');
    // CRITICAL: not done
    expect(result.headline).not.toContain('完成');
    expect(result.currentPhase).not.toBe('complete');
  });

  it('complete ONLY when all 3 milestones set', () => {
    const inputs: SummaryInputs = {
      workroomName: 'Coinbyte 发版',
      taskCounts: makeTaskCounts({ done: 3 }),
      activeActions: [],
      artifacts: [makeArtifact({
        type: 'ipa_upload',
        title: 'coinbyte-1.4.1+14',
        verifiedAt: EARLIER,
        externalConfirmedAt: EARLIER,
        humanAckedAt: NOW,
      })],
      pendingApprovals: [],
      agentOwnership: [],
    };
    const result = computeWorkroomSummary(inputs);
    expect(result.currentPhase).toBe('complete');
    expect(result.headline).toContain('完成');
    expect(result.needsAttentionCount).toBe(0);
  });
});
