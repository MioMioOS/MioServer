/**
 * B2 — Agent API reminder routes integration tests.
 *
 * Endpoints under test (all behind authorizeAgentApi + resolveAgentChannelTarget):
 *   POST /internal/agent-api/reminders/schedule  { title, in?|at?, cadence?, channel, message_id? }
 *   GET  /internal/agent-api/reminders/list?status=&channel=
 *   POST /internal/agent-api/reminders/snooze     { id, in?|until?, version }
 *   POST /internal/agent-api/reminders/update     { id, title?, cadence?, in?|at?, version }
 *   POST /internal/agent-api/reminders/cancel     { id, version }
 *   GET  /internal/agent-api/reminders/log?id=
 *   POST /internal/agent-api/reminders/fire       { id, version }  (daemon-internal)
 *
 * Required cases:
 *   - schedule(in "60s") → row(status scheduled, version 1) + scheduled-event + reminder.upserted broadcast
 *   - list → only own reminders (author-anchored)
 *   - snooze(version ok → fireAt pushed + version 2; stale version → 409)
 *   - update → version bump
 *   - cancel → status canceled + reminder.canceled broadcast
 *   - log → events
 *   - fire → ⏰ system message in channel + fired event + status fired
 *   - fire duplicate (stale version) → 200 noop, no second system message
 *   - schedule non-member channel → 404 NOT_A_MEMBER
 *   - another machine's agent → 403 AGENT_NOT_OWNED
 *
 * Run: npm run test:db:setup && npm run test:integration -- sources/control/agentApi/agentApiReminders.integration.spec.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/storage/db';
import { agentApiReminders } from './agentApiReminders';

// ── Fixture IDs ────────────────────────────────────────────────────────────────

const ORG_ID = randomUUID();
const WORKROOM_ID = randomUUID();
const MACHINE_ID = randomUUID();
const OTHER_MACHINE_ID = randomUUID();
const AGENT_ID = randomUUID();        // owned by MACHINE_ID, member of CHANNEL_ID
const OTHER_AGENT_ID = randomUUID(); // owned by OTHER_MACHINE_ID

const MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;
const OTHER_MACHINE_RAW_TOKEN = `machine_${randomUUID().replace(/-/g, '')}`;

let CHANNEL_ID = '';      // #remind channel — AGENT_ID is a member
let OTHER_CHANNEL_ID = ''; // a channel AGENT_ID is NOT a member of

let APP: FastifyInstance;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ── Helpers ────────────────────────────────────────────────────────────────────

function headers(machineToken = MACHINE_RAW_TOKEN, agentId = AGENT_ID) {
  return {
    authorization: `Bearer ${machineToken}`,
    'x-mio-agent-id': agentId,
    'content-type': 'application/json',
  };
}

function get(url: string, h = headers()) {
  return APP.inject({ method: 'GET', url, headers: h });
}

function post(url: string, body: Record<string, unknown>, h = headers()) {
  return APP.inject({
    method: 'POST',
    url,
    headers: h,
    payload: JSON.stringify(body),
  });
}

/** Count reminder.* events in the event log for our workroom. */
async function reminderEventCount(topic: string): Promise<number> {
  return db.controlEventLog.count({ where: { workroomId: WORKROOM_ID, topic } });
}

