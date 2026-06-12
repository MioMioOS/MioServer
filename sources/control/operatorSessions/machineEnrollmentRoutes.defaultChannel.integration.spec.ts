/**
 * Enrollment default-channel + bind-org agent channel-join (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/operatorSessions/machineEnrollmentRoutes.defaultChannel.integration.spec.ts
 *
 * Covers the empty-workspace fix (2026-06-12):
 *   - approve WITHOUT workroom_id (fresh personal workspace) → the provisioned
 *     workroom has a public #general channel (a channel-less workspace is unusable)
 *   - approve INTO an existing workroom that has no channels → #general self-heal
 *   - approve INTO an existing workroom that already has channels → NO extra channel
 *   - POST /machines/:id/bind-org → the default agent is created AND joined into the
 *     org workroom's oldest public channel (without this the daemon's membership
 *     filter delivers nothing and the agent never replies)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID, createHash } from 'crypto';
import { db } from '@/storage/db';
import { machineEnrollmentRoutes } from './machineEnrollmentRoutes.js';
import { machineRoutes } from '@/machines/machineRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

let app: FastifyInstance;
let USER_ID = '';
let USER_TOKEN = '';

const createdOrgIds = new Set<string>();
const createdWorkroomIds = new Set<string>();
const createdMachineIds = new Set<string>();
const createdIntentIds = new Set<string>();

const auth = () => ({ authorization: `Bearer ${USER_TOKEN}` });

async function createIntent() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/enrollment-intents',
    payload: { device_name: `mac-${randomUUID().slice(0, 8)}`, platform: 'darwin', arch: 'arm64' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { intent_id: string; opaque_code: string };
  createdIntentIds.add(body.intent_id);
  return body;
}

async function approve(intentId: string, code: string, workroomId?: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/enrollment-intents/${intentId}/approve`,
    headers: auth(),
    payload: workroomId ? { code, workroom_id: workroomId } : { code },
  });
  return res;
}

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(machineEnrollmentRoutes);
  await app.register(machineRoutes);
  await app.ready();

  const user = await db.user.create({
    data: { email: `dc-${randomUUID()}@example.test`, passwordHash: await hashPassword('p') },
  });
  USER_ID = user.id;
  USER_TOKEN = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: USER_ID, tokenHash: hashUserSessionToken(USER_TOKEN), expiresAt: new Date(Date.now() + 86_400_000) },
  });
});

afterAll(async () => {
  // Track everything the approves provisioned so the suite is zero-footprint.
  const wrIds = [...createdWorkroomIds];
  if (wrIds.length) {
    await db.controlMessage.deleteMany({ where: { workroomId: { in: wrIds } } });
    const channels = await db.controlChannel.findMany({ where: { workroomId: { in: wrIds } }, select: { id: true } });
    const chIds = channels.map((c) => c.id);
    if (chIds.length) await db.controlChannelMember.deleteMany({ where: { channelId: { in: chIds } } });
    await db.controlChannel.deleteMany({ where: { workroomId: { in: wrIds } } });
    await db.userWorkroomMembership.deleteMany({ where: { workroomId: { in: wrIds } } });
  }
  await db.controlMachineEnrollment.deleteMany({ where: { id: { in: [...createdIntentIds] } } });
  if (createdMachineIds.size) {
    await db.controlAgent.deleteMany({ where: { machineId: { in: [...createdMachineIds] } } });
    await db.controlMachine.deleteMany({ where: { id: { in: [...createdMachineIds] } } });
  }
  if (wrIds.length) await db.controlWorkroom.deleteMany({ where: { id: { in: wrIds } } });
  if (createdOrgIds.size) await db.controlOrg.deleteMany({ where: { id: { in: [...createdOrgIds] } } });
  await db.userSession.deleteMany({ where: { userId: USER_ID } });
  await db.user.deleteMany({ where: { id: USER_ID } });
  await app.close();
  await db.$disconnect();
});

describe('approve provisions a usable workspace', () => {
  it('fresh personal workspace gets a public #general channel', async () => {
    const { intent_id, opaque_code } = await createIntent();
    const res = await approve(intent_id, opaque_code);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workroom_id: string; machine_id: string };
    createdWorkroomIds.add(body.workroom_id);
    createdMachineIds.add(body.machine_id);
    const wr = await db.controlWorkroom.findUniqueOrThrow({ where: { id: body.workroom_id } });
    createdOrgIds.add(wr.orgId);

    const channels = await db.controlChannel.findMany({ where: { workroomId: body.workroom_id } });
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('general');
    expect(channels[0].visibility).toBe('public');
    expect(channels[0].type).toBe('standard');
  });

  it('existing channel-less workroom self-heals; workroom WITH channels gets no extra', async () => {
    // First approve → provisions workroom + #general.
    const a = await createIntent();
    const r1 = await approve(a.intent_id, a.opaque_code);
    expect(r1.statusCode).toBe(200);
    const wid = (r1.json() as { workroom_id: string }).workroom_id;
    createdWorkroomIds.add(wid);
    createdMachineIds.add((r1.json() as { machine_id: string }).machine_id);
    const wr = await db.controlWorkroom.findUniqueOrThrow({ where: { id: wid } });
    createdOrgIds.add(wr.orgId);

    // Second approve INTO the same workroom (already has #general) → still exactly 1 channel.
    const b = await createIntent();
    const r2 = await approve(b.intent_id, b.opaque_code, wid);
    expect(r2.statusCode).toBe(200);
    createdMachineIds.add((r2.json() as { machine_id: string }).machine_id);
    expect(await db.controlChannel.count({ where: { workroomId: wid } })).toBe(1);

    // Strip the channel and approve a third time INTO it → self-heal recreates #general.
    await db.controlChannelMember.deleteMany({
      where: { channel: { workroomId: wid } },
    });
    await db.controlChannel.deleteMany({ where: { workroomId: wid } });
    const c = await createIntent();
    const r3 = await approve(c.intent_id, c.opaque_code, wid);
    expect(r3.statusCode).toBe(200);
    createdMachineIds.add((r3.json() as { machine_id: string }).machine_id);
    const healed = await db.controlChannel.findMany({ where: { workroomId: wid } });
    expect(healed).toHaveLength(1);
    expect(healed[0].name).toBe('general');
  });
});

describe('bind-org joins the default agent into the default channel', () => {
  it('agent row exists AND is a ControlChannelMember of the oldest public channel', async () => {
    const { intent_id, opaque_code } = await createIntent();
    const r = await approve(intent_id, opaque_code);
    expect(r.statusCode).toBe(200);
    const { workroom_id, machine_id } = r.json() as { workroom_id: string; machine_id: string };
    createdWorkroomIds.add(workroom_id);
    createdMachineIds.add(machine_id);
    const wr = await db.controlWorkroom.findUniqueOrThrow({ where: { id: workroom_id } });
    createdOrgIds.add(wr.orgId);

    // Mac long-polls the one-shot machine_token.
    const poll = await app.inject({ method: 'GET', url: `/api/v1/enrollment-intents/${intent_id}?code=${opaque_code}` });
    expect(poll.statusCode).toBe(200);
    const { machine_token, org_id } = poll.json() as { machine_token: string; org_id: string };

    // Daemon binds org (mio-agent's real startup call).
    const bind = await app.inject({
      method: 'POST',
      url: `/api/v1/machines/${machine_id}/bind-org`,
      headers: { authorization: `Bearer ${machine_token}` },
      payload: { org_id },
    });
    expect(bind.statusCode).toBe(200);

    const agent = await db.controlAgent.findFirst({ where: { orgId: org_id, machineId: machine_id } });
    expect(agent).not.toBeNull();

    const general = await db.controlChannel.findFirstOrThrow({
      where: { workroomId: workroom_id, visibility: 'public' },
      orderBy: { createdAt: 'asc' },
    });
    const membership = await db.controlChannelMember.findUnique({
      where: { channelId_memberId: { channelId: general.id, memberId: agent!.id } },
    });
    expect(membership).not.toBeNull();

    // Idempotent: re-bind does not duplicate the agent or the channel membership.
    const rebind = await app.inject({
      method: 'POST',
      url: `/api/v1/machines/${machine_id}/bind-org`,
      headers: { authorization: `Bearer ${machine_token}` },
      payload: { org_id },
    });
    expect(rebind.statusCode).toBe(200);
    expect(await db.controlAgent.count({ where: { orgId: org_id, machineId: machine_id } })).toBe(1);
    expect(await db.controlChannelMember.count({ where: { channelId: general.id, memberId: agent!.id } })).toBe(1);
  });
});
