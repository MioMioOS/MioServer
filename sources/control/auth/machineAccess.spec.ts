import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireMachineAccessToWorkroom, resolveCursorScopeAccess } from './machineAccess';

/**
 * machineAccess unit tests.
 *
 * Tests cover:
 * 1. Machine with no orgId → 403 MACHINE_NO_ORG
 * 2. Workroom not found → 404 WORKROOM_NOT_FOUND
 * 3. Machine orgId !== workroom orgId → 403 FORBIDDEN (cross-org blocked)
 * 4. Machine orgId === workroom orgId → ok=true
 * 5. workroomOverride bypasses DB lookup
 */

// ── Mock db ────────────────────────────────────────────────────────────────────
const mockWorkroomFindUnique = vi.fn();
const mockThreadFindUnique = vi.fn();
const mockSessionFindUnique = vi.fn();

// Keep backward-compat alias for tests that pre-date the thread/session mocks.
const mockFindUnique = mockWorkroomFindUnique;

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: {
      findUnique: (...args: unknown[]) => mockWorkroomFindUnique(...args),
    },
    controlThread: {
      findUnique: (...args: unknown[]) => mockThreadFindUnique(...args),
    },
    controlSession: {
      findUnique: (...args: unknown[]) => mockSessionFindUnique(...args),
    },
  },
}));