async function scheduleReminder(title = 'Test reminder', extra: Record<string, unknown> = {}) {
  const res = await post('/internal/agent-api/reminders/schedule', {
    channel: '#remind',
    title,
    in: '60s',
    ...extra,
  });
  return res;
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
  APP = fastify();
  await APP.register(agentApiReminders);
  await APP.ready();

  const tokenExpiresAt = new Date(Date.now() + 24 * 3600_000);

  await db.controlOrg.create({
    data: {
      id: ORG_ID,
      name: 'AgentApiReminders Org',
      slug: `agent-api-reminders-${randomUUID()}`,
      ownerUserId: randomUUID(),
    },
  });

  await db.controlMachine.create({
    data: {
      id: MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(MACHINE_RAW_TOKEN),
      tokenExpiresAt,
      platform: 'darwin',
      arch: 'arm64',
    },
  });
  await db.controlMachine.create({
    data: {
      id: OTHER_MACHINE_ID,
      orgId: ORG_ID,
      tokenHash: sha256(OTHER_MACHINE_RAW_TOKEN),
      tokenExpiresAt,
      platform: 'darwin',
      arch: 'arm64',
    },
  });

  await db.controlWorkroom.create({
    data: { id: WORKROOM_ID, orgId: ORG_ID, name: 'AgentApiReminders WR', createdBy: randomUUID() },
  });

  await db.controlAgent.create({
    data: {
      id: AGENT_ID,
      orgId: ORG_ID,
      machineId: MACHINE_ID,
      name: 'ReminderTestAgent',
      displayName: 'ReminderTestAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });
  await db.controlAgent.create({
    data: {
      id: OTHER_AGENT_ID,
      orgId: ORG_ID,
      machineId: OTHER_MACHINE_ID,
      name: 'OtherReminderAgent',
      displayName: 'OtherReminderAgent',
      role: 'other',
      status: 'offline',
      capabilities: {},
      permissions: {},
    },
  });

  // #remind channel — AGENT_ID is a member
  const ch = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'remind',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  CHANNEL_ID = ch.id;
  await db.controlChannelMember.create({ data: { channelId: CHANNEL_ID, memberId: AGENT_ID } });

  // Non-member channel
  const otherCh = await db.controlChannel.create({
    data: {
      workroomId: WORKROOM_ID,
      name: 'no-member-reminders',
      type: 'standard',
      visibility: 'private',
      createdBy: 'system',
    },
  });
  OTHER_CHANNEL_ID = otherCh.id;
});

afterAll(async () => {
  // Events have no workroom FK; delete by reminder ids in our workroom.
  const reminders = await db.controlReminder.findMany({ where: { workroomId: WORKROOM_ID }, select: { id: true } });
  if (reminders.length > 0) {
    await db.controlReminderEvent.deleteMany({ where: { reminderId: { in: reminders.map((r) => r.id) } } });
  }
  await db.controlReminder.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlMessage.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlEventLog.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlChannelMember.deleteMany({ where: { channel: { workroomId: WORKROOM_ID } } });
  await db.controlChannel.deleteMany({ where: { workroomId: WORKROOM_ID } });
  await db.controlAgent.deleteMany({ where: { orgId: ORG_ID } });
  await db.controlWorkroom.deleteMany({ where: { id: WORKROOM_ID } });
  await db.controlMachine.deleteMany({ where: { id: { in: [MACHINE_ID, OTHER_MACHINE_ID] } } });
  await db.controlOrg.deleteMany({ where: { id: ORG_ID } });
  await APP.close();
  await db.$disconnect();
});

// ── POST /internal/agent-api/reminders/schedule ───────────────────────────────

describe('POST /internal/agent-api/reminders/schedule', () => {
  it('schedule(in "60s") → row status scheduled version 1 + scheduled event + reminder.upserted broadcast', async () => {
    const before = await reminderEventCount('reminder.upserted');
    const now = Date.now();

    const res = await scheduleReminder('Ship the release');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('reminder');
    const r = body.reminder;
    expect(r.status).toBe('scheduled');
    expect(r.version).toBe(1);
    expect(r.title).toBe('Ship the release');

    // fireAt ~ now + 60s
    const fireAt = new Date(r.fireAt).getTime();
    expect(fireAt).toBeGreaterThanOrEqual(now + 55_000);
    expect(fireAt).toBeLessThanOrEqual(now + 90_000);

    // DB row
    const stored = await db.controlReminder.findUnique({ where: { id: r.id } });
    expect(stored).not.toBeNull();
    expect(stored!.agentId).toBe(AGENT_ID);
    expect(stored!.channelId).toBe(CHANNEL_ID);
    expect(stored!.status).toBe('scheduled');
    expect(stored!.version).toBe(1);

    // scheduled lifecycle event
    const evt = await db.controlReminderEvent.findFirst({
      where: { reminderId: r.id, kind: 'scheduled' },
    });
    expect(evt).not.toBeNull();

    // reminder.upserted broadcast event
    expect(await reminderEventCount('reminder.upserted')).toBe(before + 1);
  });

  it('schedule(at ISO) → fireAt matches', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const res = await post('/internal/agent-api/reminders/schedule', {
      channel: '#remind',
      title: 'at-based',
      at,
    });
    expect(res.statusCode).toBe(200);
    const r = JSON.parse(res.body).reminder;
    expect(new Date(r.fireAt).toISOString()).toBe(at);
  });

  it('schedule stores cadence + anchor message_id (in/at wins for first fire)', async () => {
    const mid = randomUUID();
    const res = await post('/internal/agent-api/reminders/schedule', {
      channel: '#remind',
      title: 'recurring',
      in: '5m',
      cadence: 'daily@09:00',
      message_id: mid,
    });
    expect(res.statusCode).toBe(200);
    const r = JSON.parse(res.body).reminder;
    expect(r.cadence).toBe('daily@09:00');
    const stored = await db.controlReminder.findUnique({ where: { id: r.id } });
    expect(stored!.anchorMessageId).toBe(mid);
    expect(stored!.cadence).toBe('daily@09:00');
  });

  it('schedule with cadence-only (no in/at) → fireAt = computeNextFireAt(cadence, now)', async () => {
    const now = Date.now();
    const res = await post('/internal/agent-api/reminders/schedule', {
      channel: '#remind',
      title: 'cadence-only every:1h',
      cadence: 'every:1h',
    });
    expect(res.statusCode).toBe(200);
    const r = JSON.parse(res.body).reminder;
    expect(r.cadence).toBe('every:1h');
    // every:1h from now → ~now + 1h
    const fireAt = new Date(r.fireAt).getTime();
    expect(fireAt).toBeGreaterThanOrEqual(now + 3_600_000 - 5_000);
    expect(fireAt).toBeLessThanOrEqual(now + 3_600_000 + 5_000);
  });

  it('schedule with invalid cadence → 400 INVALID_CADENCE', async () => {
    const res = await post('/internal/agent-api/reminders/schedule', {
      channel: '#remind',
      title: 'bad cadence',
      cadence: 'every:0m',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_CADENCE');
  });

  it('missing title → 400 INVALID_BODY', async () => {
    const res = await post('/internal/agent-api/reminders/schedule', { channel: '#remind', in: '60s' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_BODY');
  });

  it('not-a-member channel → 404 NOT_A_MEMBER', async () => {
    const res = await post('/internal/agent-api/reminders/schedule', {
      channel: '#no-member-reminders',
      title: 'nope',
      in: '60s',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
  });

  it("another machine's agent → 403 AGENT_NOT_OWNED", async () => {
    const res = await post(
      '/internal/agent-api/reminders/schedule',
      { channel: '#remind', title: 'cross', in: '60s' },
      headers(MACHINE_RAW_TOKEN, OTHER_AGENT_ID), // agent owned by OTHER_MACHINE, but token is MACHINE
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('AGENT_NOT_OWNED');
  });
});

// ── GET /internal/agent-api/reminders/list ────────────────────────────────────

describe('GET /internal/agent-api/reminders/list', () => {
  it('returns only the calling agent reminders (author-anchored)', async () => {
    // Own reminder
    const own = await scheduleReminder('My own reminder');
    const ownId = JSON.parse(own.body).reminder.id;

    // Another agent's reminder seeded directly
    const foreign = await db.controlReminder.create({
      data: {
        workroomId: WORKROOM_ID,
        agentId: OTHER_AGENT_ID,
        channelId: CHANNEL_ID,
        title: 'foreign reminder',
        fireAt: new Date(Date.now() + 60_000),
        status: 'scheduled',
        version: 1,
      },
    });

    const res = await get('/internal/agent-api/reminders/list?channel=%23remind');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('reminders');
    const ids = body.reminders.map((x: { id: string }) => x.id);
    expect(ids).toContain(ownId);
    expect(ids).not.toContain(foreign.id);
  });

  it('status filter narrows results', async () => {
    const res = await get('/internal/agent-api/reminders/list?status=canceled');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    for (const r of body.reminders) {
      expect(r.status).toBe('canceled');
    }
  });
});

// ── POST /internal/agent-api/reminders/snooze ─────────────────────────────────

describe('POST /internal/agent-api/reminders/snooze', () => {
  it('version ok → fireAt pushed + version bumps to 2', async () => {
    const created = await scheduleReminder('snooze me');
    const r = JSON.parse(created.body).reminder;
    const originalFireAt = new Date(r.fireAt).getTime();

    const res = await post('/internal/agent-api/reminders/snooze', {
      id: r.id,
      in: '1h',
      version: 1,
    });
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body).reminder;
    expect(out.version).toBe(2);
    expect(new Date(out.fireAt).getTime()).toBeGreaterThan(originalFireAt);

    const stored = await db.controlReminder.findUnique({ where: { id: r.id } });
    expect(stored!.version).toBe(2);
    expect(stored!.snoozedUntil).not.toBeNull();

    const evt = await db.controlReminderEvent.findFirst({ where: { reminderId: r.id, kind: 'snoozed' } });
    expect(evt).not.toBeNull();
  });

  it('stale version → 409 REMINDER_VERSION_CONFLICT', async () => {
    const created = await scheduleReminder('snooze conflict');
    const r = JSON.parse(created.body).reminder;

    const res = await post('/internal/agent-api/reminders/snooze', {
      id: r.id,
      in: '1h',
      version: 99,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('REMINDER_VERSION_CONFLICT');
  });

  it('unknown id → 404 REMINDER_NOT_FOUND', async () => {
    const res = await post('/internal/agent-api/reminders/snooze', {
      id: randomUUID(),
      in: '1h',
      version: 1,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('REMINDER_NOT_FOUND');
  });

  it("not-owned reminder → not found/forbidden", async () => {
    const foreign = await db.controlReminder.create({
      data: {
        workroomId: WORKROOM_ID,
        agentId: OTHER_AGENT_ID,
        channelId: CHANNEL_ID,
        title: 'foreign snooze',
        fireAt: new Date(Date.now() + 60_000),
        status: 'scheduled',
        version: 1,
      },
    });
    const res = await post('/internal/agent-api/reminders/snooze', {
      id: foreign.id,
      in: '1h',
      version: 1,
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ── POST /internal/agent-api/reminders/update ─────────────────────────────────

describe('POST /internal/agent-api/reminders/update', () => {
  it('version ok → applies changes + version bumps', async () => {
    const created = await scheduleReminder('update me');
    const r = JSON.parse(created.body).reminder;

    const res = await post('/internal/agent-api/reminders/update', {
      id: r.id,
      title: 'updated title',
      cadence: 'weekly:mon@09:00',
      version: 1,
    });
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body).reminder;
    expect(out.version).toBe(2);
    expect(out.title).toBe('updated title');
    expect(out.cadence).toBe('weekly:mon@09:00');

    const evt = await db.controlReminderEvent.findFirst({ where: { reminderId: r.id, kind: 'updated' } });
    expect(evt).not.toBeNull();
  });

  it('stale version → 409 REMINDER_VERSION_CONFLICT', async () => {
    const created = await scheduleReminder('update conflict');
    const r = JSON.parse(created.body).reminder;
    const res = await post('/internal/agent-api/reminders/update', {
      id: r.id,
      title: 'x',
      version: 99,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('REMINDER_VERSION_CONFLICT');
  });

  it('invalid cadence → 400 INVALID_CADENCE', async () => {
    const created = await scheduleReminder('update bad cadence');
    const r = JSON.parse(created.body).reminder;
    const res = await post('/internal/agent-api/reminders/update', {
      id: r.id,
      cadence: 'weekly:zzz@09:00',
      version: 1,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_CADENCE');
  });

  it('setting a cadence without in/at → fireAt recomputed from the rule', async () => {
    const created = await scheduleReminder('update adds cadence'); // one-shot in 60s
    const r = JSON.parse(created.body).reminder;
    const now = Date.now();
    const res = await post('/internal/agent-api/reminders/update', {
      id: r.id,
      cadence: 'every:1h',
      version: 1,
    });
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body).reminder;
    expect(out.cadence).toBe('every:1h');
    const fireAt = new Date(out.fireAt).getTime();
    expect(fireAt).toBeGreaterThanOrEqual(now + 3_600_000 - 5_000);
    expect(fireAt).toBeLessThanOrEqual(now + 3_600_000 + 5_000);
  });
});

// ── POST /internal/agent-api/reminders/cancel ─────────────────────────────────

describe('POST /internal/agent-api/reminders/cancel', () => {
  it('version ok → status canceled + reminder.canceled broadcast', async () => {
    const before = await reminderEventCount('reminder.canceled');
    const created = await scheduleReminder('cancel me');
    const r = JSON.parse(created.body).reminder;

    const res = await post('/internal/agent-api/reminders/cancel', {
      id: r.id,
      version: 1,
    });
    expect(res.statusCode).toBe(200);

    const stored = await db.controlReminder.findUnique({ where: { id: r.id } });
    expect(stored!.status).toBe('canceled');
    expect(stored!.version).toBe(2);

    const evt = await db.controlReminderEvent.findFirst({ where: { reminderId: r.id, kind: 'canceled' } });
    expect(evt).not.toBeNull();

    expect(await reminderEventCount('reminder.canceled')).toBe(before + 1);
  });

  it('stale version → 409 REMINDER_VERSION_CONFLICT', async () => {
    const created = await scheduleReminder('cancel conflict');
    const r = JSON.parse(created.body).reminder;
    const res = await post('/internal/agent-api/reminders/cancel', { id: r.id, version: 99 });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('REMINDER_VERSION_CONFLICT');
  });
});

// ── GET /internal/agent-api/reminders/log ─────────────────────────────────────

describe('GET /internal/agent-api/reminders/log', () => {
  it('returns the lifecycle events for an owned reminder', async () => {
    const created = await scheduleReminder('log me');
    const r = JSON.parse(created.body).reminder;
    await post('/internal/agent-api/reminders/snooze', { id: r.id, in: '1h', version: 1 });

    const res = await get(`/internal/agent-api/reminders/log?id=${r.id}`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('events');
    const kinds = body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('scheduled');
    expect(kinds).toContain('snoozed');
  });

  it('not-owned reminder → 403/404', async () => {
    const foreign = await db.controlReminder.create({
      data: {
        workroomId: WORKROOM_ID,
        agentId: OTHER_AGENT_ID,
        channelId: CHANNEL_ID,
        title: 'foreign log',
        fireAt: new Date(Date.now() + 60_000),
        status: 'scheduled',
        version: 1,
      },
    });
    const res = await get(`/internal/agent-api/reminders/log?id=${foreign.id}`);
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ── POST /internal/agent-api/reminders/fire ───────────────────────────────────

describe('POST /internal/agent-api/reminders/fire', () => {
  it('fire → ⏰ system message in channel + fired event + status fired', async () => {
    const created = await scheduleReminder('Time to ship');
    const r = JSON.parse(created.body).reminder;

    const res = await post('/internal/agent-api/reminders/fire', { id: r.id, version: 1 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    const stored = await db.controlReminder.findUnique({ where: { id: r.id } });
    expect(stored!.status).toBe('fired');

    // ⏰ system message in the channel
    const msg = await db.controlMessage.findFirst({
      where: { channelId: CHANNEL_ID, senderKind: 'system', content: { contains: 'Time to ship' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(msg).not.toBeNull();
    expect(msg!.content).toContain('⏰');

    // fired lifecycle event
    const evt = await db.controlReminderEvent.findFirst({ where: { reminderId: r.id, kind: 'fired' } });
    expect(evt).not.toBeNull();
  });

  it('duplicate/stale-version fire → 200 noop, no second system message', async () => {
    const created = await scheduleReminder('Fire once only');
    const r = JSON.parse(created.body).reminder;

    const first = await post('/internal/agent-api/reminders/fire', { id: r.id, version: 1 });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).ok).toBe(true);

    const msgCountAfterFirst = await db.controlMessage.count({
      where: { channelId: CHANNEL_ID, senderKind: 'system', content: { contains: 'Fire once only' } },
    });
    expect(msgCountAfterFirst).toBe(1);

    // Re-fire with the now-stale version (row was at v1; fire is idempotent on version)
    const second = await post('/internal/agent-api/reminders/fire', { id: r.id, version: 1 });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).noop).toBe(true);

    const msgCountAfterSecond = await db.controlMessage.count({
      where: { channelId: CHANNEL_ID, senderKind: 'system', content: { contains: 'Fire once only' } },
    });
    expect(msgCountAfterSecond).toBe(1);
  });

  it('unknown id → 404 REMINDER_NOT_FOUND', async () => {
    const res = await post('/internal/agent-api/reminders/fire', { id: randomUUID(), version: 1 });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('REMINDER_NOT_FOUND');
  });

  it('fire a RECURRING reminder → status stays scheduled + fireAt advanced + version++ + rescheduled event + upserted broadcast + ⏰ message', async () => {
    const before = await reminderEventCount('reminder.upserted');
    // Schedule a recurring reminder with an explicit first fireAt (in 5m) + cadence.
    const created = await post('/internal/agent-api/reminders/schedule', {
      channel: '#remind',
      title: 'Recurring standup',
      in: '5m',
      cadence: 'every:1h',
    });
    const r = JSON.parse(created.body).reminder;
    const firstFireAt = new Date(r.fireAt).getTime();

    const fireBefore = Date.now();
    const res = await post('/internal/agent-api/reminders/fire', { id: r.id, version: 1 });
    expect(res.statusCode).toBe(200);
    const fireBody = JSON.parse(res.body);
    expect(fireBody.ok).toBe(true);
    expect(fireBody.rescheduled).toBe(true);

    // Row: status stayed 'scheduled' (NOT fired), version bumped, fireAt advanced to ~now+1h.
    const stored = await db.controlReminder.findUnique({ where: { id: r.id } });
    expect(stored!.status).toBe('scheduled');
    expect(stored!.version).toBe(2);
    const newFireAt = stored!.fireAt.getTime();
    expect(newFireAt).toBeGreaterThan(firstFireAt); // advanced past the original first fire
    expect(newFireAt).toBeGreaterThanOrEqual(fireBefore + 3_600_000 - 5_000);
    expect(newFireAt).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);

    // 'fired' AND 'rescheduled' lifecycle events both exist.
    const firedEvt = await db.controlReminderEvent.findFirst({ where: { reminderId: r.id, kind: 'fired' } });
    expect(firedEvt).not.toBeNull();
    const reschedEvt = await db.controlReminderEvent.findFirst({ where: { reminderId: r.id, kind: 'rescheduled' } });
    expect(reschedEvt).not.toBeNull();
    expect((reschedEvt!.detail as { nextFireAt?: string })?.nextFireAt).toBe(stored!.fireAt.toISOString());

    // Observable ⏰ system message was still written (every fire is observable).
    const msg = await db.controlMessage.findFirst({
      where: { channelId: CHANNEL_ID, senderKind: 'system', content: { contains: 'Recurring standup' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(msg).not.toBeNull();
    expect(msg!.content).toContain('⏰');

    // reminder.upserted broadcast for the re-arm.
    expect(await reminderEventCount('reminder.upserted')).toBe(before + 2); // schedule + reschedule
  });

  it('fire a ONE-SHOT reminder → status=fired (recurring path NOT taken)', async () => {
    const created = await scheduleReminder('One shot only fire'); // no cadence → one-shot
    const r = JSON.parse(created.body).reminder;
    const res = await post('/internal/agent-api/reminders/fire', { id: r.id, version: 1 });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.rescheduled).toBeUndefined();

    const stored = await db.controlReminder.findUnique({ where: { id: r.id } });
    expect(stored!.status).toBe('fired');
    const reschedEvt = await db.controlReminderEvent.findFirst({ where: { reminderId: r.id, kind: 'rescheduled' } });
    expect(reschedEvt).toBeNull();
  });
});
