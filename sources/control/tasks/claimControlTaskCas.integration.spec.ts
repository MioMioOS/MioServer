/**
 * Integration tests for claimControlTaskCas — the shared CAS claim primitive.
 *
 * Real Postgres DB required: npm run test:db:setup && npm run test:integration
 *
 * Contract under test:
 *   claimControlTaskCas(taskId, agentId) returns a discriminated result:
 *     { ok: true }                          — unclaimed task claimed successfully
 *     { ok: true, alreadyOwn: true }        — task was already owned by THIS agentId (idempotent)
 *     { ok: false, reason: 'not_found' }    — no task with that id
 *     { ok: false, reason: 'terminal' }     — status ∈ done|canceled
 *     { ok: false, reason: 'owned_by_other' } — owned by a different agent
 *
 * Concurrency case: two simultaneous calls on the same unclaimed task → exactly one ok:true,
 * the other owned_by_other; final DB row has exactly one owner.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { claimControlTaskCas } from './claimControlTaskCas';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const AGENT_A_ID = randomUUID();
const AGENT_B_ID = randomUUID();

/** Create a ControlTask row and return its id. channelId is optional (nullable). */
async function makeTask(status: string, ownerInstanceId?: string): Promise<string> {
  const task = await db.controlTask.create({
    data: {
      workroomId: WORKROOM_ID,
      title: `cas-test-${randomUUID()}`,
      status,
      ...(ownerInstanceId !== undefined ? { ownerInstanceId } : {}),
    },
  });
  return task.id;
}

beforeAll(async () => {
  await db.controlOrg.create({
    data: { id: ORG_ID, name: 'CasTest Org', slug: `cas-${randomUUID()}`, ownerUserId: randomUUID() },
  });
  await db.controlAgent.create({
    data: { id: AGENT_A_ID, orgId: ORG_ID, name: 'agent-a', displayName: 'Agent A', role: 'ops' },
  });
  await db.controlAgent.create({
    data: { id: AGENT_B_ID, orgId: ORG_ID, name: 'agent-b', displayName: 'Agent B', role: 'ops' },
  });
  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'CasTest WR', createdBy: randomUUID() },
  });
});

afterAll(async () => {
  await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { id: { in: [AGENT_A_ID, AGENT_B_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await db.$disconnect();
});

// ── Basic cases ───────────────────────────────────────────────────────────────────

describe('claimControlTaskCas — basic cases', () => {
  it('unclaimed todo → ok:true; row mutated to in_progress + ownerInstanceId set', async () => {
    const taskId = await makeTask('todo');
    const result = await claimControlTaskCas(taskId, AGENT_A_ID);

    expect(result).toEqual({ ok: true });

    const row = await db.controlTask.findUnique({ where: { id: taskId } });
    expect(row).not.toBeNull();
    expect(row!.ownerInstanceId).toBe(AGENT_A_ID);
    expect(row!.status).toBe('in_progress');
  });

  it('unclaimed in_progress (no owner) → ok:true; claimable non-terminal status', async () => {
    const taskId = await makeTask('in_progress');
    const result = await claimControlTaskCas(taskId, AGENT_A_ID);

    expect(result).toEqual({ ok: true });

    const row = await db.controlTask.findUnique({ where: { id: taskId } });
    expect(row!.ownerInstanceId).toBe(AGENT_A_ID);
    expect(row!.status).toBe('in_progress');
  });

  it('self-claim (task already owned by THIS agentId) → { ok:true, alreadyOwn:true, task }', async () => {
    const taskId = await makeTask('in_progress', AGENT_A_ID);
    const result = await claimControlTaskCas(taskId, AGENT_A_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.alreadyOwn).toBe(true);
    // Result carries the freshly-read task so the route avoids a 2nd findUnique.
    expect(result.alreadyOwn && result.task.id).toBe(taskId);
    expect(result.alreadyOwn && result.task.ownerInstanceId).toBe(AGENT_A_ID);

    // Row must be unchanged
    const row = await db.controlTask.findUnique({ where: { id: taskId } });
    expect(row!.ownerInstanceId).toBe(AGENT_A_ID);
  });

  it('owned by other agent → { ok:false, reason:"owned_by_other", task }', async () => {
    const taskId = await makeTask('in_progress', AGENT_A_ID);
    const result = await claimControlTaskCas(taskId, AGENT_B_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('owned_by_other');
    // Carried task lets the route surface current_owner_instance_id without a re-read.
    expect(result.reason === 'owned_by_other' && result.task.ownerInstanceId).toBe(AGENT_A_ID);

    // Owner must not have changed
    const row = await db.controlTask.findUnique({ where: { id: taskId } });
    expect(row!.ownerInstanceId).toBe(AGENT_A_ID);
  });

  it('terminal status "done" → { ok:false, reason:"terminal", task }', async () => {
    const taskId = await makeTask('done');
    const result = await claimControlTaskCas(taskId, AGENT_A_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('terminal');
    // Carried task lets the route build the "Task is <status>" message without a re-read.
    expect(result.reason === 'terminal' && result.task.status).toBe('done');
  });

  it('terminal status "canceled" → { ok:false, reason:"terminal", task }', async () => {
    const taskId = await makeTask('canceled');
    const result = await claimControlTaskCas(taskId, AGENT_A_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.reason).toBe('terminal');
    expect(result.reason === 'terminal' && result.task.status).toBe('canceled');
  });

  it('non-existent taskId → { ok:false, reason:"not_found" }', async () => {
    const result = await claimControlTaskCas(randomUUID(), AGENT_A_ID);

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ── Concurrency case ──────────────────────────────────────────────────────────────

describe('claimControlTaskCas — concurrency', () => {
  it('two simultaneous claims on unclaimed task → exactly one ok:true, one owned_by_other', async () => {
    const taskId = await makeTask('todo');

    // Fire both calls concurrently (Promise.all does not guarantee interleaving,
    // but PostgreSQL row-level locking serializes the two updateMany statements,
    // so exactly one wins regardless of JS scheduling).
    const [r1, r2] = await Promise.all([
      claimControlTaskCas(taskId, AGENT_A_ID),
      claimControlTaskCas(taskId, AGENT_B_ID),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok === true).length;
    const failCount = [r1, r2].filter((r) => r.ok === false && (r as { ok: false; reason: string }).reason === 'owned_by_other').length;

    expect(okCount).toBe(1);
    expect(failCount).toBe(1);

    // The winner's agentId must be stored on the row.
    const row = await db.controlTask.findUnique({ where: { id: taskId } });
    expect(row!.ownerInstanceId).not.toBeNull();
    expect(row!.status).toBe('in_progress');

    const winnerAgentId = r1.ok ? AGENT_A_ID : AGENT_B_ID;
    expect(row!.ownerInstanceId).toBe(winnerAgentId);
  });
});