beforeEach(() => {
  mockWorkroomFindUnique.mockReset();
  mockThreadFindUnique.mockReset();
  mockSessionFindUnique.mockReset();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('requireMachineAccessToWorkroom', () => {
  it('403 when machine has no orgId (unbound machine)', async () => {
    const machine = { id: 'machine-1', orgId: null };
    const result = await requireMachineAccessToWorkroom(machine, 'wroom-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error.code).toBe('MACHINE_NO_ORG');
    }
    // DB should NOT be queried if machine has no org
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('404 when workroom not found', async () => {
    mockFindUnique.mockResolvedValue(null);
    const machine = { id: 'machine-1', orgId: 'org-A' };
    const result = await requireMachineAccessToWorkroom(machine, 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error.code).toBe('WORKROOM_NOT_FOUND');
    }
  });

  it('403 FORBIDDEN when machine org !== workroom org (cross-org blocked)', async () => {
    mockFindUnique.mockResolvedValue({ orgId: 'org-B' });  // workroom belongs to org-B
    const machine = { id: 'machine-1', orgId: 'org-A' };   // machine in org-A
    const result = await requireMachineAccessToWorkroom(machine, 'wroom-B');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error.code).toBe('FORBIDDEN');
    }
  });

  it('ok=true when machine org === workroom org (same org)', async () => {
    mockFindUnique.mockResolvedValue({ orgId: 'org-A' });
    const machine = { id: 'machine-1', orgId: 'org-A' };
    const result = await requireMachineAccessToWorkroom(machine, 'wroom-A');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workroomOrgId).toBe('org-A');
    }
    // DB was queried to verify workroom
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'wroom-A' },
      select: { orgId: true },
    });
  });

  it('workroomOverride bypasses DB lookup', async () => {
    const machine = { id: 'machine-1', orgId: 'org-A' };
    const result = await requireMachineAccessToWorkroom(
      machine,
      'wroom-A',
      { orgId: 'org-A' },  // caller already has workroom data
    );
    expect(result.ok).toBe(true);
    // No DB query — we provided the override
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('workroomOverride with wrong org still returns FORBIDDEN', async () => {
    const machine = { id: 'machine-1', orgId: 'org-A' };
    const result = await requireMachineAccessToWorkroom(
      machine,
      'wroom-B',
      { orgId: 'org-B' },  // workroom belongs to different org
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error.code).toBe('FORBIDDEN');
    }
    // No DB query — we used the override
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

// ─── resolveCursorScopeAccess ─────────────────────────────────────────────────

describe('resolveCursorScopeAccess', () => {
  const machine = { id: 'machine-1', orgId: 'org-A' };

  // ── scope_type=workroom ───────────────────────────────────────────────────
  describe('scope_type=workroom', () => {
    it('authorized when machine org matches workroom org', async () => {
      mockWorkroomFindUnique.mockResolvedValue({ orgId: 'org-A' });
      const result = await resolveCursorScopeAccess(machine, 'workroom', 'wroom-A');
      expect(result.ok).toBe(true);
      // Scope_id used directly as workroom_id
      expect(mockWorkroomFindUnique).toHaveBeenCalledWith({
        where: { id: 'wroom-A' },
        select: { orgId: true },
      });
    });

    it('403 when machine org does not match workroom org (cross-org blocked)', async () => {
      mockWorkroomFindUnique.mockResolvedValue({ orgId: 'org-B' });
      const result = await resolveCursorScopeAccess(machine, 'workroom', 'wroom-B');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.error.code).toBe('FORBIDDEN');
      }
    });

    it('404 when workroom not found', async () => {
      mockWorkroomFindUnique.mockResolvedValue(null);
      const result = await resolveCursorScopeAccess(machine, 'workroom', 'nonexistent');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.error.code).toBe('WORKROOM_NOT_FOUND');
      }
    });
  });

  // ── scope_type=thread ─────────────────────────────────────────────────────
  describe('scope_type=thread', () => {
    it('authorized when thread resolves to a workroom in machine org', async () => {
      // Thread lookup returns workroomId; workroom lookup returns matching org.
      mockThreadFindUnique.mockResolvedValue({ workroomId: 'wroom-A' });
      mockWorkroomFindUnique.mockResolvedValue({ orgId: 'org-A' });

      const result = await resolveCursorScopeAccess(machine, 'thread', 'thread-1');
      expect(result.ok).toBe(true);
      expect(mockThreadFindUnique).toHaveBeenCalledWith({
        where: { id: 'thread-1' },
        select: { workroomId: true },
      });
    });

    it('403 when thread resolves to a workroom in a different org (cross-org blocked)', async () => {
      mockThreadFindUnique.mockResolvedValue({ workroomId: 'wroom-B' });
      mockWorkroomFindUnique.mockResolvedValue({ orgId: 'org-B' });

      const result = await resolveCursorScopeAccess(machine, 'thread', 'thread-x');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.error.code).toBe('FORBIDDEN');
      }
    });

    it('404 THREAD_NOT_FOUND when thread does not exist', async () => {
      mockThreadFindUnique.mockResolvedValue(null);
      const result = await resolveCursorScopeAccess(machine, 'thread', 'ghost-thread');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.error.code).toBe('THREAD_NOT_FOUND');
      }
      // Should NOT fall through to workroom lookup
      expect(mockWorkroomFindUnique).not.toHaveBeenCalled();
    });
  });

  // ── scope_type=session ────────────────────────────────────────────────────
  describe('scope_type=session', () => {
    it('authorized when session resolves to a workroom in machine org', async () => {
      // Session lookup returns workroomId + orgId; workroomOverride skips second lookup.
      mockSessionFindUnique.mockResolvedValue({ workroomId: 'wroom-A', orgId: 'org-A' });

      const result = await resolveCursorScopeAccess(machine, 'session', 'session-1');
      expect(result.ok).toBe(true);
      expect(mockSessionFindUnique).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        select: { workroomId: true, orgId: true },
      });
      // workroomOverride skips DB lookup for workroom
      expect(mockWorkroomFindUnique).not.toHaveBeenCalled();
    });

    it('403 when session org does not match machine org (cross-org blocked)', async () => {
      mockSessionFindUnique.mockResolvedValue({ workroomId: 'wroom-B', orgId: 'org-B' });

      const result = await resolveCursorScopeAccess(machine, 'session', 'session-x');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.error.code).toBe('FORBIDDEN');
      }
      // workroomOverride used → no second DB query
      expect(mockWorkroomFindUnique).not.toHaveBeenCalled();
    });

    it('404 SESSION_NOT_FOUND when session does not exist', async () => {
      mockSessionFindUnique.mockResolvedValue(null);
      const result = await resolveCursorScopeAccess(machine, 'session', 'ghost-session');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.error.code).toBe('SESSION_NOT_FOUND');
      }
      expect(mockWorkroomFindUnique).not.toHaveBeenCalled();
    });
  });

  // ── unknown scope_type ────────────────────────────────────────────────────
  describe('unknown scope_type', () => {
    it('400 INVALID_SCOPE_TYPE for unrecognized scope types', async () => {
      const result = await resolveCursorScopeAccess(machine, 'channel', 'some-id');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error.code).toBe('INVALID_SCOPE_TYPE');
      }
      // No DB queries should have been made
      expect(mockWorkroomFindUnique).not.toHaveBeenCalled();
      expect(mockThreadFindUnique).not.toHaveBeenCalled();
      expect(mockSessionFindUnique).not.toHaveBeenCalled();
    });
  });
});
