import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireMachineAccessToWorkroom } from './machineAccess';

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
const mockFindUnique = vi.fn();

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

beforeEach(() => {
  mockFindUnique.mockReset();
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
