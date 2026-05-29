/**
 * Unit test for GET /api/v1/workrooms/:wid/channels — mocked Prisma + mocked auth helpers.
 *
 * Slice 7 B2-c: handler now uses inline user_sess_ / machine_token resolution (no more
 * authorizeControlRead). visibleChannels is invoked with the `{ viewerId }` overload —
 * viewerId is user.id for user actors, machine.id for machine actors.
 *
 * FAST MODE — only meaningful tests:
 *   - id is a real uuid (not literal 'main')
 *   - visibility + member_count present
 *   - attention_count preserved (needs_human actions + pending approvals)
 *   - auth failures (machine invalid → 401)
 *   - cross-org machine → 403 from requireMachineAccessToWorkroom
 *   - archived workrooms → 404
 *   - empty channel list
 *   - private channels filtered by visibleChannels (member row required)
 */

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelRoutes } from '@/control/channels/channelRoutes';
import { db } from '@/storage/db';
import { verifyMachineToken } from '@/machines/machineRoutes';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';

const CHANNEL_UUID = '11111111-2222-3333-4444-555555555555';
const MACHINE_TOKEN = 'machine_fake';

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: { findUnique: vi.fn() },
    controlChannel: { findMany: vi.fn() },
    controlChannelMember: { groupBy: vi.fn() },
    controlAction: { count: vi.fn() },
    controlApproval: { count: vi.fn() },
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
  resolveUserSession: vi.fn().mockResolvedValue(null),
}));

async function buildApp() {
  const app = fastify();
  await app.register(channelRoutes);
  return app;
}

const mockedVerifyMachine = vi.mocked(verifyMachineToken);
const mockedAccess = vi.mocked(requireMachineAccessToWorkroom);
const mockedDb = db as unknown as {
  controlWorkroom: { findUnique: ReturnType<typeof vi.fn> };
  controlChannel: { findMany: ReturnType<typeof vi.fn> };
  controlChannelMember: { groupBy: ReturnType<typeof vi.fn> };
  controlAction: { count: ReturnType<typeof vi.fn> };
  controlApproval: { count: ReturnType<typeof vi.fn> };
  userWorkroomMembership: { findUnique: ReturnType<typeof vi.fn> };
};

const machineHeader = (): Record<string, string> => ({ authorization: `Bearer ${MACHINE_TOKEN}` });

describe('GET /api/v1/workrooms/:wid/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedVerifyMachine.mockResolvedValue({ id: 'machine-1', orgId: 'org-1' } as never);
    mockedAccess.mockResolvedValue({ ok: true, workroomOrgId: 'org-1' });
    mockedDb.controlWorkroom.findUnique.mockResolvedValue({
      id: 'workroom-1',
      archivedAt: null,
    });
    mockedDb.controlChannel.findMany.mockResolvedValue([
      {
        id: CHANNEL_UUID,
        name: 'Mio Ops',
        type: 'main',
        visibility: 'public',
        description: null,
        archivedAt: null,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
        lastActivityAt: new Date('2026-05-23T00:00:00.000Z'),
        workroomId: 'workroom-1',
        members: [],
      },
    ]);
    mockedDb.controlChannelMember.groupBy.mockResolvedValue([]);
    mockedDb.controlAction.count.mockResolvedValue(2);
    mockedDb.controlApproval.count.mockResolvedValue(3);
  });

  it('returns the real channel contract with uuid id, visibility, member_count, and attention_count', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(200);
    expect(mockedAccess).toHaveBeenCalledWith({ id: 'machine-1', orgId: 'org-1' }, 'workroom-1');
    const body = JSON.parse(res.body);
    expect(body.workroom_id).toBe('workroom-1');
    expect(body.channels).toHaveLength(1);
    const ch = body.channels[0];
    expect(ch.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ch.id).toBe(CHANNEL_UUID);
    expect(ch.name).toBe('Mio Ops');
    expect(ch.type).toBe('main');
    expect(ch.visibility).toBe('public');
    expect(ch.last_activity_at).toBe('2026-05-23T00:00:00.000Z');
    expect(ch.unread_count).toBe(0);
    expect(ch.attention_count).toBe(5);
    expect(ch.member_count).toBe(0);
  });

  it('denies before reading channel data when machine token invalid', async () => {
    mockedVerifyMachine.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(401);
    expect(mockedDb.controlChannel.findMany).not.toHaveBeenCalled();
  });

  it('returns the workroom access guard failure for machine auth', async () => {
    mockedAccess.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'FORBIDDEN', message: 'Machine org does not match workroom org' },
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
    expect(mockedDb.controlChannel.findMany).not.toHaveBeenCalled();
  });

  it('treats archived workrooms as unavailable for the channel switcher', async () => {
    mockedDb.controlWorkroom.findUnique.mockResolvedValue({
      id: 'workroom-1',
      archivedAt: new Date('2026-05-23T00:00:00.000Z'),
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('WORKROOM_NOT_FOUND');
  });

  it('returns empty channel list when no visible channels exist', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ workroom_id: 'workroom-1', channels: [] });
  });

  it('includes member_count from groupBy result', async () => {
    mockedDb.controlChannelMember.groupBy.mockResolvedValue([
      { channelId: CHANNEL_UUID, _count: { channelId: 4 } },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).channels[0].member_count).toBe(4);
  });

  it('filters out private channels where viewer is not a member', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([
      {
        id: CHANNEL_UUID,
        name: 'Private Channel',
        type: 'standard',
        visibility: 'private',
        description: null,
        archivedAt: null,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
        lastActivityAt: new Date('2026-05-23T00:00:00.000Z'),
        workroomId: 'workroom-1',
        members: [],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).channels).toHaveLength(0);
  });

  it('includes private channels where viewer is a member', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([
      {
        id: CHANNEL_UUID,
        name: 'Private Channel',
        type: 'standard',
        visibility: 'private',
        description: null,
        archivedAt: null,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
        lastActivityAt: new Date('2026-05-23T00:00:00.000Z'),
        workroomId: 'workroom-1',
        members: [{ memberId: 'machine-1' }],
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels', headers: machineHeader() });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).channels).toHaveLength(1);
    expect(JSON.parse(res.body).channels[0].visibility).toBe('private');
  });
});
