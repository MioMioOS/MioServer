/**
 * S1 Chunk 2 — Contract update for GET /api/v1/workrooms/:wid/channels.
 *
 * The synthetic 'main' channel handler was removed from workroomRoutes.ts and replaced
 * by channelRoutes.ts (real ControlChannel table). This spec tests the NEW contract:
 *   - id is a real uuid (not the literal 'main')
 *   - visibility and member_count are present
 *   - attention_count is preserved (needs_human actions + pending approvals)
 *   - auth failures (403/401) still respected
 *   - archived workrooms → 404
 *
 * The test registers channelRoutes (not workroomRoutes) since the handler moved.
 */

import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { channelRoutes } from '@/control/channels/channelRoutes';
import { db } from '@/storage/db';
import { authorizeControlRead } from '@/control/devTokens/devTokenAuth';
import { requireMachineAccessToWorkroom } from '@/control/auth/machineAccess';

const CHANNEL_UUID = '11111111-2222-3333-4444-555555555555';

vi.mock('@/storage/db', () => ({
  db: {
    controlWorkroom: { findUnique: vi.fn() },
    controlChannel: { findMany: vi.fn() },
    controlChannelMember: { groupBy: vi.fn() },
    controlAction: { count: vi.fn() },
    controlApproval: { count: vi.fn() },
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
  controlChannelMember: { groupBy: ReturnType<typeof vi.fn> };
  controlAction: { count: ReturnType<typeof vi.fn> };
  controlApproval: { count: ReturnType<typeof vi.fn> };
};

describe('GET /api/v1/workrooms/:wid/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      ok: true,
      mode: 'machine',
      machine: { id: 'machine-1', orgId: 'org-1' } as never,
    });
    mockedAccess.mockResolvedValue({ ok: true, workroomOrgId: 'org-1' });
    mockedDb.controlWorkroom.findUnique.mockResolvedValue({
      id: 'workroom-1',
      archivedAt: null,
    });
    // visibleChannels returns a single public main channel
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
        members: [], // public: no member rows needed
      },
    ]);
    mockedDb.controlChannelMember.groupBy.mockResolvedValue([]);
    mockedDb.controlAction.count.mockResolvedValue(2);
    mockedDb.controlApproval.count.mockResolvedValue(3);
  });

  it('returns the real channel contract with uuid id, visibility, member_count, and attention_count', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(200);
    expect(mockedAccess).toHaveBeenCalledWith({ id: 'machine-1', orgId: 'org-1' }, 'workroom-1');
    const body = JSON.parse(res.body);
    expect(body.workroom_id).toBe('workroom-1');
    expect(body.channels).toHaveLength(1);
    const ch = body.channels[0];
    // id must be a uuid — not the literal 'main'
    expect(ch.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ch.id).toBe(CHANNEL_UUID);
    expect(ch.name).toBe('Mio Ops');
    expect(ch.type).toBe('main');
    expect(ch.visibility).toBe('public');
    expect(ch.last_activity_at).toBe('2026-05-23T00:00:00.000Z');
    expect(ch.unread_count).toBe(0);
    expect(ch.attention_count).toBe(5);   // 2 needs_human + 3 pending approvals
    expect(ch.member_count).toBe(0);      // public channel, no explicit member rows
  });

  it('supports dev read tokens without the machine workroom guard after authorizeControlRead scopes the path', async () => {
    mockedAuth.mockResolvedValue({
      ok: true,
      mode: 'dev',
      devToken: { id: 'dev-1', orgId: 'org-1', workroomId: 'workroom-1', scope: 'read_only' },
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(200);
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it('denies before reading channel data when auth fails', async () => {
    mockedAuth.mockResolvedValue({ ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(403);
    expect(mockedDb.controlWorkroom.findUnique).not.toHaveBeenCalled();
  });

  it('returns the workroom access guard failure for machine auth', async () => {
    mockedAccess.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'FORBIDDEN', message: 'Machine org does not match workroom org' },
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
    expect(mockedDb.controlWorkroom.findUnique).not.toHaveBeenCalled();
  });

  it('treats archived workrooms as unavailable for the channel switcher', async () => {
    mockedDb.controlWorkroom.findUnique.mockResolvedValue({
      id: 'workroom-1',
      archivedAt: new Date('2026-05-23T00:00:00.000Z'),
    });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('WORKROOM_NOT_FOUND');
  });

  it('returns empty channel list when no visible channels exist', async () => {
    mockedDb.controlChannel.findMany.mockResolvedValue([]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ workroom_id: 'workroom-1', channels: [] });
  });

  it('includes member_count from groupBy result', async () => {
    mockedDb.controlChannelMember.groupBy.mockResolvedValue([
      { channelId: CHANNEL_UUID, _count: { channelId: 4 } },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).channels[0].member_count).toBe(4);
  });

  it('filters out private channels where viewer is not a member', async () => {
    // Private channel where the viewer has no member row → filtered out by visibleChannels
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
        members: [], // no member row for 'machine-1' → filtered out
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(200);
    // Private channel with no member rows should be invisible to this viewer
    expect(JSON.parse(res.body).channels).toHaveLength(0);
  });

  it('includes private channels where viewer is a member', async () => {
    // Private channel where viewer has an explicit member row
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
        members: [{ memberId: 'machine-1' }], // viewer IS a member
      },
    ]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/workrooms/workroom-1/channels' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).channels).toHaveLength(1);
    expect(JSON.parse(res.body).channels[0].visibility).toBe('private');
  });
});
