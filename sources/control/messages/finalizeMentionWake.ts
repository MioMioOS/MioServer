/**
 * finalizeMentionWake — the handoff-robustness layer shared by the human send
 * path (messageRoutes) and the agent-to-agent handoff path (agentApiRoutes).
 *
 * Given who a message mentioned, decide (a) who to actually WAKE, and (b) which
 * mentions landed on an OFFLINE target so the sender can be told instead of the
 * message silently dropping. Reachability is the heartbeat-derived truth (see
 * agentLiveness), never the stored status column.
 *
 * Two robustness rules:
 *   1. Same-name disambiguation. If a label matched >1 agent (collision) and some
 *      are live, wake ONLY the live one(s) — no double-waking a live+dead pair.
 *      If none are live, keep them (cursor catch-up when they return) and report.
 *   2. Offline report. Any mention whose whole target is unreachable is collected
 *      as an offline label so the caller can post a "@X 不在线,没送到" notice.
 */
import { getAgentReachability, type AgentReachability } from '@/control/agents/agentLiveness';

export interface FinalizedMentions {
  /** Disambiguated wake set (duplicates pruned to the live one when possible). */
  wakeAgentIds: string[];
  /** Display labels of mentions that landed on an all-offline target. */
  offlineLabels: string[];
}

/**
 * Pure core (no DB): given the label groups, the full mentioned-id list, and a
 * reachability map, decide the wake set + offline labels. Split out so the
 * disambiguation rules are unit-testable without a database.
 */
export function computeMentionWake(
  agentMatches: Array<{ label: string; ids: string[] }>,
  allMentionedAgentIds: string[],
  reach: Map<string, AgentReachability>,
): FinalizedMentions {
  const isLive = (id: string) => reach.get(id)?.reachable === true;

  const wake = new Set<string>();
  const offlineLabels: string[] = [];
  const grouped = new Set<string>();

  // Rule 1 + 2 over the label groups.
  for (const g of agentMatches) {
    g.ids.forEach((id) => grouped.add(id));
    const live = g.ids.filter(isLive);
    if (live.length > 0) {
      live.forEach((id) => wake.add(id));
    } else {
      g.ids.forEach((id) => wake.add(id));
      offlineLabels.push(g.label);
    }
  }

  // uuid-picker mentions with no label group (human clicked a mention chip).
  for (const id of allMentionedAgentIds) {
    if (grouped.has(id)) continue;
    wake.add(id);
    if (!isLive(id)) offlineLabels.push(reach.get(id)?.label ?? id);
  }

  return { wakeAgentIds: [...wake], offlineLabels: [...new Set(offlineLabels)] };
}

export async function finalizeMentionWake(args: {
  /** Label groups from resolveContentMentions (plain-text @name path). */
  agentMatches: Array<{ label: string; ids: string[] }>;
  /** Every mentioned agent id (label-resolved + uuid-picker ids), for reachability. */
  allMentionedAgentIds: string[];
}): Promise<FinalizedMentions> {
  const { agentMatches, allMentionedAgentIds } = args;
  if (allMentionedAgentIds.length === 0) return { wakeAgentIds: [], offlineLabels: [] };
  const reach = await getAgentReachability(allMentionedAgentIds);
  return computeMentionWake(agentMatches, allMentionedAgentIds, reach);
}

/** One-line human notice for offline handoff targets. Empty string if none. */
export function offlineNotice(offlineLabels: string[]): string {
  if (offlineLabels.length === 0) return '';
  const who = offlineLabels.map((l) => `@${l}`).join('、');
  return `⚠️ ${who} 现在不在线,这条可能没送到(对方的电脑没连上)。`;
}
