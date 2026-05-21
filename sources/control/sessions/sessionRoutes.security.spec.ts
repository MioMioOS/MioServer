/**
 * Sessions API — route-level org guard tests.
 *
 * These tests build a real Fastify app with mocked dependencies and use
 * app.inject() to verify the HTTP layer actually enforces org authorization.
 * Helper unit tests (machineAccess.spec.ts) prove the guard logic is correct;
 * these tests prove the routes are wired up to call the guard.
 *
 * Coverage:
 *   1. GET  /workrooms/:workroomId/sessions        → cross-org 403; DB not queried
 *   2. GET  /sessions/:id                          → cross-org 403
 *   3. PATCH /sessions/:id/status                  → cross-org 403 before business logic (no DB write)
 *   4. POST  /sessions/:id/heartbeat               → cross-org 403 before terminal check (not 409)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { sessionRoutes } from './sessionRoutes';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockVerifyMachineToken = vi.fn();
const mockRequireMachineAccessToWorkroom = vi.fn();
const mockSessionFindUnique = vi.fn();
const mockSessionFindMany = vi.fn();
const mockSessionCreate = vi.fn();
const mockSessionUpdate = vi.fn();
const mockMachineFindFirst = vi.fn();
const mockPublishControlEvent = vi.fn();

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: (...args: unknown[]) => mockVerifyMachineToken(...args),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: (...args: unknown[]) => mockRequireMachineAccessToWorkroom(...args),
}));

vi.mock('@/storage/db', () => ({
  db: {
    controlSession: {
      findUnique: (...args: unknown[]) => mockSessionFindUnique(...args),
      findMany: (...args: unknown[]) => mockSessionFindMany(...args),
      create: (...args: unknown[]) => mockSessionCreate(...args),
      update: (...args: unknown[]) => mockSessionUpdate(...args),
    },
    controlMachine: {
      findFirst: (...args: unknown[]) => mockMachineFindFirst(...args),
    },
    controlWorkroom: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/control/events/publishControlEvent', () => ({
  publishControlEvent: (...args: unknown[]) => mockPublishControlEvent(...args),
}));

// ── Test App Setup ─────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  app = fastify();
  await app.register(sessionRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: valid machine token for org-A
  mockVerifyMachineToken.mockResolvedValue({ id: 'machine-1', orgId: 'org-A' });
});

// ── Shared fixtures ────────────────────────────────────────────────────────────

const CROSS_ORG_DENIED = {
  ok: false,
  status: 403,
  error: { code: 'FORBIDDEN', message: 'Machine org does not match workroom org' },
} as const;

/** A session row belonging to org-B (cross-org from machine in org-A) */
const SESSION_ORG_B = {
  id: 'session-B',
  orgId: 'org-B',
  workroomId: 'wroom-B',
  machineId: null,
  mode: 'daemon',
  runtime: 'claude',
  displayName: 'Agent B',
  status: 'idle',
  currentTaskId: null,
  capabilities: {},
  lastActivityAt: new Date(),
  createdAt: new Date(),
};

/** A terminal session in org-B — used to verify 403 fires before 409 SESSION_TERMINAL */
const TERMINAL_SESSION_ORG_B = { ...SESSION_ORG_B, status: 'completed' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Session routes — org guard (route-level)', () => {

  // ── 1. LIST ──────────────────────────────────────────────────────────────────
  describe('GET /api/v1/workrooms/:workroomId/sessions', () => {
    it('cross-org 403: machine in org-A blocked from listing org-B sessions', async () => {
      mockRequireMachineAccessToWorkroom.mockResolvedValue(CROSS_ORG_DENIED);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workrooms/wroom-B/sessions',
        headers: { authorization: 'Bearer token' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
      // Guard must prevent any DB query — session topology is org-scoped data
      expect(mockSessionFindMany).not.toHaveBeenCalled();
    });

    it('403 when machine has no bound org', async () => {
      mockRequireMachineAccessToWorkroom.mockResolvedValue({
        ok: false,
        status: 403,
        error: { code: 'MACHINE_NO_ORG', message: 'Machine has not bound an org.' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workrooms/wroom-A/sessions',
        headers: { authorization: 'Bearer token' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('MACHINE_NO_ORG');
      expect(mockSessionFindMany).not.toHaveBeenCalled();
    });
  });

  // ── 2. GET detail ─────────────────────────────────────────────────────────────
  describe('GET /api/v1/sessions/:id', () => {
    it('cross-org 403: machine in org-A blocked from reading org-B session', async () => {
      mockSessionFindUnique.mockResolvedValue(SESSION_ORG_B);
      mockRequireMachineAccessToWorkroom.mockResolvedValue(CROSS_ORG_DENIED);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/session-B',
        headers: { authorization: 'Bearer token' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
    });

    it('404 when session does not exist', async () => {
      mockSessionFindUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/nonexistent',
        headers: { authorization: 'Bearer token' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── 3. PATCH status ───────────────────────────────────────────────────────────
  describe('PATCH /api/v1/sessions/:id/status', () => {
    it('cross-org 403: guard fires BEFORE validateStatusTransition (no 409 leakage)', async () => {
      // Session is in org-B — machine in org-A should get 403, not 409 INVALID_TRANSITION
      mockSessionFindUnique.mockResolvedValue(SESSION_ORG_B);
      mockRequireMachineAccessToWorkroom.mockResolvedValue(CROSS_ORG_DENIED);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/sessions/session-B/status',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        payload: { status: 'running' },
      });

      // Must be 403, not 409 — cross-org requests must not probe session state
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
      // No DB write should have occurred
      expect(mockSessionUpdate).not.toHaveBeenCalled();
      expect(mockPublishControlEvent).not.toHaveBeenCalled();
    });

    it('cross-org 403: guard fires even for terminal sessions (no state-probing via 409)', async () => {
      // If terminal session were checked before org guard, cross-org would get 409 instead of 403
      mockSessionFindUnique.mockResolvedValue(TERMINAL_SESSION_ORG_B);
      mockRequireMachineAccessToWorkroom.mockResolvedValue(CROSS_ORG_DENIED);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/sessions/session-B/status',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        payload: { status: 'idle' },
      });

      // Must be 403, not 409 — guard runs before transition validation
      expect(res.statusCode).toBe(403);
    });
  });

  // ── 4. POST heartbeat ─────────────────────────────────────────────────────────
  describe('POST /api/v1/sessions/:id/heartbeat', () => {
    it('cross-org 403: guard fires BEFORE terminal check (no 409 SESSION_TERMINAL leakage)', async () => {
      // Session is terminal in org-B — cross-org should get 403, NOT 409 SESSION_TERMINAL
      // If terminal check ran first, attacker could probe whether a foreign session is terminal.
      mockSessionFindUnique.mockResolvedValue(TERMINAL_SESSION_ORG_B);
      mockRequireMachineAccessToWorkroom.mockResolvedValue(CROSS_ORG_DENIED);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/session-B/heartbeat',
        headers: { authorization: 'Bearer token' },
      });

      // Must be 403, not 409 — org guard is checked before terminal status check
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
      expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it('cross-org 403: active session in org-B also blocked', async () => {
      mockSessionFindUnique.mockResolvedValue(SESSION_ORG_B);
      mockRequireMachineAccessToWorkroom.mockResolvedValue(CROSS_ORG_DENIED);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/session-B/heartbeat',
        headers: { authorization: 'Bearer token' },
      });

      expect(res.statusCode).toBe(403);
      expect(mockSessionUpdate).not.toHaveBeenCalled();
    });
  });
});
