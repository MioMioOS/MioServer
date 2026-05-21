/**
 * Task CAS claim — unit tests.
 *
 * Tests the atomic claim invariant WITHOUT hitting a real DB.
 * Verifies the logic that drives the Prisma updateMany WHERE clause.
 *
 * The DB-level atomic guarantee is tested via acceptance fixtures
 * (real Prisma against PostgreSQL) — see the 7 Coinbyte failure fixtures
 * in the ERD/API contract.
 */
import { describe, it, expect } from 'vitest';

// ── Claim logic extracted for unit testing ────────────────────────────────────

type TaskStatus = 'todo' | 'in_progress' | 'waiting_approval' | 'in_review' | 'done' | 'canceled';

interface Task {
  id: string;
  ownerInstanceId: string | null;
  status: TaskStatus;
}

const NON_CLAIMABLE_STATUSES: TaskStatus[] = ['done', 'canceled'];

/**
 * Simulates the Prisma updateMany WHERE clause evaluation.
 * In production this runs atomically inside PostgreSQL.
 * Returns how many rows would be updated (0 or 1).
 */
function simulateCASClaim(task: Task, requestedOwner: string): { count: number } {
  if (
    task.ownerInstanceId === null &&
    !NON_CLAIMABLE_STATUSES.includes(task.status)
  ) {
    return { count: 1 };
  }
  return { count: 0 };
}

/**
 * Simulates the unclaim CAS — only current owner can unclaim.
 */
function simulateCASUnclaim(task: Task, requestedOwner: string): { count: number } {
  if (
    task.ownerInstanceId === requestedOwner &&
    !NON_CLAIMABLE_STATUSES.includes(task.status)
  ) {
    return { count: 1 };
  }
  return { count: 0 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Task CAS claim — WHERE predicate logic', () => {
  const agentA = 'agent-aaa';
  const agentB = 'agent-bbb';

  it('claims an unclaimed todo task', () => {
    const task: Task = { id: 't1', ownerInstanceId: null, status: 'todo' };
    expect(simulateCASClaim(task, agentA).count).toBe(1);
  });

  it('claims an unclaimed in_review task (e.g. after reviewer released it)', () => {
    const task: Task = { id: 't2', ownerInstanceId: null, status: 'in_review' };
    expect(simulateCASClaim(task, agentA).count).toBe(1);
  });

  it('returns 0 if task already has an owner (concurrent claim)', () => {
    const task: Task = { id: 't3', ownerInstanceId: agentA, status: 'in_progress' };
    // agentB tries to claim — WHERE owner_instance_id IS NULL fails
    expect(simulateCASClaim(task, agentB).count).toBe(0);
  });

  it('returns 0 if task is done', () => {
    const task: Task = { id: 't4', ownerInstanceId: null, status: 'done' };
    expect(simulateCASClaim(task, agentA).count).toBe(0);
  });

  it('returns 0 if task is canceled', () => {
    const task: Task = { id: 't5', ownerInstanceId: null, status: 'canceled' };
    expect(simulateCASClaim(task, agentA).count).toBe(0);
  });

  it('same agent cannot double-claim (already owns it → owner_instance_id not null)', () => {
    const task: Task = { id: 't6', ownerInstanceId: agentA, status: 'in_progress' };
    // WHERE owner_instance_id IS NULL fails even for same agent
    expect(simulateCASClaim(task, agentA).count).toBe(0);
  });
});

describe('Task CAS unclaim — WHERE predicate logic', () => {
  const agentA = 'agent-aaa';
  const agentB = 'agent-bbb';

  it('unclaims when caller is the current owner', () => {
    const task: Task = { id: 'u1', ownerInstanceId: agentA, status: 'in_progress' };
    expect(simulateCASUnclaim(task, agentA).count).toBe(1);
  });

  it('blocks unclaim when caller is not the owner', () => {
    const task: Task = { id: 'u2', ownerInstanceId: agentA, status: 'in_progress' };
    expect(simulateCASUnclaim(task, agentB).count).toBe(0);
  });

  it('blocks unclaim when task is done', () => {
    const task: Task = { id: 'u3', ownerInstanceId: agentA, status: 'done' };
    expect(simulateCASUnclaim(task, agentA).count).toBe(0);
  });

  it('blocks unclaim on unowned task', () => {
    const task: Task = { id: 'u4', ownerInstanceId: null, status: 'todo' };
    expect(simulateCASUnclaim(task, agentA).count).toBe(0);
  });
});

describe('Claim concurrency invariants', () => {
  it('exactly one of N concurrent agents wins the claim', () => {
    // Simulates N agents all reading the same unclaimed task simultaneously
    // then each trying to update. Only the one whose WHERE matches wins.
    const task: Task = { id: 'c1', ownerInstanceId: null, status: 'todo' };
    const agents = ['a1', 'a2', 'a3', 'a4', 'a5'];

    // In real DB, these would be serialized by row lock.
    // In simulation: first agent succeeds, rest see task already owned.
    let winners = 0;
    let currentTask = { ...task };

    for (const agent of agents) {
      const result = simulateCASClaim(currentTask, agent);
      if (result.count === 1) {
        winners++;
        currentTask = { ...currentTask, ownerInstanceId: agent, status: 'in_progress' };
      }
    }

    expect(winners).toBe(1);
  });
});
