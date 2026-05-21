/**
 * Action WS events — payload contract + write-before-broadcast tests.
 *
 * Guards the event-contract hard constraint (per PM 071a6212 + 运维 review):
 * broadcast payloads are LOCATORS + controlled enums only — NEVER free-text
 * errors, paths, env, tokens, credential values, stdout/stderr, stacks, or
 * reviewer identity. Detailed/sensitive info lives behind the org-guarded
 * GET /actions/:id only.
 *
 * These are route-level tests (build the Fastify app, app.inject, capture what
 * publishControlEvent is called with) — they prove the WIRING emits a
 * contract-compliant payload, not just that the helper logic is correct.
 *
 * Coverage:
 *   1. action.created          → payload allowlist
 *   2. action.status_changed   → payload allowlist (reversible + irreversible fire)
 *   3. approval.decided        → payload allowlist (NO reviewer identity)
 *   4. write-before-broadcast  → publishControlEvent called before broadcast;
 *                                idempotent event is NOT re-broadcast
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { actionRoutes } from './actionRoutes';

// ── Payload contract ────────────────────────────────────────────────────────────
// Only these keys may appear in a broadcast event payload. Anything else is a leak.
const ALLOWLIST = new Set([
  'event_id', 'event_type', 'workroom_id', 'action_id', 'session_id',
  'approval_id', 'actor_agent_id',
  'status', 'reversibility', 'requires_approval', 'decision', 'decided_at',
  'reason_code',
]);

// Keys that MUST never appear (free text / sensitive). Belt-and-suspenders on top
// of the allowlist — makes a regression failure obvious.
const FORBIDDEN = [
  'reason', 'error', 'message', 'detail', 'command', 'cmd', 'args', 'path',
  'env', 'token', 'credential', 'credential_alias_ref', 'secret', 'password',
  'stdout', 'stderr', 'stack', 'reviewer_user_id', 'reviewer', 'summary',
  'risk_level',
];

function assertPayloadContract(payload: Record<string, unknown>) {
  for (const key of Object.keys(payload)) {
    expect(ALLOWLIST.has(key), `payload key '${key}' is not in the allowlist (possible detail leak)`).toBe(true);
  }
  for (const bad of FORBIDDEN) {
    expect(Object.prototype.hasOwnProperty.call(payload, bad), `payload must not contain forbidden key '${bad}'`).toBe(false);
  }
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockVerifyMachineToken = vi.fn();
const mockRequireMachineAccessToWorkroom = vi.fn();
const mockPublishControlEvent = vi.fn();
const mockBroadcast = vi.fn();

// db method mocks
const mockWorkroomFindUnique = vi.fn();
const mockActionCreate = vi.fn();
const mockActionFindUnique = vi.fn();
const mockActionUpdateMany = vi.fn();
const mockApprovalFindUnique = vi.fn();
const mockApprovalUpdate = vi.fn();
const mockTransaction = vi.fn();

// Order tracker: records the sequence of publish vs broadcast calls.
const callOrder: string[] = [];

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: (...a: unknown[]) => mockVerifyMachineToken(...a),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: (...a: unknown[]) => mockRequireMachineAccessToWorkroom(...a),
}));

vi.mock('@/control/events/publishControlEvent', () => ({
  publishControlEvent: (...a: unknown[]) => mockPublishControlEvent(...a),
}));

vi.mock('@/control/ws/workroomBroadcaster', () => ({
  workroomBroadcaster: {
    broadcast: (...a: unknown[]) => mockBroadcast(...a),
  },
}));

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: { findUnique: (...a: unknown[]) => mockWorkroomFindUnique(...a) },
    controlAction: {
      create: (...a: unknown[]) => mockActionCreate(...a),
      findUnique: (...a: unknown[]) => mockActionFindUnique(...a),
      updateMany: (...a: unknown[]) => mockActionUpdateMany(...a),
    },
    controlApproval: {
      findUnique: (...a: unknown[]) => mockApprovalFindUnique(...a),
      update: (...a: unknown[]) => mockApprovalUpdate(...a),
    },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

// ── App setup ───────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  app = fastify();
  await app.register(actionRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  // vi.resetAllMocks() clears calls AND resets mock implementations.
  // This prevents mock implementations set in one test (e.g. mockTransaction in the
  // irreversible fire test) from persisting into subsequent tests (e.g. write-before-broadcast).
  vi.resetAllMocks();
  callOrder.length = 0;
  mockVerifyMachineToken.mockResolvedValue({ id: 'machine-1', orgId: 'org-A' });
  mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-A' });
  // publishControlEvent: record order + return a non-idempotent event echoing the payload.
  mockPublishControlEvent.mockImplementation(async (input: { workroomId: string; eventId: string; topic: string; payload: Record<string, unknown> }) => {
    callOrder.push('publish');
    return {
      id: 'evt-1', eventId: input.eventId, workroomId: input.workroomId,
      seq: 1n, topic: input.topic, payloadJson: input.payload,
      createdAt: new Date(), idempotent: false,
    };
  });
  mockBroadcast.mockImplementation(() => { callOrder.push('broadcast'); });
});

/** Pull the payload that was published for a given topic. */
function publishedPayload(topic: string): Record<string, unknown> {
  const call = mockPublishControlEvent.mock.calls.find((c) => (c[0] as { topic: string }).topic === topic);
  expect(call, `no publishControlEvent call for topic '${topic}'`).toBeTruthy();
  return (call![0] as { payload: Record<string, unknown> }).payload;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('action events — payload contract', () => {
  it('action.created payload is locator + enum only', async () => {
    mockWorkroomFindUnique.mockResolvedValue({ id: 'wroom-A', orgId: 'org-A' });
    mockActionCreate.mockResolvedValue({
      id: 'act-1', sessionId: 'sess-1', workroomId: 'wroom-A', actorAgentId: 'agent-1',
      kind: 'shell', summary: 'rm -rf /tmp/x', reversibility: 'reversible', riskLevel: 'low',
      status: 'proposed', requiresApproval: false, createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/workrooms/wroom-A/actions',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: { session_id: 'sess-1', actor_agent_id: 'agent-1', kind: 'shell', summary: 'rm -rf /tmp/x', reversibility: 'reversible', risk_level: 'low', client_idempotency_key: 'k1' },
    });

    expect(res.statusCode).toBe(201);
    assertPayloadContract(publishedPayload('action.created'));
  });

  it('action.status_changed (reversible fire) payload is locator + status enum only', async () => {
    mockActionFindUnique.mockResolvedValue({
      id: 'act-1', workroomId: 'wroom-A', sessionId: 'sess-1', status: 'proposed',
      reversibility: 'reversible', workroom: { orgId: 'org-A' },
    });
    mockActionUpdateMany.mockResolvedValue({ count: 1 });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/act-1/fire',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    assertPayloadContract(publishedPayload('action.status_changed'));
  });

  it('action.status_changed (irreversible_no_abort fire) payload is locator + status enum only', async () => {
    const now = new Date();
    mockActionFindUnique.mockResolvedValue({
      id: 'act-2', workroomId: 'wroom-A', sessionId: 'sess-1', status: 'approved',
      reversibility: 'irreversible_no_abort', workroom: { orgId: 'org-A' },
    });
    mockApprovalFindUnique.mockResolvedValue({ id: 'appr-1', actionId: 'act-2', status: 'approved', decidedAt: now, expiresAt: null });
    // The fire transaction: run the callback with a tx that satisfies all 4 steps.
    // Step 4 (Phase 5B): tx.controlActionToken.create must be present.
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        controlApproval: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        controlActionApprovalConsumption: { create: vi.fn().mockResolvedValue({}) },
        controlAction: { update: vi.fn().mockResolvedValue({ id: 'act-2', sessionId: 'sess-1', workroomId: 'wroom-A', firedAt: now, approvedAtSnapshot: now }) },
        controlActionToken: { create: vi.fn().mockResolvedValue({}) },
      };
      return cb(tx);
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/actions/act-2/fire',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: { approval_id: 'appr-1' },
    });

    expect(res.statusCode).toBe(200);
    assertPayloadContract(publishedPayload('action.status_changed'));
  });

  it('approval.decided payload is locator + decision enum only — NO reviewer identity', async () => {
    mockApprovalFindUnique.mockResolvedValue({
      id: 'appr-1', actionId: 'act-1', workroomId: 'wroom-A', status: 'pending',
      workroom: { orgId: 'org-A' },
    });
    mockApprovalUpdate.mockResolvedValue({
      id: 'appr-1', actionId: 'act-1', workroomId: 'wroom-A', status: 'approved', decidedAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/approvals/appr-1/decide',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: { decision: 'approved', reviewer_user_id: 'user-secret-42' },
    });

    expect(res.statusCode).toBe(200);
    const payload = publishedPayload('approval.decided');
    assertPayloadContract(payload);
    // Specifically: the reviewer identity sent in the request must NOT be in the broadcast.
    expect(JSON.stringify(payload)).not.toContain('user-secret-42');
  });
});

