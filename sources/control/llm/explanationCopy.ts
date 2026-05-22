/**
 * #164/#166 — deterministic explanation copy (server-owned, no LLM, no egress).
 *
 * Source of truth: docs/productization/server-llm-phase1-copy-set.md (#166).
 * Phase 1: readiness explanations are ALWAYS deterministic (PM #162 fork decision — small state
 * space, no LLM/egress). action_failure / task_summary use these strings as the deterministic
 * FALLBACK when the LLM provider is off/failed/unsafe (generateExplanation deterministicFallback).
 *
 * All strings here are vetted no-leak copy (no token/path/provider/model/account/cross-scope).
 */

export type ReadStatus = 'ready' | 'expired' | 'missing' | 'unknown';
export type OperatorStatus = 'ready' | 'missing';
export type ServerStatus = 'connected' | 'unreachable';

/**
 * Deterministic readiness explanation (#166 R-01..R-05 fallback copy). Server-unreachable wins;
 * then the read/operator combination. Always safe to show.
 */
export function readinessExplanation(input: {
  serverStatus: ServerStatus;
  readStatus: ReadStatus;
  operatorStatus: OperatorStatus;
}): string {
  if (input.serverStatus === 'unreachable') return '控制服务器无法连接，请稍后重试。'; // R-05
  const { readStatus, operatorStatus } = input;
  if (readStatus === 'ready' && operatorStatus === 'ready') return '读取权限和操作权限都已就绪。'; // R-01
  if (readStatus === 'missing') return '读取权限未配置，请前往控制设置。'; // R-02
  if (readStatus === 'expired' && operatorStatus === 'ready') return '读取令牌已失效，操作权限仍保持就绪。'; // R-03
  if (readStatus === 'ready' && operatorStatus === 'missing') return '读取权限正常，操作员未配置。'; // R-04
  // Sensible default for remaining combos (e.g. expired+missing / unknown): point to setup.
  return '读取或操作权限尚未就绪，请前往控制设置检查。';
}

/**
 * Deterministic action/task-failure fallback copy (#166 A-01..A-05 + generic). Mapped from the
 * raw control-plane action status (the product-level reason codes in #166 are the LLM's job; the
 * deterministic fallback maps from what the server actually has: action.status).
 */
export function actionFailureFallback(actionStatus: string | null | undefined): string {
  switch (actionStatus) {
    case 'needs_human':            return '此操作需要人工确认。';            // A-01
    case 'needs_config':           return '本地运行环境需要配置。';          // A-02
    case 'reviewed':               return '操作已审阅，请刷新任务。';        // A-03
    case 'retry_denied':           return '当前操作权限不足。';              // A-04
    case 'transmission_complete':  return '任务状态已同步，暂无证据摘要。';  // A-05
    case 'failed':                 return '此操作执行失败，请查看运行日志。';
    default:                       return '此操作需要人工查看。';
  }
}

/** Deterministic task-summary fallback (#166 D-* style, generic). */
export function taskSummaryFallback(): string {
  return '任务状态已同步，详情请查看任务列表。';
}
