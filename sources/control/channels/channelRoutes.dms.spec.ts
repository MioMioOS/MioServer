/**
 * S4 DM — read path. GET /api/v1/workrooms/:wid/dms.
 *
 * Contract:
 *   { dms: [{ id, peer_member_id, unread_count, last_activity_at }] }
 *
 *   - dm channel = ControlChannel where workroomId=:wid AND type='dm'
 *   - peer_member_id = first ControlChannelMember.memberId NOT equal to the caller
 *                      (null if none/unknown)
 *   - unread_count = 0 (no read-cursor system yet — honest 0)
 *   - last_activity_at = channel.lastActivityAt (ISO8601 or null)
 *
 * Scope:
 *   machine mode → only dm channels where the machine (machine.id) is a member.
 *   dev mode     → ALL dm channels in the workroom (dev token has no member identity;
 *                  it is a read/debug token, already workroom-scoped by authorizeControlRead).
 *
 * FAST MODE — only meaningful tests:
 *   - returns dm-type channels only (not standard/main)
 *   - maps peer_member_id to the OTHER member (machine mode)
 *   - dev_ctl_ scope: returns all dm channels (no member filtering)
 *   - empty when no dm channels
 *   - auth failure short-circuits before any DB read
 */

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelRoutes } from '@/control/channels/channelRoutes';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';

const DM1 = 'aaaaaaaa-1111-1111-1111-111111111111';
const DM2 = 'bbbbbbbb-2222-2222-2222-222222222222';

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: { findUnique: vi.fn() },
    controlChannel: { findMany: vi.fn() },
  },
}));

vi.mock('@/control/devTokens/devTokenAuth', () => ({
  authorizeControlRead: vi.fn(),
}));

vi.mock('@/control/auth/machineAccess', () => ({
  requireMachineAccessToWorkroom: vi.fn(),
}));

async function buildApp() {
  const app = fastify();
  await app.register(channelRoutes);
  return app;
}

const mockedAuth = vi.mocked(authorizeControlRead);
const mockedAccess = vi.mocked(requireMachineAccessToWorkroom);
const mockedDb = db as unknown as {
  controlWorkroom: { findUnique: ReturnType<typeof vi.fn> };
  controlChannel: { findMany: ReturnType<typeof vi.fn> };
};

describe('GET /api/v1/workrooms/:wid/dms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      ok: true,
      mode: 'machine',
      machine: { id: 'machine-1', orgId: 'org-1' } as never,
    });
    mockedAccess.mockResolvedValue({ ok: true, workroomOrgId: 'org-1' });
    mockedDb.controlWorkroom.findUnique.mockResolvedValue({ id: 'workroom-1', archivedAt: null });
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
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/dms' });

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

  it('queries only type=dm channels for the workroom', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/dms' });

    expect(mockedDb.controlChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workroomId: 'workroom-1', type: 'dm', archivedAt: null }),
      }),
    );
  });

  it('peer_member_id is null when the caller is the only member', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([
      { id: DM1, type: 'dm', lastActivityAt: null, members: [{ memberId: 'machine-1' }] },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/dms' });

    const body = JSON.parse(res.body);
    expect(body.dms[0].peer_member_id).toBeNull();
    expect(body.dms[0].last_activity_at).toBeNull();
  });

  it('dev_ctl_ mode returns all dm channels with peer = first member (no member identity)', async () => {
    mockedAuth.mockResolvedValue({
      ok: true,
      mode: 'dev',
      devToken: { id: 'dev-1', orgId: 'org-1', workroomId: 'workroom-1', scope: 'read_only' },
    });
    mockedDb.controlChannel.findMany.mockResolvedValue([
      { id: DM1, type: 'dm', lastActivityAt: null, members: [{ memberId: 'agent-a' }, { memberId: 'agent-b' }] },
      { id: DM2, type: 'dm', lastActivityAt: null, members: [{ memberId: 'agent-c' }] },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/dms' });

    expect(res.statusCode).toBe(200);
    // dev mode does not invoke the machine access guard.
    expect(mockedAccess).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.dms).toHaveLength(2);
    // dev token id is not a member → peer is the first member.
    expect(body.dms[0].peer_member_id).toBe('agent-a');
    expect(body.dms[1].peer_member_id).toBe('agent-c');
  });

  it('returns an empty list when there are no dm channels', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/dms' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ dms: [] });
  });

  it('denies before reading data when auth fails', async () => {
    mockedAuth.mockResolvedValue({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/dms' });

    expect(res.statusCode).toBe(403);
    expect(mockedDb.controlChannel.findMany).not.toHaveBeenCalled();
  });
});
