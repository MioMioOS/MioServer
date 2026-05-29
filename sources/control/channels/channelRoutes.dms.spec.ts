/**
 * Unit test for GET /api/v1/workrooms/:wid/dms — mocked Prisma + mocked auth helpers.
 * Complements the REAL-DB channelRoutes.dms.integration.spec.ts.
 *
 * Slice 7 B2-c auth: user_sess_ (workroom member) OR machine_token. Both paths must
 * filter DMs by the caller's viewerId (no more anonymous-token "show everything").
 *
 * FAST MODE — only meaningful tests:
 *   - returns dm-type channels only (not standard/main)
 *   - maps peer_member_id to the OTHER member (machine mode)
 *   - peer_member_id null when caller is the only member
 *   - empty when no dm channels
 *   - auth failure short-circuits before any DB read
 *   - user mode filters by user.id (not machine.id)
 */

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelRoutes } from '@/control/channels/channelRoutes';
import { db } from '@/storage/db';
import { resolveUserSession } from '@/auth/userSession/resolveUserSession';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';
import { USER_SESSION_TOKEN_PREFIX } from '@/auth/userSession/tokenMint';

const DM1 = 'aaaaaaaa-1111-1111-1111-111111111111';
const USER_TOKEN = `${USER_SESSION_TOKEN_PREFIX}fake-user`;
const MACHINE_TOKEN = 'machine_fake';

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: { findUnique: vi.fn() },
    controlChannel: { findMany: vi.fn() },
    userWorkroomMembership: { findUnique: vi.fn() },
  },
}));

vi.mock('@/auth/userSession/resolveUserSession', () => ({
  resolveUserSession: vi.fn(),
}));

vi.mock('@/machines/machineRoutes', () => ({
  verifyMachineToken: vi.fn(),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: vi.fn(),
}));

async function buildApp() {
  const app = fastify();
  await app.register(channelRoutes);
  return app;
}

const mockedResolveUserSession = vi.mocked(resolveUserSession);
const mockedVerifyMachine = vi.mocked(verifyMachineToken);
const mockedAccess = vi.mocked(requireMachineAccessToWorkroom);
const mockedDb = db as unknown as {
  controlWorkroom: { findUnique: ReturnType<typeof vi.fn> };
  controlChannel: { findMany: ReturnType<typeof vi.fn> };
  userWorkroomMembership: { findUnique: ReturnType<typeof vi.fn> };
};

function machineHeader(): Record<string, string> {
  return { authorization: `Bearer ${MACHINE_TOKEN}` };
}
function userHeader(): Record<string, string> {
  return { authorization: `Bearer ${USER_TOKEN}` };
}

describe('GET /api/v1/workrooms/:wid/dms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: machine path.
    mockedVerifyMachine.mockResolvedValue({ id: 'machine-1', orgId: 'org-1' } as never);
    mockedAccess.mockResolvedValue({ ok: true, workroomOrgId: 'org-1' });
    mockedResolveUserSession.mockResolvedValue(null); // disable user path by default
    mockedDb.controlChannel.findMany.mockResolvedValue([]);
  });

  it('returns dm channels with peer_member_id = the OTHER member (machine mode)', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([
      {
        id: DM1,
        type: 'dm',
        lastActivityAt: new Date('2026-05-23T00:00:00.000Z'),
        members: [{ memberId: 'machine-1' }, { memberId: 'agent-peer' }],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workrooms/workroom-1/dms',
      headers: machineHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.dms).toHaveLength(1);
    expect(body.dms[0]).toEqual({
      id: DM1,
      peer_member_id: 'agent-peer',
      unread_count: 0,
      last_activity_at: '2026-05-23T00:00:00.000Z',
    });
  });

  it('queries only type=dm channels for the workroom, scoped to the caller (machine)', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/workrooms/workroom-1/dms',
      headers: machineHeader(),
    });

    expect(mockedDb.controlChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workroomId: 'workroom-1',
          type: 'dm',
          archivedAt: null,
          members: { some: { memberId: 'machine-1' } },
        }),
      }),
    );
  });

  it('peer_member_id is null when the caller is the only member', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([
      { id: DM1, type: 'dm', lastActivityAt: null, members: [{ memberId: 'machine-1' }] },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workrooms/workroom-1/dms',
      headers: machineHeader(),
    });

    const body = JSON.parse(res.body);
    expect(body.dms[0].peer_member_id).toBeNull();
    expect(body.dms[0].last_activity_at).toBeNull();
  });

  it('user mode filters by user.id (not machine.id)', async () => {
    mockedResolveUserSession.mockResolvedValue({ id: 'sess-1', userId: 'user-1' } as never);
    mockedDb.controlWorkroom.findUnique.mockResolvedValue({ id: 'workroom-1', archivedAt: null });
    mockedDb.userWorkroomMembership.findUnique.mockResolvedValue({ role: 'owner' } as never);

    const app = await buildApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/workrooms/workroom-1/dms',
      headers: userHeader(),
    });

    expect(mockedDb.controlChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: { some: { memberId: 'user-1' } },
        }),
      }),
    );
  });

  it('returns an empty list when there are no dm channels', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workrooms/workroom-1/dms',
      headers: machineHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ dms: [] });
  });

  it('denies before reading data when machine token is invalid', async () => {
    mockedVerifyMachine.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workrooms/workroom-1/dms',
      headers: machineHeader(),
    });

    expect(res.statusCode).toBe(401);
    expect(mockedDb.controlChannel.findMany).not.toHaveBeenCalled();
  });
});
