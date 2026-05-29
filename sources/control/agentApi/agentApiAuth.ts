/**
 * Auth helper for /internal/agent-api/* endpoints.
 *
 * The agent-proxy calls these endpoints with:
 *   Authorization: Bearer <machineToken>
 *   X-Mio-Agent-Id: <agentId>
 *
 * This helper:
 *   1. Verifies the machine token (401 on invalid/missing).
 *   2. Looks up the agent by id.
 *   3. Confirms the machine OWNS the agent (403 on not-found OR not-owned).
 *      Design: "not found" and "not owned" both return 403 AGENT_NOT_OWNED — we do NOT
 *      reveal whether the agent exists to a caller who holds a valid machine token.
 *      This mirrors the anti-enumeration principle used throughout the control plane.
 *
 * Returns a discriminated union:
 *   { ok: true,  machine, agent }
 *   { ok: false, status, code, message }
 */

import type { FastifyRequest } from 'fastify';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { db } from '@/storage/db';

// ── Result types ──────────────────────────────────────────────────────────────

type Machine = NonNullable<Awaited<ReturnType<typeof verifyMachineToken>>>;

/** Minimal agent shape returned by db.controlAgent.findUnique. */
type Agent = NonNullable<
  Awaited<
    ReturnType<typeof db.controlAgent.findUnique<{ where: { id: string } }>>
  >
>;

export type AgentApiAuthSuccess = {
  ok: true;
  machine: Machine;
  agent: Agent;
};

export type AgentApiAuthFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type AgentApiAuthResult = AgentApiAuthSuccess | AgentApiAuthFailure;

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Authorize a request to a /internal/agent-api/* endpoint.
 *
 * Reads:
 *   Authorization    — Bearer <machineToken>
 *   X-Mio-Agent-Id  — the agent the machine is acting as
 *
 * Returns:
 *   { ok: true, machine, agent }             on success
 *   { ok: false, status: 401, code: 'MACHINE_TOKEN_INVALID', message }  on bad/missing token
 *   { ok: false, status: 403, code: 'AGENT_NOT_OWNED',       message }  on not-found or not-owned agent
 */
export async function authorizeAgentApi(
  request: FastifyRequest,
): Promise<AgentApiAuthResult> {
  // ── Step 1: verify machine token ──────────────────────────────────────────
  const machine = await verifyMachineToken(request.headers.authorization);
  if (!machine) {
    return {
      ok: false,
      status: 401,
      code: 'MACHINE_TOKEN_INVALID',
      message: 'Invalid or expired machine token',
    };
  }

  // ── Step 2: resolve agent ─────────────────────────────────────────────────
  // Fastify exposes a repeated header as string[]; narrow to string so a duplicated
  // X-Mio-Agent-Id (array) is treated as absent → clean 403 rather than a Prisma
  // P2023 from findUnique({where:{id: ['a','b']}}).
  const raw = request.headers['x-mio-agent-id'];
  const agentId = typeof raw === 'string' ? raw : undefined;

  const agent = agentId
    ? await db.controlAgent.findUnique({ where: { id: agentId } })
    : null;

  // ── Step 3: ownership check ───────────────────────────────────────────────
  // Conditions that FAIL ownership:
  //   - agent not found (null)
  //   - agent.machineId is null (unbound agent — null !== machine.id, but
  //     this branch makes the null-safety explicit and documented)
  //   - agent.machineId !== machine.id (owned by a different machine)
  //
  // NOTE: null !== machine.id is always true in JS/TS, so the
  // `agent.machineId !== machine.id` check already catches the null case.
  // The explicit `agent.machineId == null` guard below is kept for clarity
  // and to prevent any future refactor from accidentally letting null through.
  if (
    !agent ||
    agent.machineId == null ||          // unbound agent — explicit null safety
    agent.machineId !== machine.id       // owned by a different machine
  ) {
    return {
      ok: false,
      status: 403,
      code: 'AGENT_NOT_OWNED',
      message: 'Agent not found or not owned by this machine',
    };
  }

  return { ok: true, machine, agent };
}
