/**
 * authorizeAgentApi — PURE-MOCK unit tests (no database).
 *
 * Covers:
 *   (a) missing / invalid machine token  → 401 MACHINE_TOKEN_INVALID
 *   (b) valid token but agent owned by a different machine  → 403 AGENT_NOT_OWNED
 *   (c) valid token but agent.machineId is null (unbound agent)  → 403 AGENT_NOT_OWNED
 *       (null !== machine.id must NOT slip through)
 *   (d) agent id not found in DB  → 403 AGENT_NOT_OWNED
 *       (design choice: "not found or not owned" both return 403 — do not leak existence)
 *   (e) valid token + owned agent  → { ok: true, machine, agent }
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────
// Both mocked BEFORE the module under test is imported so vi.mock hoisting works.

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
  db: {
    controlAgent: {
      findUnique: vi.fn(),
    },
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { authorizeAgentApi } from './agentApiAuth';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { db } from '@/storage/db';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockVerifyMachineToken = vi.mocked(verifyMachineToken);
const mockFindUnique = vi.mocked(db.controlAgent.findUnique);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MACHINE = {
  id: 'machine-uuid-1111',
  displayName: 'Test Machine',
  platform: 'darwin',
  arch: 'arm64',
  tokenHash: 'somehash',
  tokenExpiresAt: new Date(Date.now() + 86400_000),
  orgId: 'org-uuid-aaaa',
  boundAt: new Date(),
  lastSeenAt: new Date(),
  createdAt: new Date(),
};

const AGENT = {
  id: 'agent-uuid-2222',
  machineId: 'machine-uuid-1111',  // owned by MACHINE
  name: 'PM Agent',
  displayName: 'PM Agent',
  orgId: 'org-uuid-aaaa',
  role: 'other',
  status: 'online',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Build a minimal Fastify-like request with the given headers. */
function makeRequest(headers: Record<string, string | undefined>) {
  return { headers } as unknown as import('fastify').FastifyRequest;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('authorizeAgentApi', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── (a) missing / invalid machine token ──────────────────────────────────

  it('(a) returns 401 MACHINE_TOKEN_INVALID when Authorization header is absent', async () => {
    mockVerifyMachineToken.mockResolvedValue(null);

    const req = makeRequest({ authorization: undefined, 'x-mio-agent-id': AGENT.id });
    const result = await authorizeAgentApi(req);

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: 'MACHINE_TOKEN_INVALID',
    });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('(a) returns 401 MACHINE_TOKEN_INVALID when token is expired/invalid', async () => {
    mockVerifyMachineToken.mockResolvedValue(null);

    const req = makeRequest({
      authorization: 'Bearer bad-token',
      'x-mio-agent-id': AGENT.id,
    });
    const result = await authorizeAgentApi(req);

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: 'MACHINE_TOKEN_INVALID',
    });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  // ── (b) valid token but agent owned by a DIFFERENT machine ───────────────

  it('(b) returns 403 AGENT_NOT_OWNED when agent.machineId !== machine.id', async () => {
    mockVerifyMachineToken.mockResolvedValue(MACHINE as never);
    const wrongMachineAgent = { ...AGENT, machineId: 'machine-uuid-DIFFERENT' };
    mockFindUnique.mockResolvedValue(wrongMachineAgent as never);

    const req = makeRequest({
      authorization: 'Bearer valid-token',
      'x-mio-agent-id': AGENT.id,
    });
    const result = await authorizeAgentApi(req);

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: 'AGENT_NOT_OWNED',
    });
  });

  // ── (c) valid token but agent.machineId is null (unbound agent) ──────────

  it('(c) returns 403 AGENT_NOT_OWNED when agent.machineId is null', async () => {
    mockVerifyMachineToken.mockResolvedValue(MACHINE as never);
    const unboundAgent = { ...AGENT, machineId: null };
    mockFindUnique.mockResolvedValue(unboundAgent as never);

    const req = makeRequest({
      authorization: 'Bearer valid-token',
      'x-mio-agent-id': AGENT.id,
    });
    const result = await authorizeAgentApi(req);

    // null === machine.id must NOT pass — this is the critical null-safety check.
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: 'AGENT_NOT_OWNED',
    });
  });

  // ── (d) agent id not found ────────────────────────────────────────────────

  it('(d) returns 403 AGENT_NOT_OWNED when agent is not found (anti-enumeration: not-found = not-owned)', async () => {
    mockVerifyMachineToken.mockResolvedValue(MACHINE as never);
    mockFindUnique.mockResolvedValue(null);

    const req = makeRequest({
      authorization: 'Bearer valid-token',
      'x-mio-agent-id': 'non-existent-agent-id',
    });
    const result = await authorizeAgentApi(req);

    // Design: 403 AGENT_NOT_OWNED for both "not found" and "not owned".
    // Do not leak agent existence to callers who hold a valid machine token.
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: 'AGENT_NOT_OWNED',
    });
  });

  // ── (d') valid token but X-Mio-Agent-Id header absent ─────────────────────

  it('returns 403 AGENT_NOT_OWNED when X-Mio-Agent-Id header is absent', async () => {
    mockVerifyMachineToken.mockResolvedValue(MACHINE as never);

    const req = makeRequest({ authorization: 'Bearer valid-token' });
    const result = await authorizeAgentApi(req);

    // No agent id → never reaches the DB; uniform 403 (do not leak existence).
    expect(result).toMatchObject({ ok: false, status: 403, code: 'AGENT_NOT_OWNED' });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  // ── (e) valid token + owned agent → success ───────────────────────────────

  it('(e) returns { ok: true, machine, agent } for a valid token with an owned agent', async () => {
    mockVerifyMachineToken.mockResolvedValue(MACHINE as never);
    mockFindUnique.mockResolvedValue(AGENT as never);

    const req = makeRequest({
      authorization: 'Bearer valid-token',
      'x-mio-agent-id': AGENT.id,
    });
    const result = await authorizeAgentApi(req);

    expect(result).toEqual({
      ok: true,
      machine: MACHINE,
      agent: AGENT,
    });
  });

  // ── (e) verifyMachineToken receives the correct Authorization header ──────

  it('passes the Authorization header to verifyMachineToken', async () => {
    mockVerifyMachineToken.mockResolvedValue(null);

    const req = makeRequest({
      authorization: 'Bearer the-actual-token',
      'x-mio-agent-id': AGENT.id,
    });
    await authorizeAgentApi(req);

    expect(mockVerifyMachineToken).toHaveBeenCalledWith('Bearer the-actual-token');
  });

  // ── (e) db.controlAgent.findUnique is called with the correct agent id ───

  it('queries db.controlAgent.findUnique with the X-Mio-Agent-Id header value', async () => {
    mockVerifyMachineToken.mockResolvedValue(MACHINE as never);
    mockFindUnique.mockResolvedValue(AGENT as never);

    const req = makeRequest({
      authorization: 'Bearer valid-token',
      'x-mio-agent-id': AGENT.id,
    });
    await authorizeAgentApi(req);

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: AGENT.id },
    });
  });
});
