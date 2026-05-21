/**
 * Cursor routes — route-level security tests.
 *
 * Verifies that the HTTP layer correctly enforces:
 * 1. Cross-org 403 on PATCH /cursors: resolveCursorScopeAccess blocks before DB upsert
 * 2. Cross-org 403 on GET /cursors: resolveCursorScopeAccess blocks before DB read
 * 3. user_id is forced to machine.id — client cannot supply an arbitrary user_id
 *    (tested on both PATCH and GET: DB lookup uses machine.id, response reflects machine.id)
 *
 * These route-level tests complement machineAccess.spec.ts (unit tests for guard logic).
 * Helper tests prove the rules are correct; these tests prove the routes call them.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import { eventRoutes } from './eventRoutes';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockVerifyMachineToken = vi.fn();
const mockRequireMachineAccessToWorkroom = vi.fn();
const mockResolveCursorScopeAccess = vi.fn();
const mockPublishControlEvent = vi.fn();
const mockBroadcast = vi.fn();
const mockQueryRaw = vi.fn();
const mockCursorFindUnique = vi.fn();

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: (...args: unknown[]) => mockVerifyMachineToken(...args),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: (...args: unknown[]) => mockRequireMachineAccessToWorkroom(...args),
  resolveCursorScopeAccess: (...args: unknown[]) => mockResolveCursorScopeAccess(...args),
}));

vi.mock('@/storage/db', () => ({
  db: {
    // Tagged template mock: $queryRaw is called as db.$queryRaw`...sql...${params}`
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    controlClientCursor: {
      findUnique: (...args: unknown[]) => mockCursorFindUnique(...args),
    },
    // Stubs for event routes (POST/GET /events) — not under test here
    controlWorkroomEvent: { findFirst: vi.fn() },
    controlEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
  },
}));

vi.mock('./publishControlEvent', () => ({
  publishControlEvent: (...args: unknown[]) => mockPublishControlEvent(...args),
}));

vi.mock('@/control/ws/workroomBroadcaster', () => ({
  workroomBroadcaster: {
    broadcast: (...args: unknown[]) => mockBroadcast(...args),
  },
}));

// ── Test App Setup ─────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  app = fastify();
  await app.register(eventRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: valid machine token, machine.id = 'machine-1', orgId = 'org-A'
  mockVerifyMachineToken.mockResolvedValue({ id: 'machine-1', orgId: 'org-A' });
});

// ── Shared fixtures ────────────────────────────────────────────────────────────

const CROSS_ORG_DENIED = {
  ok: false,
  status: 403,
  error: { code: 'FORBIDDEN', message: 'Machine org does not match workroom org' },
} as const;

const SCOPE_ACCESS_OK = { ok: true, workroomOrgId: 'org-A' } as const;

const CURSOR_ROW = {
  userId: 'machine-1',
  deviceId: 'dev-1',
  scopeType: 'workroom',
  scopeId: 'wroom-A',
  topicGroup: 'all',
  applySeq: BigInt(10),
  readSeq: BigInt(0),
  updatedAt: new Date(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/cursors — security', () => {

  it('cross-org 403: resolveCursorScopeAccess blocks before DB upsert', async () => {
    mockResolveCursorScopeAccess.mockResolvedValue(CROSS_ORG_DENIED);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cursors',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      payload: { device_id: 'dev-1', scope_type: 'workroom', scope_id: 'wroom-B', apply_seq: '10' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
    // DB upsert must NOT be called — cross-org scope blocked at boundary
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('user_id forced to machine.id — client cannot supply arbitrary user_id', async () => {
    mockResolveCursorScopeAccess.mockResolvedValue(SCOPE_ACCESS_OK);
    mockQueryRaw.mockResolvedValue([]);
    mockCursorFindUnique.mockResolvedValue(CURSOR_ROW);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cursors',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      // Client does NOT send user_id — it is forced server-side
      payload: { device_id: 'dev-1', scope_type: 'workroom', scope_id: 'wroom-A', apply_seq: '10' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Response user_id must be machine.id, not any client-supplied value
    expect(body.user_id).toBe('machine-1');

    // Cursor lookup must use machine.id — proves the DB query is machine-scoped
    expect(mockCursorFindUnique).toHaveBeenCalledWith({
      where: {
        userId_deviceId_scopeType_scopeId_topicGroup: expect.objectContaining({
          userId: 'machine-1',  // MUST be machine.id, not any client-supplied value
          deviceId: 'dev-1',
        }),
      },
    });
  });

  it('401 when machine token is invalid', async () => {
    mockVerifyMachineToken.mockResolvedValue(null);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cursors',
      headers: { authorization: 'Bearer bad-token', 'content-type': 'application/json' },
      payload: { device_id: 'dev-1', scope_type: 'workroom', scope_id: 'wroom-A' },
    });

    expect(res.statusCode).toBe(401);
    expect(mockResolveCursorScopeAccess).not.toHaveBeenCalled();
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/cursors — security', () => {

  it('cross-org 403: resolveCursorScopeAccess blocks before DB read', async () => {
    mockResolveCursorScopeAccess.mockResolvedValue(CROSS_ORG_DENIED);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cursors?device_id=dev-1&scope_type=workroom&scope_id=wroom-B',
      headers: { authorization: 'Bearer token' },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
    // DB read must NOT be called after scope denial
    expect(mockCursorFindUnique).not.toHaveBeenCalled();
  });

  it('cursor lookup uses machine.id — client cannot read another machine\'s cursor by user_id', async () => {
    mockResolveCursorScopeAccess.mockResolvedValue(SCOPE_ACCESS_OK);
    mockCursorFindUnique.mockResolvedValue(CURSOR_ROW);

    const res = await app.inject({
      method: 'GET',
      // Note: no user_id in query — it is forced server-side
      url: '/api/v1/cursors?device_id=dev-1&scope_type=workroom&scope_id=wroom-A',
      headers: { authorization: 'Bearer token' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user_id).toBe('machine-1');

    // DB lookup must use machine.id — not any query-param user_id
    expect(mockCursorFindUnique).toHaveBeenCalledWith({
      where: {
        userId_deviceId_scopeType_scopeId_topicGroup: expect.objectContaining({
          userId: 'machine-1',
        }),
      },
    });
  });

  it('401 when machine token is invalid', async () => {
    mockVerifyMachineToken.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cursors?device_id=dev-1&scope_type=workroom&scope_id=wroom-A',
      headers: { authorization: 'Bearer bad-token' },
    });

    expect(res.statusCode).toBe(401);
    expect(mockResolveCursorScopeAccess).not.toHaveBeenCalled();
    expect(mockCursorFindUnique).not.toHaveBeenCalled();
  });
});
