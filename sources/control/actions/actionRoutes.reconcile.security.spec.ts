/**
 * Action reconcile (Phase 5C) — route-level guard tests.
 *
 * These tests build a real Fastify app with mocked dependencies and use
 * app.inject() to exercise the actual route handler code. They cover the
 * two guard layers that the simulation tests (actionRoutes.reconcile.spec.ts)
 * cannot reach:
 *
 *   Layer 1: workroom org guard — requireMachineAccessToWorkroom(machine, action.workroomId)
 *            (the bug fixed: was passing workroomId as orgId override — always 403)
 *   Layer 2: firing-machine guard — tokenRecord.machineId !== machine.id → 403
 *
 * Coverage:
 *   1. POSITIVE — same-org firing machine → 200 needs_human (proves guard + CAS wiring work)
 *   2. NEGATIVE — cross-org machine → 403 FORBIDDEN from workroom guard
 *   3. NEGATIVE — same-org but NOT firing machine → 403 RECONCILE_FORBIDDEN from machine guard
 *   4. NEGATIVE — no token row for action → 403 RECONCILE_GUARD_FAILED
 *   5. event contract — action.needs_human payload: locator + status + reason_code only
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { actionRoutes } from './actionRoutes';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockVerifyMachineToken = vi.fn();
const mockRequireMachineAccessToWorkroom = vi.fn();
const mockPublishControlEvent = vi.fn();
const mockBroadcast = vi.fn();

// db method mocks — must cover all tables referenced by actionRoutes
const mockActionFindUnique = vi.fn();
const mockActionUpdateMany = vi.fn();
const mockTokenFindFirst = vi.fn();
const mockTransaction = vi.fn();

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
    controlWorkroom: { findUnique: vi.fn() },
    controlAction: {
      create: vi.fn(),
      findUnique: (...a: unknown[]) => mockActionFindUnique(...a),
      updateMany: (...a: unknown[]) => mockActionUpdateMany(...a),
      update: vi.fn(),
    },
    controlActionToken: {
      findFirst: (...a: unknown[]) => mockTokenFindFirst(...a),
      updateMany: vi.fn(),
    },
    controlActionReconciliation: { create: vi.fn() },
    controlApproval: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    controlActionApprovalConsumption: { create: vi.fn() },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

// ── App setup ──────────────────────────────────────────────────────────────────

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
  vi.resetAllMocks();

  // Default: valid machine in org-A (the firing machine)
  mockVerifyMachineToken.mockResolvedValue({ id: 'machine-1', orgId: 'org-A' });

  // publishControlEvent: return a minimal non-idempotent result
  mockPublishControlEvent.mockResolvedValue({
    id: 'evt-1', eventId: 'evt-uuid', workroomId: 'wroom-A',
    seq: 1n, topic: 'action.needs_human', payloadJson: {},
    createdAt: new Date(), idempotent: false,
  });
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

const FIRED_ACTION = {
  id: 'act-1',
  workroomId: 'wroom-A',
  sessionId: 'sess-1',
  status: 'fired',
  reversibility: 'reversible',
  kind: 'shell',
  summary: 'run build',
};

const FIRING_TOKEN_ROW = {
  actionId: 'act-1',
  machineId: 'machine-1',   // the firing machine
};

const VALID_BODY = {
  reason: 'fire_response_lost_token_unrecoverable',
  evidence_id: 'evidence-uuid-1',
};

const ORG_GUARD_DENIED = {
  ok: false,
  status: 403,
  error: { code: 'FORBIDDEN', message: 'Machine org does not match workroom org' },
} as const;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('reconcile route — guard layer coverage (route-level)', () => {

  // ── 1. Positive path ────────────────────────────────────────────────────────
  describe('POST /api/v1/actions/:id/reconcile — positive path', () => {
    it('same-org firing machine → 200 needs_human (guard + CAS wiring)', async () => {
      // Both guard layers pass; transaction returns CAS count=1
      mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-A' });
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      mockTokenFindFirst.mockResolvedValue(FIRING_TOKEN_ROW);

      // Transaction: INSERT evidence + CAS returns count=1
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<number>) => {
        return fn({
          controlActionReconciliation: { create: vi.fn().mockResolvedValue({}) },
          controlAction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('needs_human');
      expect(body.idempotent).toBe(false);
      expect(body.reason_code).toBe('fire_response_lost_token_unrecoverable');

      // Guard was called with correct args — no workroomId-as-orgId override
      expect(mockRequireMachineAccessToWorkroom).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'machine-1', orgId: 'org-A' }),
        'wroom-A',
        // Must NOT pass a third arg with orgId: 'wroom-A' (the old bug)
      );
      expect(mockRequireMachineAccessToWorkroom.mock.calls[0].length).toBe(2);
    });

    it('event published after CAS transition: action.needs_human with correct payload', async () => {
      mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-A' });
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      mockTokenFindFirst.mockResolvedValue(FIRING_TOKEN_ROW);
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<number>) => {
        return fn({
          controlActionReconciliation: { create: vi.fn().mockResolvedValue({}) },
          controlAction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        });
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      // Verify publishControlEvent was called with action.needs_human
      expect(mockPublishControlEvent).toHaveBeenCalledOnce();
      const publishCall = mockPublishControlEvent.mock.calls[0][0] as {
        topic: string;
        payload: Record<string, unknown>;
      };
      expect(publishCall.topic).toBe('action.needs_human');

      // Payload contract: locator + status + reason_code only
      const payload = publishCall.payload;
      expect(payload.workroom_id).toBe('wroom-A');
      expect(payload.action_id).toBe('act-1');
      expect(payload.session_id).toBe('sess-1');
      expect(payload.status).toBe('needs_human');
      expect(payload.reason_code).toBe('fire_response_lost_token_unrecoverable');

      // Must NOT leak: evidence_id, machine_id, raw token, secret
      expect('evidence_id' in payload).toBe(false);
      expect('machine_id' in payload).toBe(false);
      const payloadStr = JSON.stringify(payload);
      expect(payloadStr).not.toMatch(/act_tok_/);
      expect(payloadStr).not.toMatch(/secret/);
    });
  });

  // ── 2. Layer 1: workroom org guard ────────────────────────────────────────────
  describe('POST /api/v1/actions/:id/reconcile — workroom org guard (Layer 1)', () => {
    it('cross-org machine → 403 FORBIDDEN (org guard rejects; no token lookup)', async () => {
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      // Org guard rejects (machine.orgId != workroom.orgId)
      mockRequireMachineAccessToWorkroom.mockResolvedValue(ORG_GUARD_DENIED);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');

      // Firing-machine guard must not be reached — no token lookup
      expect(mockTokenFindFirst).not.toHaveBeenCalled();
      // No DB write
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockPublishControlEvent).not.toHaveBeenCalled();
    });

    it('machine has no bound org → 403 MACHINE_NO_ORG', async () => {
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      mockRequireMachineAccessToWorkroom.mockResolvedValue({
        ok: false,
        status: 403,
        error: { code: 'MACHINE_NO_ORG', message: 'Machine has not bound an org.' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('MACHINE_NO_ORG');
      expect(mockTokenFindFirst).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('workroom guard is called with (machine, action.workroomId) — no erroneous orgId override', async () => {
      // This is the regression test for the bug: was incorrectly called with
      // requireMachineAccessToWorkroom(machine, action.workroomId, { orgId: action.workroomId })
      // which caused the guard to ALWAYS return 403 (orgId UUID != workroomId UUID).
      // Fix: call without override — let the function look up workroom.orgId itself.
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-A' });
      mockTokenFindFirst.mockResolvedValue(FIRING_TOKEN_ROW);
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<number>) => {
        return fn({
          controlActionReconciliation: { create: vi.fn().mockResolvedValue({}) },
          controlAction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        });
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      // Should be called with exactly 2 args (no override)
      const callArgs = mockRequireMachineAccessToWorkroom.mock.calls[0];
      expect(callArgs.length).toBe(2);
      expect(callArgs[1]).toBe('wroom-A');
      // Verify the third arg is NOT { orgId: 'wroom-A' } (the old bug)
      expect(callArgs[2]).toBeUndefined();
    });
  });

  // ── 3. Layer 2: firing-machine guard ──────────────────────────────────────────
  describe('POST /api/v1/actions/:id/reconcile — firing-machine guard (Layer 2)', () => {
    it('same-org but NOT firing machine → 403 RECONCILE_FORBIDDEN', async () => {
      // machine-2 is in org-A (passes org guard) but machine-1 fired the action
      mockVerifyMachineToken.mockResolvedValue({ id: 'machine-2', orgId: 'org-A' });
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-A' });
      // Token row says machine-1 fired it — machine-2 must be rejected
      mockTokenFindFirst.mockResolvedValue({ actionId: 'act-1', machineId: 'machine-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-2-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('RECONCILE_FORBIDDEN');
      // No DB write
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockPublishControlEvent).not.toHaveBeenCalled();
    });

    it('no token row for action → 403 RECONCILE_GUARD_FAILED', async () => {
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-A' });
      // No token row — old data or anomaly
      mockTokenFindFirst.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('RECONCILE_GUARD_FAILED');
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('same-org same machine (machine-A forges reconcile for machine-A same action) — NOT a guard bypass', async () => {
      // This is the legitimate path — same machine, same org. Guard passes.
      mockActionFindUnique.mockResolvedValue(FIRED_ACTION);
      mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-A' });
      mockTokenFindFirst.mockResolvedValue(FIRING_TOKEN_ROW);  // machineId = 'machine-1'
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<number>) => {
        return fn({
          controlActionReconciliation: { create: vi.fn().mockResolvedValue({}) },
          controlAction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        });
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      // Legitimate firing machine: should succeed
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('needs_human');
    });
  });

  // ── 4. Auth guard ─────────────────────────────────────────────────────────────
  describe('POST /api/v1/actions/:id/reconcile — auth', () => {
    it('no Authorization header → 401 UNAUTHORIZED', async () => {
      mockVerifyMachineToken.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(401);
      expect(mockActionFindUnique).not.toHaveBeenCalled();
    });

    it('invalid machine token → 401 UNAUTHORIZED', async () => {
      mockVerifyMachineToken.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/actions/act-1/reconcile',
        headers: { authorization: 'Bearer invalid-token', 'content-type': 'application/json' },
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
