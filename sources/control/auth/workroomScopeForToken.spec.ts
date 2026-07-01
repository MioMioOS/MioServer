/**
 * workroomScopeForToken — unit tests.
 *
 * Slice 7 B3 final shape: only two token classes survive — user_sess_ (prefix-dispatched)
 * and machine_token. The legacy dev_ctl_ + op_sess_ branches are gone (B3 removed the
 * mint + verify paths entirely).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tokenInWorkroom } from './workroomScopeForToken';

const mockResolveUserSession = vi.fn();
const mockVerifyMachineToken = vi.fn();
const mockMembershipFindUnique = vi.fn();
const mockRequireMachineAccessToWorkroom = vi.fn();

vi.mock('@/auth/userSession/resolveUserSession', () => ({
  resolveUserSession: (...args: unknown[]) => mockResolveUserSession(...args),
}));
vi.mock('@/auth/userSession/tokenMint', () => ({
  USER_SESSION_TOKEN_PREFIX: 'user_sess_',
}));
vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: (...args: unknown[]) => mockVerifyMachineToken(...args),
}));
vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: (...args: unknown[]) => mockRequireMachineAccessToWorkroom(...args),
}));
vi.mock('@/storage/db', () => ({
  db: {
    userWorkroomMembership: {
      findUnique: (...args: unknown[]) => mockMembershipFindUnique(...args),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tokenInWorkroom — user_sess_ branch (Slice 7 B2-e)', () => {
  it('valid user_sess_ + member of workroom → { ok, mode: "user" }', async () => {
    mockResolveUserSession.mockResolvedValue({ id: 'sess-1', userId: 'user-1' });
    mockMembershipFindUnique.mockResolvedValue({ role: 'owner' });

    const result = await tokenInWorkroom('user_sess_abc', 'wroom-1');

    expect(result).toMatchObject({ ok: true, mode: 'user' });
    expect(mockResolveUserSession).toHaveBeenCalledWith('Bearer user_sess_abc');
    expect(mockMembershipFindUnique).toHaveBeenCalledWith({
      where: { userId_workroomId: { userId: 'user-1', workroomId: 'wroom-1' } },
    });
    // The machine verifier must NOT run on a user_sess_ token (prefix dispatch).
    expect(mockVerifyMachineToken).not.toHaveBeenCalled();
  });

  it('valid user_sess_ + non-member of workroom → null (uniform reject)', async () => {
    mockResolveUserSession.mockResolvedValue({ id: 'sess-1', userId: 'user-1' });
    mockMembershipFindUnique.mockResolvedValue(null);

    const result = await tokenInWorkroom('user_sess_abc', 'wroom-other');

    expect(result).toBeNull();
    // Must NOT fall through to the machine verifier — a valid user_sess_ that loses the
    // membership check is a hard reject, not a "try the next class" trigger.
    expect(mockVerifyMachineToken).not.toHaveBeenCalled();
  });

  it('user_sess_ prefix but resolveUserSession rejects (expired/invalid) → null', async () => {
    mockResolveUserSession.mockResolvedValue(null);

    const result = await tokenInWorkroom('user_sess_expired', 'wroom-1');

    expect(result).toBeNull();
    expect(mockMembershipFindUnique).not.toHaveBeenCalled();
    // No fallthrough — an invalid user_sess_ must not silently masquerade as another class.
    expect(mockVerifyMachineToken).not.toHaveBeenCalled();
  });

  it('non-user_sess_ token (no prefix) → user path skipped entirely', async () => {
    // Machine path takes the token. user_sess_ branch must not have been touched.
    mockVerifyMachineToken.mockResolvedValue({ id: 'mach-1', orgId: 'org-1' });
    mockRequireMachineAccessToWorkroom.mockResolvedValue({ ok: true, workroomOrgId: 'org-1' });

    const result = await tokenInWorkroom('machine_token_value', 'wroom-1');

    expect(result).toMatchObject({ ok: true, mode: 'machine' });
    expect(mockResolveUserSession).not.toHaveBeenCalled();
    expect(mockMembershipFindUnique).not.toHaveBeenCalled();
  });
});
