import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workroomRoutes } from '@/control/workrooms/workroomRoutes';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';

const USER_TOKEN = `${USER_SESSION_TOKEN_PREFIX}fake-user-token`;
const MACHINE_TOKEN = 'machine_fake';
const USER_HEADER = { authorization: `Bearer ${USER_TOKEN}` };
const MACHINE_HEADER = { authorization: `Bearer ${MACHINE_TOKEN}` };

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: { findUnique: vi.fn() },
    userWorkroomMembership: { findUnique: vi.fn() },
  },
}));

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: vi.fn(),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: vi.fn(),
}));

vi.mock('@/auth/userSession/resolveUserSession', () => ({
  resolveUserSession: vi.fn(),
}));

async function buildApp() {
  const app = fastify();
  await app.register(workroomRoutes);
  return app;
}

const mockedDb = db as unknown as {
  controlWorkroom: { findUnique: ReturnType<typeof vi.fn> };
  userWorkroomMembership: { findUnique: ReturnType<typeof vi.fn> };
};
const mockedVerifyMachine = vi.mocked(verifyMachineToken);
const mockedRequireMachineAccess = vi.mocked(requireMachineAccessToWorkroom);
const mockedResolveUserSession = vi.mocked(resolveUserSession);

const workroom = {
  id: 'workroom-1',
  orgId: 'org-1',
  name: 'Mio Ops',
  description: 'Ops room',
  visibility: 'private',
  purpose: 'Coordinate work',
  currentGoalId: 'goal-1',
  createdBy: 'agent-1',
  archivedAt: null,
  createdAt: new Date('2026-05-23T00:00:00.000Z'),
  _count: { tasks: 2, actions: 3, sessions: 4 },
};

describe('GET /api/v1/workrooms/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.controlWorkroom.findUnique.mockResolvedValue(workroom);
    mockedDb.userWorkroomMembership.findUnique.mockResolvedValue({ userId: 'user-1', workroomId: 'workroom-1', role: 'owner' });
    mockedResolveUserSession.mockResolvedValue({ userId: 'user-1' } as never);
    mockedVerifyMachine.mockResolvedValue({ id: 'machine-1', orgId: 'org-1' } as never);
    mockedRequireMachineAccess.mockResolvedValue({ ok: true, workroomOrgId: 'org-1' });
  });

  it('allows a valid user_sess_ workroom member and preserves the success response shape', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1', headers: USER_HEADER });

    expect(res.statusCode).toBe(200);
    expect(mockedResolveUserSession).toHaveBeenCalledWith(`Bearer ${USER_TOKEN}`);
    expect(mockedDb.userWorkroomMembership.findUnique).toHaveBeenCalledWith({
      where: { userId_workroomId: { userId: 'user-1', workroomId: 'workroom-1' } },
    });
    expect(mockedVerifyMachine).not.toHaveBeenCalled();
    expect(mockedRequireMachineAccess).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      workroom_id: 'workroom-1',
      org_id: 'org-1',
      name: 'Mio Ops',
      description: 'Ops room',
      visibility: 'private',
      purpose: 'Coordinate work',
      current_goal_id: 'goal-1',
      created_by: 'agent-1',
      archived: false,
      archived_at: null,
      counts: { tasks: 2, actions: 3, sessions: 4 },
      created_at: '2026-05-23T00:00:00.000Z',
    });
  });

  it('returns 403 FORBIDDEN for a valid user_sess_ without workroom membership', async () => {
    mockedDb.userWorkroomMembership.findUnique.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1', headers: USER_HEADER });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    expect(mockedVerifyMachine).not.toHaveBeenCalled();
    expect(mockedRequireMachineAccess).not.toHaveBeenCalled();
  });

  it('preserves machine_token access through the workroom guard', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1', headers: MACHINE_HEADER });

    expect(res.statusCode).toBe(200);
    expect(mockedResolveUserSession).not.toHaveBeenCalled();
    expect(mockedVerifyMachine).toHaveBeenCalledWith(`Bearer ${MACHINE_TOKEN}`);
    expect(mockedRequireMachineAccess).toHaveBeenCalledWith(
      { id: 'machine-1', orgId: 'org-1' },
      'workroom-1',
      { orgId: 'org-1' },
    );
  });
});
