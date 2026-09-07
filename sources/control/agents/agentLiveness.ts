/**
 * agentLiveness.ts — the ONE authoritative "is this agent reachable right now"
 * check, derived from the bound machine's heartbeat (control_machines.lastSeenAt).
 *
 * Rule (do NOT regress): agent liveness is NEVER read from the stored
 * control_agents.status column — that is a manually-written flag with no
 * connection to whether the daemon is actually running. The only honored stored
 * value is 'paused' (the explicit Stop button). Everything else is derived from
 * the host machine's heartbeat freshness.
 *
 * Previously this logic was duplicated in memberRoutes.ts and agentRoutes.ts;
 * this module is the shared source so handoff-time checks, the members list, and
 * the COMPUTER picker all agree.
 */
import { db } from '@/storage/db';

/**
 * An agent's machine is "online" if seen within this window. The daemon refreshes
 * the roster every 30s (and bumps lastSeenAt via verifyMachineToken), so a
 * 2-minute window reflects a live daemon without flapping between refreshes.
 */
export const MACHINE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

/** online | offline | paused — derived truth (see module doc). */
export function deriveAgentStatus(
  storedStatus: string,
  machineLastSeenAt: Date | null | undefined,
): string {
  if (storedStatus === 'paused') return 'paused';
  if (!machineLastSeenAt) return 'offline';
  return Date.now() - machineLastSeenAt.getTime() <= MACHINE_ONLINE_WINDOW_MS ? 'online' : 'offline';
}

export interface AgentReachability {
  status: string;
  /** true iff the agent's daemon is live right now (status === 'online'). */
  reachable: boolean;
  /** Display label for user-facing "offline" reports. */
  label: string;
}

/**
 * Batch reachability for a set of agent ids. Resolves each agent's bound machine
 * heartbeat and derives status. Agents absent from the map (unknown id) should be
 * treated by callers as unreachable.
 */
export async function getAgentReachability(
  agentIds: string[],
): Promise<Map<string, AgentReachability>> {
  const out = new Map<string, AgentReachability>();
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return out;

  const agents = await db.controlAgent.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, machineId: true, displayName: true, name: true },
  });
  const machineIds = [...new Set(agents.map((a) => a.machineId).filter((m): m is string => !!m))];
  const machines = machineIds.length
    ? await db.controlMachine.findMany({
        where: { id: { in: machineIds } },
        select: { id: true, lastSeenAt: true },
      })
    : [];
  const lastSeenByMachine = new Map(machines.map((m) => [m.id, m.lastSeenAt]));

  for (const a of agents) {
    const status = deriveAgentStatus(a.status, a.machineId ? lastSeenByMachine.get(a.machineId) : null);
    out.set(a.id, { status, reachable: status === 'online', label: a.displayName || a.name || a.id });
  }
  return out;
}