describe('action events — write-before-broadcast', () => {
  it('publishControlEvent (DB persist) is called before broadcast (fanout)', async () => {
    mockActionFindUnique.mockResolvedValue({
      id: 'act-1', workroomId: 'wroom-A', sessionId: 'sess-1', status: 'proposed',
      reversibility: 'reversible', workroom: { orgId: 'org-A' },
    });
    mockActionUpdateMany.mockResolvedValue({ count: 1 });

    await app.inject({
      method: 'POST', url: '/api/v1/actions/act-1/fire',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: {},
    });

    expect(callOrder).toEqual(['publish', 'broadcast']);
  });

  it('idempotent event is NOT re-broadcast', async () => {
    mockActionFindUnique.mockResolvedValue({
      id: 'act-1', workroomId: 'wroom-A', sessionId: 'sess-1', status: 'proposed',
      reversibility: 'reversible', workroom: { orgId: 'org-A' },
    });
    mockActionUpdateMany.mockResolvedValue({ count: 1 });
    // Simulate idempotent retry: publishControlEvent returns idempotent=true.
    mockPublishControlEvent.mockImplementation(async (input: { eventId: string; topic: string; workroomId: string; payload: Record<string, unknown> }) => {
      callOrder.push('publish');
      return {
        id: 'evt-1', eventId: input.eventId, workroomId: input.workroomId,
        seq: 1n, topic: input.topic, payloadJson: input.payload,
        createdAt: new Date(), idempotent: true,
      };
    });

    await app.inject({
      method: 'POST', url: '/api/v1/actions/act-1/fire',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: {},
    });

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(callOrder).toEqual(['publish']);
  });
});
