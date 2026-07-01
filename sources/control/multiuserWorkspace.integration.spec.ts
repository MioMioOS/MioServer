/**
 * Multi-user workspace permission matrix (REAL Postgres integration).
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/multiuserWorkspace.integration.spec.ts
 *
 * THE durable regression net for "好友进我的 workspace" semantics (2026-06-12):
 * every role × every surface, asserted against the real routes.
 *
 * Roles under test:
 *   owner    — workroom owner (the person whose Mac enrolled the workspace)
 *   member   — invited human (humanMemberRoutes invite — exercised via the REAL API)
 *   guest    — channel-scoped collaborator (membership role='guest' + explicit
 *              ControlChannelMember of #secret only; no route mints this today)
 *   stranger — authenticated user with NO membership
 *   machine  — the workspace Mac's daemon (machine_token)
 *
 * Surfaces: channel visibility / messaging / threads / saved / channel admin /
 * agent admin / human-member admin / tasks / enrollment binding / leave.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import { randomUUID, createHash } from 'crypto';
import { db } from '@/storage/db';
import { humanMemberRoutes } from '@/control/members/humanMemberRoutes';
import { messageRoutes } from '@/control/messages/messageRoutes';
import { channelRoutes } from '@/control/channels/channelRoutes';
import { memberRoutes } from '@/control/members/memberRoutes';
import { agentRoutes } from '@/control/agents/agentRoutes';
import { slockTaskRoutes } from '@/control/tasks/slockTaskRoutes';
import { machineEnrollmentRoutes } from '@/control/operatorSessions/machineEnrollmentRoutes';
import { workspaceMembershipRoutes } from '@/control/workrooms/workspaceMembershipRoutes';
import { hashPassword } from '@/auth/userSession/passwordHash';
import { mintUserSessionToken, hashUserSessionToken } from '@/auth/userSession/tokenMint';

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const GENERAL_ID = randomUUID();   // public
const SECRET_ID = randomUUID();    // private — owner + guest + agent are explicit members
const MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();
const MACHINE_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let app: FastifyInstance;

type Persona = { id: string; email: string; token: string };
let owner: Persona, member: Persona, guest: Persona, stranger: Persona, member2: Persona, leaver: Persona;

const auth = (p: Persona) => ({ authorization: `Bearer ${p.token}` });
const machineAuth = () => ({ authorization: `Bearer ${MACHINE_TOKEN}` });
const W = `/api/v1/workrooms/${WORKROOM_ID}`;

async function seedUser(prefix: string, displayName?: string): Promise<Persona> {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword('p'), displayName: displayName ?? null },
  });
  const token = mintUserSessionToken();
  await db.userSession.create({
    data: { userId: user.id, tokenHash: hashUserSessionToken(token), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { id: user.id, email, token };
}

function post(url: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
}
function patch(url: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return app.inject({ method: 'PATCH', url, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });
}
function get(url: string, headers: Record<string, string>) {
  return app.inject({ method: 'GET', url, headers });
}
function del(url: string, headers: Record<string, string>) {
  return app.inject({ method: 'DELETE', url, headers });
}
function sendMsg(cid: string, p: Persona | 'machine', content: string) {
  const headers = p === 'machine' ? machineAuth() : auth(p);
  return post(`${W}/channels/${cid}/messages`, { content, client_idempotency_key: randomUUID() }, headers);
}

beforeAll(async () => {
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(humanMemberRoutes);
  await app.register(messageRoutes);
  await app.register(channelRoutes);
  await app.register(memberRoutes);
  await app.register(agentRoutes);
  await app.register(slockTaskRoutes);
  await app.register(machineEnrollmentRoutes);
  await app.register(workspaceMembershipRoutes);
  await app.ready();

  await db.controlOrg.create({ data: { id: ORG_ID, name: 'MU Org', slug: `mu-${randomUUID()}`, ownerUserId: randomUUID(), billingPlan: 'free' } });
  await db.controlWorkroom.create({ data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'MU WR', visibility: 'private', createdBy: randomUUID() } });
  await db.controlChannel.create({ data: { id: GENERAL_ID, workroomId: WORKROOM_ID, name: 'general', type: 'standard', visibility: 'public', createdBy: 'system' } });
  await db.controlChannel.create({ data: { id: SECRET_ID, workroomId: WORKROOM_ID, name: 'secret', type: 'standard', visibility: 'private', createdBy: 'system' } });
  await db.controlMachine.create({
    data: { id: MACHINE_ID, displayName: 'MU Mac', platform: 'darwin', arch: 'arm64', orgId: ORG_ID, boundAt: new Date(), tokenHash: createHash('sha256').update(MACHINE_TOKEN).digest('hex'), tokenExpiresAt: new Date(Date.now() + 86_400_000) },
  });
  await db.controlAgent.create({ data: { id: AGENT_ID, orgId: ORG_ID, machineId: MACHINE_ID, name: 'MU Agent', displayName: 'MU Agent', role: 'other', status: 'online' } });

  owner = await seedUser('mu-owner', 'Owner O');
  member = await seedUser('mu-member', 'Member M');
  guest = await seedUser('mu-guest', 'Guest G');
  stranger = await seedUser('mu-stranger');
  member2 = await seedUser('mu-member2');
  leaver = await seedUser('mu-leaver');

  await db.userWorkroomMembership.create({ data: { userId: owner.id, workroomId: WORKROOM_ID, role: 'owner' } });
  await db.userWorkroomMembership.create({ data: { userId: guest.id, workroomId: WORKROOM_ID, role: 'guest' } });
  await db.userWorkroomMembership.create({ data: { userId: leaver.id, workroomId: WORKROOM_ID, role: 'member' } });
  // guest + owner + agent are explicit members of #secret
  for (const memberId of [owner.id, guest.id, AGENT_ID]) {
    await db.controlChannelMember.create({ data: { channelId: SECRET_ID, memberId } });
  }
});

afterAll(async () => {
  const channels = await db.controlChannel.findMany({ where: { workroomId: WORKROOM_ID }, select: { id: true } });
  const chIds = channels.map((c) => c.id);
  const msgIds = (await db.controlMessage.findMany({ where: { workroomId: WORKROOM_ID }, select: { id: true } })).map((m) => m.id);
  if (msgIds.length) {
    await db.controlActivityState.deleteMany({ where: { messageId: { in: msgIds } } }).catch(() => {});
    await db.controlSavedMessage.deleteMany({ where: { messageId: { in: msgIds } } }).catch(() => {});
  }
  await db.controlThread.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlTask.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  if (chIds.length) await db.controlChannelMember.deleteMany({ where: { channelId: { in: chIds } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.userWorkroomMembership.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlMachine.deleteMany({ where: { id: MACHINE_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  const userIds = [owner, member, guest, stranger, member2, leaver].map((p) => p.id);
  await db.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  await db.$disconnect();
});

// ── 0. Invite the member through the REAL API (not a fixture row) ───────────
describe('member onboarding via invite API', () => {
  it('owner invites member by email → 201 role=member', async () => {
    const res = await post(`${W}/human-members`, { email: member.email }, auth(owner));
    expect(res.statusCode).toBe(201);
    expect(res.json().human_member.role).toBe('member');
  });
});

// ── A. Channel visibility per role ───────────────────────────────────────────
describe('channel visibility', () => {
  it('owner sees public + private-where-member (general + secret)', async () => {
    const res = await get(`${W}/channels`, auth(owner));
    const names = (res.json().channels as Array<{ name: string }>).map((c) => c.name).sort();
    expect(names).toEqual(['general', 'secret']);
  });
  it('member sees public only (not the private channel they are not in)', async () => {
    const res = await get(`${W}/channels`, auth(member));
    const names = (res.json().channels as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('general');
    expect(names).not.toContain('secret');
  });
  it('guest sees ONLY explicitly-joined channels (secret, NOT public general)', async () => {
    const res = await get(`${W}/channels`, auth(guest));
    const names = (res.json().channels as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(['secret']);
  });
  it('stranger → 403', async () => {
    expect((await get(`${W}/channels`, auth(stranger))).statusCode).toBe(403);
  });
});

// ── B. Messaging ─────────────────────────────────────────────────────────────
let ownerMsgId = '';
describe('messaging', () => {
  it('owner sends to #general → 201', async () => {
    const res = await sendMsg(GENERAL_ID, owner, 'hello from owner');
    expect(res.statusCode).toBe(201);
    ownerMsgId = res.json().id;
  });
  it('member sends to #general → 201 with resolved display name', async () => {
    const res = await sendMsg(GENERAL_ID, member, 'hi from member');
    expect(res.statusCode).toBe(201);
    expect(res.json().sender_display_name).toBe('Member M');
  });
  it('member reads #general → 200 and sees both messages', async () => {
    const res = await get(`${W}/channels/${GENERAL_ID}/messages`, auth(member));
    expect(res.statusCode).toBe(200);
    const contents = (res.json().messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toEqual(expect.arrayContaining(['hello from owner', 'hi from member']));
  });
  it('member CANNOT send to private #secret (not a channel member) → 403', async () => {
    expect((await sendMsg(SECRET_ID, member, 'sneak')).statusCode).toBe(403);
  });
  it('member CANNOT read private #secret → 404 (anti-enumeration)', async () => {
    expect((await get(`${W}/channels/${SECRET_ID}/messages`, auth(member))).statusCode).toBe(404);
  });
  it('guest CAN send to #secret (explicit member) → 201', async () => {
    expect((await sendMsg(SECRET_ID, guest, 'guest in secret')).statusCode).toBe(201);
  });
  it('guest CANNOT read #general (guest-scoped) → 404', async () => {
    expect((await get(`${W}/channels/${GENERAL_ID}/messages`, auth(guest))).statusCode).toBe(404);
  });
  it('stranger send → 403; machine send → 201 sender_kind=agent via agent_id', async () => {
    expect((await sendMsg(GENERAL_ID, stranger, 'nope')).statusCode).toBe(403);
    const res = await post(`${W}/channels/${GENERAL_ID}/messages`, { content: 'agent says hi', agent_id: AGENT_ID }, machineAuth());
    expect(res.statusCode).toBe(201);
    expect(res.json().sender_kind).toBe('agent');
    expect(res.json().sender_display_name).toBe('MU Agent');
  });
  it('idempotent replay returns the SAME message', async () => {
    const key = randomUUID();
    const r1 = await post(`${W}/channels/${GENERAL_ID}/messages`, { content: 'once', client_idempotency_key: key }, auth(member));
    const r2 = await post(`${W}/channels/${GENERAL_ID}/messages`, { content: 'once', client_idempotency_key: key }, auth(member));
    expect(r1.json().id).toBe(r2.json().id);
  });
});

// ── C. Threads ───────────────────────────────────────────────────────────────
describe('threads', () => {
  it('member replies to owner message → 201; reply listed; count bumps', async () => {
    const res = await post(`${W}/threads/${ownerMsgId}/reply`, { content: 'thread reply', client_idempotency_key: randomUUID() }, auth(member));
    expect(res.statusCode).toBe(201);
    const replies = await get(`${W}/threads/${ownerMsgId}/replies`, auth(owner));
    expect(replies.statusCode).toBe(200);
    const list = await get(`${W}/channels/${GENERAL_ID}/messages`, auth(owner));
    const parent = (list.json().messages as Array<{ id: string; thread_reply_count: number }>).find((m) => m.id === ownerMsgId);
    expect(parent?.thread_reply_count).toBe(1);
  });
});

// ── D. Saved (messaging plane open to members) ──────────────────────────────
describe('saved', () => {
  it('member saves + lists a message', async () => {
    const save = await post(`${W}/messages/${ownerMsgId}/save`, {}, auth(member));
    expect([200, 201]).toContain(save.statusCode);
    const saved = await get(`${W}/saved`, auth(member));
    expect(saved.statusCode).toBe(200);
  });
});

// ── E. Channel admin — owner-only ────────────────────────────────────────────
describe('channel admin (owner-only)', () => {
  let scratchChannelId = '';
  it('create: owner 201 / member 403 / guest 403', async () => {
    const r1 = await post(`${W}/channels`, { name: 'scratch', visibility: 'public' }, auth(owner));
    expect(r1.statusCode).toBe(201);
    scratchChannelId = r1.json().id;
    expect((await post(`${W}/channels`, { name: 'm', visibility: 'public' }, auth(member))).statusCode).toBe(403);
    expect((await post(`${W}/channels`, { name: 'g', visibility: 'public' }, auth(guest))).statusCode).toBe(403);
  });
  it('add/remove channel member: owner ok / member 403', async () => {
    expect((await post(`${W}/channels/${scratchChannelId}/members`, { member_id: AGENT_ID }, auth(owner))).statusCode).toBe(200);
    expect((await post(`${W}/channels/${scratchChannelId}/members`, { member_id: AGENT_ID }, auth(member))).statusCode).toBe(403);
    expect((await del(`${W}/channels/${scratchChannelId}/members/${AGENT_ID}`, auth(member))).statusCode).toBe(403);
  });
  it('stop-agents: owner ok / member 403', async () => {
    expect((await post(`${W}/channels/${GENERAL_ID}/stop-agents`, {}, auth(owner))).statusCode).toBe(200);
    expect((await post(`${W}/channels/${GENERAL_ID}/stop-agents`, {}, auth(member))).statusCode).toBe(403);
  });
  it('update/delete channel: member 403 / owner ok', async () => {
    expect((await patch(`${W}/channels/${scratchChannelId}`, { name: 'renamed' }, auth(member))).statusCode).toBe(403);
    expect((await del(`${W}/channels/${scratchChannelId}`, auth(member))).statusCode).toBe(403);
    expect((await patch(`${W}/channels/${scratchChannelId}`, { name: 'renamed' }, auth(owner))).statusCode).toBe(200);
    expect((await del(`${W}/channels/${scratchChannelId}`, auth(owner))).statusCode).toBe(200);
  });
});

// ── F. Agent admin — owner-only ──────────────────────────────────────────────
describe('agent admin (owner-only)', () => {
  let scratchAgentId = '';
  it('create: member 403 / guest 403 / owner 201', async () => {
    const body = { name: 'Scratch Agent', runtime: 'claude', model: 'opus' };
    expect((await post(`${W}/agents`, body, auth(member))).statusCode).toBe(403);
    expect((await post(`${W}/agents`, body, auth(guest))).statusCode).toBe(403);
    const r = await post(`${W}/agents`, body, auth(owner));
    expect(r.statusCode).toBe(201);
    scratchAgentId = r.json().id;
  });
  it('update: member 403 / owner 200', async () => {
    expect((await patch(`${W}/agents/${scratchAgentId}`, { name: 'X' }, auth(member))).statusCode).toBe(403);
    expect((await patch(`${W}/agents/${scratchAgentId}`, { name: 'Scratch2' }, auth(owner))).statusCode).toBe(200);
  });
  it('pause: member 403 / owner ok; delete: member 403 / owner ok', async () => {
    expect((await post(`${W}/agents/${scratchAgentId}/pause`, {}, auth(member))).statusCode).toBe(403);
    expect((await post(`${W}/agents/${scratchAgentId}/pause`, {}, auth(owner))).statusCode).toBe(200);
    expect((await del(`${W}/agents/${scratchAgentId}`, auth(member))).statusCode).toBe(403);
    expect((await del(`${W}/agents/${scratchAgentId}`, auth(owner))).statusCode).toBe(200);
  });
});

// ── G. Human-member admin ────────────────────────────────────────────────────
describe('human-member admin', () => {
  it('member can LIST humans; member cannot INVITE; owner invite/remove member2 round-trip', async () => {
    expect((await get(`${W}/human-members`, auth(member))).statusCode).toBe(200);
    expect((await post(`${W}/human-members`, { email: member2.email }, auth(member))).statusCode).toBe(403);
    expect((await post(`${W}/human-members`, { email: member2.email }, auth(owner))).statusCode).toBe(201);
    expect((await get(`${W}/channels`, auth(member2))).statusCode).toBe(200);
    expect((await del(`${W}/human-members/${member2.id}`, auth(owner))).statusCode).toBe(200);
    expect((await get(`${W}/channels`, auth(member2))).statusCode).toBe(403);
  });
  it('owner cannot be removed → 403 CANNOT_REMOVE_OWNER', async () => {
    const res = await del(`${W}/human-members/${owner.id}`, auth(owner));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CANNOT_REMOVE_OWNER');
  });
});

// ── H. Tasks — admin stays owner-only for user tokens (current policy) ──────
describe('tasks (owner-only for user tokens)', () => {
  it('owner creates task → 201 with number; member create/status → 403', async () => {
    const r = await post(`${W}/channels/${GENERAL_ID}/tasks`, { title: 'mu task' }, auth(owner));
    expect(r.statusCode).toBe(201);
    const taskId = r.json().id ?? r.json().task?.id;
    expect((await post(`${W}/channels/${GENERAL_ID}/tasks`, { title: 'nope' }, auth(member))).statusCode).toBe(403);
    expect((await patch(`${W}/tasks/${taskId}/status`, { status: 'DONE' }, auth(member))).statusCode).toBe(403);
    expect((await patch(`${W}/tasks/${taskId}/status`, { status: 'DONE' }, auth(owner))).statusCode).toBe(200);
  });
});

// ── I. Enrollment binding + leave ────────────────────────────────────────────
describe('workspace binding + leave', () => {
  it('member CANNOT approve an enrollment INTO this workroom (owner-only bind) → 403', async () => {
    const c = await post('/api/v1/enrollment-intents', { device_name: 'mu-mac', platform: 'darwin', arch: 'arm64' }, {});
    const { intent_id, opaque_code } = c.json();
    const res = await post(`/api/v1/enrollment-intents/${intent_id}/approve`, { code: opaque_code, workroom_id: WORKROOM_ID }, auth(member));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    await db.controlMachineEnrollment.deleteMany({ where: { id: intent_id } });
  });
  it('a member can leave; afterwards reads are 403', async () => {
    const res = await del(`/v1/users/me/workrooms/${WORKROOM_ID}`, auth(leaver));
    expect(res.statusCode).toBe(200);
    expect(res.json().left).toBe(true);
    expect((await get(`${W}/channels`, auth(leaver))).statusCode).toBe(403);
  });
});
