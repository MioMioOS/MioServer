/**
 * agentApiReminders — Fastify route plugin for /internal/agent-api/reminders/* endpoints.
 *
 * All endpoints require:
 *   - authorizeAgentApi (Bearer <machineToken> + X-Mio-Agent-Id → real ControlAgent)
 * Channel-targeted endpoints additionally require:
 *   - resolveAgentChannelTarget (#channel-name → channelId + workroomId, enforces membership)
 *
 * Reminders are AUTHOR-ANCHORED: mutation/read of a specific reminder is allowed only when
 * the row's agentId === auth.agent.id. We return 404 REMINDER_NOT_FOUND for "not owned" so we
 * never reveal another agent's reminder ids (anti-enumeration, mirrors AGENT_NOT_OWNED policy).
 *
 * Endpoints:
 *   POST /internal/agent-api/reminders/schedule  { title, in?|at?, cadence?, channel, message_id? }
 *     → resolve target → compute fireAt → create ControlReminder(status 'scheduled', version 1)
 *     → append ControlReminderEvent{kind:'scheduled'} → writeReminderEventAndBroadcast 'reminder.upserted'
 *     → 200 { reminder }
 *
 *   GET  /internal/agent-api/reminders/list?status=&channel=
 *     → author-anchored findMany (optionally filtered by status and resolved channel)
 *     → 200 { reminders }
 *
 *   POST /internal/agent-api/reminders/snooze   { id, in?|until?, version }
 *     → version-checked; push fireAt + set snoozedUntil; version++; event 'snoozed'; upserted broadcast
 *
 *   POST /internal/agent-api/reminders/update   { id, title?, cadence?, in?|at?, version }
 *     → version-checked; apply provided fields; version++; event 'updated'; upserted broadcast
 *
 *   POST /internal/agent-api/reminders/cancel   { id, version }
 *     → version-checked; status='canceled'; version++; event 'canceled'; 'reminder.canceled' broadcast
 *
 *   GET  /internal/agent-api/reminders/log?id=
 *     → author-owned check → ControlReminderEvent rows for that reminder
 *     → 200 { events }
 *
 *   POST /internal/agent-api/reminders/fire     { id, version }  (DAEMON-internal)
 *     → version-check is IDEMPOTENT: stale/duplicate version → 200 { ok:true, noop:true } (NOT 409)
 *     → else: insertSystemMessage('⏰ Reminder fired: <title>') in row.channelId →
 *       writeEventAndBroadcast (the EXISTING message.created chain — observable to clients) →
 *       append ControlReminderEvent{kind:'fired'} →
 *         one-shot (cadence==null)  → status='fired' (terminal), version++
 *         recurring (cadence!=null) → status stays 'scheduled', fireAt=computeNextFireAt(cadence,now),
 *                                     version++, append {kind:'rescheduled', detail:{nextFireAt}},
 *                                     broadcast reminder.upserted so daemons re-arm for the next fire
 *     → 200 { ok:true }                   — one-shot fired
 *     → 200 { ok:true, rescheduled:true } — recurring fired + rescheduled
 */

import type { FastifyInstance } from 'fastify';
import { db } from '@/storage/db';
import { authorizeAgentApi } from './agentApiAuth';
import { resolveAgentChannelTarget } from './agentApiTargets';
import { writeReminderEventAndBroadcast } from '@/control/reminders/writeReminderEventAndBroadcast';
import { insertSystemMessage } from '@/control/messages/insertSystemMessage';
import { writeEventAndBroadcast } from '@/control/messages/writeEventAndBroadcast';
import { parseCadence, computeNextFireAt } from '@/control/reminders/reminderCadence';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse a duration string like "60s" / "5m" / "1h" / "2d" into milliseconds.
 * Returns null on an unparseable value. Kept local for this chunk; Chunk F adds the
 * cadence parser separately.
 */
function parseDurationMs(value: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

/**
 * Compute a target fireAt from an `in` duration string or an `at` ISO string.
 * Returns { ok:true, fireAt } or { ok:false, message } on a bad value.
 * `now` lets callers anchor `in` to a consistent base.
 */
function computeFireAt(
  input: { in?: unknown; at?: unknown },
  now: number,
): { ok: true; fireAt: Date } | { ok: false; message: string } {
  if (input.in !== undefined && input.in !== null) {
    if (typeof input.in !== 'string') return { ok: false, message: '`in` must be a duration string' };
    const ms = parseDurationMs(input.in);
    if (ms === null) return { ok: false, message: '`in` must be a duration like "60s", "5m", "1h", "2d"' };
    return { ok: true, fireAt: new Date(now + ms) };
  }
  if (input.at !== undefined && input.at !== null) {
    if (typeof input.at !== 'string') return { ok: false, message: '`at` must be an ISO timestamp string' };
    const t = Date.parse(input.at);
    if (Number.isNaN(t)) return { ok: false, message: '`at` must be a valid ISO timestamp' };
    return { ok: true, fireAt: new Date(t) };
  }
  return { ok: false, message: 'one of `in` or `at` is required' };
}

/** Serialize a ControlReminder row to the API shape (Dates → ISO via JSON). */
type ReminderRow = NonNullable<Awaited<ReturnType<typeof db.controlReminder.findUnique>>>;
function toApi(r: ReminderRow) {
  return {
    id: r.id,
    workroomId: r.workroomId,
    agentId: r.agentId,
    channelId: r.channelId,
    anchorMessageId: r.anchorMessageId,
    title: r.title,
    fireAt: r.fireAt,
    cadence: r.cadence,
    status: r.status,
    version: r.version,
    snoozedUntil: r.snoozedUntil,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function agentApiReminders(app: FastifyInstance) {
  /**
   * POST /internal/agent-api/reminders/schedule
   *
   * Body: { title, in?|at?, cadence?, channel, message_id? }
   *
   * One-shot only for this chunk. If ONLY cadence is given (no in/at), fireAt = now
   * (Chunk F wires cadence → fireAt properly; here we just store the cadence string).
   *
   * Responses:
   *   200 { reminder }
   *   400 INVALID_BODY        — missing channel/title or bad in/at
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER
   *   409 AMBIGUOUS_CHANNEL
   */
  app.post('/internal/agent-api/reminders/schedule', async (request, reply) => {
    // ── Step 1: auth ─────────────────────────────────────────────────────────
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    // ── Step 2: parse body ────────────────────────────────────────────────────
    const body = request.body as {
      title?: unknown;
      channel?: unknown;
      in?: unknown;
      at?: unknown;
      cadence?: unknown;
      message_id?: unknown;
    } | null;

    if (!body?.channel || typeof body.channel !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'channel is required' } });
    }
    if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'title must be a non-empty string' } });
    }
    if (body.cadence !== undefined && body.cadence !== null && typeof body.cadence !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'cadence must be a string' } });
    }
    if (body.message_id !== undefined && body.message_id !== null && typeof body.message_id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'message_id must be a string' } });
    }

    // ── Step 3: resolve target (membership-anchored) ──────────────────────────
    const resolved = await resolveAgentChannelTarget(body.channel, agent.id);
    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
    }
    const { channelId, workroomId } = resolved;

    // ── Step 4: validate cadence (if provided) ────────────────────────────────
    // A recurring reminder carries a cadence rule; validate it up front so an
    // invalid rule is a 400 INVALID_CADENCE (never persisted, never reaches the
    // fire-reschedule path with a bad string).
    const cadence = (body.cadence as string | undefined) ?? null;
    if (cadence !== null) {
      try {
        parseCadence(cadence);
      } catch (err) {
        return reply.code(400).send({ error: { code: 'INVALID_CADENCE', message: (err as Error).message } });
      }
    }

    // ── Step 5: compute fireAt ────────────────────────────────────────────────
    // Precedence: an explicit `in`/`at` wins for the FIRST fire (even when a cadence
    // is also given); the cadence is stored for the SUBSEQUENT reschedule. If ONLY a
    // cadence is given (no in/at), the first fireAt is computeNextFireAt(cadence, now).
    const now = Date.now();
    let fireAt: Date;
    if (body.in === undefined && body.at === undefined) {
      if (cadence === null) {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'one of `in`, `at`, or `cadence` is required' } });
      }
      fireAt = computeNextFireAt(cadence, new Date(now)); // cadence-only → first fire from the rule
    } else {
      const computed = computeFireAt(body, now);
      if (!computed.ok) {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: computed.message } });
      }
      fireAt = computed.fireAt;
    }

    // ── Step 6: create reminder + scheduled event ─────────────────────────────
    const reminder = await db.controlReminder.create({
      data: {
        agentId: agent.id,
        channelId,
        workroomId,
        anchorMessageId: (body.message_id as string | undefined) ?? null,
        title: body.title,
        fireAt,
        cadence,
        version: 1,
        status: 'scheduled',
      },
    });
    await db.controlReminderEvent.create({
      data: { reminderId: reminder.id, kind: 'scheduled' },
    });

    // ── Step 7: write-before-broadcast reminder.upserted ──────────────────────
    await writeReminderEventAndBroadcast({
      workroomId,
      topic: 'reminder.upserted',
      payload: { agentId: agent.id, reminder: toApi(reminder) },
    });

    return reply.code(200).send({ reminder: toApi(reminder) });
  });

  /**
   * GET /internal/agent-api/reminders/list?status=&channel=
   *
   * Author-anchored: returns only reminders authored by the calling agent.
   * Optional filters:
   *   status  — exact status match
   *   channel — `#channel-name`; restricts to that channel (membership-enforced)
   *
   * Responses:
   *   200 { reminders }
   *   400 TARGET_UNSUPPORTED (bad channel format)
   *   401 MACHINE_TOKEN_INVALID
   *   403 AGENT_NOT_OWNED
   *   404 NOT_A_MEMBER
   *   409 AMBIGUOUS_CHANNEL
   */
  app.get('/internal/agent-api/reminders/list', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const query = request.query as { status?: string; channel?: string };

    // If a channel filter is supplied, resolve + enforce membership.
    let channelId: string | undefined;
    if (query.channel && typeof query.channel === 'string') {
      const resolved = await resolveAgentChannelTarget(query.channel, agent.id);
      if (!resolved.ok) {
        return reply.code(resolved.status).send({ error: { code: resolved.code, message: resolved.message } });
      }
      channelId = resolved.channelId;
    }

    const reminders = await db.controlReminder.findMany({
      where: {
        agentId: agent.id,
        ...(query.status ? { status: query.status } : {}),
        ...(channelId ? { channelId } : {}),
      },
      orderBy: { fireAt: 'asc' },
      take: 200,
    });

    return reply.code(200).send({ reminders: reminders.map(toApi) });
  });

  /**
   * POST /internal/agent-api/reminders/snooze  { id, in?|until?, version }
   *
   * Responses:
   *   200 { reminder }
   *   400 INVALID_BODY
   *   404 REMINDER_NOT_FOUND       — unknown id OR not owned by this agent
   *   409 REMINDER_VERSION_CONFLICT
   */
  app.post('/internal/agent-api/reminders/snooze', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const body = request.body as { id?: unknown; in?: unknown; until?: unknown; version?: unknown } | null;
    if (!body?.id || typeof body.id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'id is required' } });
    }
    if (typeof body.version !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'version is required' } });
    }

    const row = await loadOwnedReminder(body.id, agent.id);
    if (!row) {
      return reply.code(404).send({ error: { code: 'REMINDER_NOT_FOUND', message: 'Reminder not found' } });
    }
    if (body.version !== row.version) {
      return reply.code(409).send({ error: { code: 'REMINDER_VERSION_CONFLICT', message: `Expected version ${row.version}` } });
    }

    // Compute the new fireAt from `in` (duration) or `until` (ISO).
    const now = Date.now();
    const computed = computeFireAt({ in: body.in, at: body.until }, now);
    if (!computed.ok) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: computed.message } });
    }

    const updated = await db.controlReminder.update({
      where: { id: row.id },
      data: {
        fireAt: computed.fireAt,
        snoozedUntil: computed.fireAt,
        version: row.version + 1,
        status: 'scheduled',
      },
    });
    await db.controlReminderEvent.create({ data: { reminderId: row.id, kind: 'snoozed' } });

    await writeReminderEventAndBroadcast({
      workroomId: row.workroomId,
      topic: 'reminder.upserted',
      payload: { agentId: agent.id, reminder: toApi(updated) },
    });

    return reply.code(200).send({ reminder: toApi(updated) });
  });

  /**
   * POST /internal/agent-api/reminders/update  { id, title?, cadence?, in?|at?, version }
   *
   * Responses:
   *   200 { reminder }
   *   400 INVALID_BODY
   *   404 REMINDER_NOT_FOUND
   *   409 REMINDER_VERSION_CONFLICT
   */
  app.post('/internal/agent-api/reminders/update', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const body = request.body as {
      id?: unknown;
      title?: unknown;
      cadence?: unknown;
      in?: unknown;
      at?: unknown;
      version?: unknown;
    } | null;
    if (!body?.id || typeof body.id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'id is required' } });
    }
    if (typeof body.version !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'version is required' } });
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'title must be a non-empty string' } });
    }
    if (body.cadence !== undefined && body.cadence !== null && typeof body.cadence !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'cadence must be a string' } });
    }

    // A non-null cadence change must validate (→ 400 INVALID_CADENCE on a bad rule).
    const newCadence = body.cadence === undefined ? undefined : ((body.cadence as string | null) ?? null);
    if (newCadence !== undefined && newCadence !== null) {
      try {
        parseCadence(newCadence);
      } catch (err) {
        return reply.code(400).send({ error: { code: 'INVALID_CADENCE', message: (err as Error).message } });
      }
    }

    const row = await loadOwnedReminder(body.id, agent.id);
    if (!row) {
      return reply.code(404).send({ error: { code: 'REMINDER_NOT_FOUND', message: 'Reminder not found' } });
    }
    if (body.version !== row.version) {
      return reply.code(409).send({ error: { code: 'REMINDER_VERSION_CONFLICT', message: `Expected version ${row.version}` } });
    }

    // Build the patch. fireAt changes if `in`/`at` is supplied; OR (no in/at) if a
    // non-null cadence is being set/changed — then recompute the next fire from the rule.
    const data: {
      title?: string;
      cadence?: string | null;
      fireAt?: Date;
      version: number;
    } = { version: row.version + 1 };

    if (body.title !== undefined) data.title = body.title as string;
    if (newCadence !== undefined) data.cadence = newCadence;
    if (body.in !== undefined || body.at !== undefined) {
      const computed = computeFireAt(body, Date.now());
      if (!computed.ok) {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: computed.message } });
      }
      data.fireAt = computed.fireAt;
    } else if (newCadence !== undefined && newCadence !== null) {
      // Cadence set/changed without an explicit fireAt → recompute the next fire.
      data.fireAt = computeNextFireAt(newCadence, new Date());
    }

    const updated = await db.controlReminder.update({ where: { id: row.id }, data });
    await db.controlReminderEvent.create({ data: { reminderId: row.id, kind: 'updated' } });

    await writeReminderEventAndBroadcast({
      workroomId: row.workroomId,
      topic: 'reminder.upserted',
      payload: { agentId: agent.id, reminder: toApi(updated) },
    });

    return reply.code(200).send({ reminder: toApi(updated) });
  });

  /**
   * POST /internal/agent-api/reminders/cancel  { id, version }
   *
   * Responses:
   *   200 { reminder }
   *   400 INVALID_BODY
   *   404 REMINDER_NOT_FOUND
   *   409 REMINDER_VERSION_CONFLICT
   */
  app.post('/internal/agent-api/reminders/cancel', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const body = request.body as { id?: unknown; version?: unknown } | null;
    if (!body?.id || typeof body.id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'id is required' } });
    }
    if (typeof body.version !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'version is required' } });
    }

    const row = await loadOwnedReminder(body.id, agent.id);
    if (!row) {
      return reply.code(404).send({ error: { code: 'REMINDER_NOT_FOUND', message: 'Reminder not found' } });
    }
    if (body.version !== row.version) {
      return reply.code(409).send({ error: { code: 'REMINDER_VERSION_CONFLICT', message: `Expected version ${row.version}` } });
    }

    const updated = await db.controlReminder.update({
      where: { id: row.id },
      data: { status: 'canceled', version: row.version + 1 },
    });
    await db.controlReminderEvent.create({ data: { reminderId: row.id, kind: 'canceled' } });

    await writeReminderEventAndBroadcast({
      workroomId: row.workroomId,
      topic: 'reminder.canceled',
      payload: { agentId: agent.id, reminderId: row.id, version: updated.version },
    });

    return reply.code(200).send({ reminder: toApi(updated) });
  });

  /**
   * GET /internal/agent-api/reminders/log?id=
   *
   * Author-owned check, then returns the reminder's lifecycle events.
   *
   * Responses:
   *   200 { events }
   *   400 INVALID_QUERY
   *   404 REMINDER_NOT_FOUND
   */
  app.get('/internal/agent-api/reminders/log', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const query = request.query as { id?: string };
    if (!query.id || typeof query.id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: 'id is required' } });
    }

    const row = await loadOwnedReminder(query.id, agent.id);
    if (!row) {
      return reply.code(404).send({ error: { code: 'REMINDER_NOT_FOUND', message: 'Reminder not found' } });
    }

    const events = await db.controlReminderEvent.findMany({
      where: { reminderId: row.id },
      orderBy: { at: 'asc' },
      take: 200,
    });

    return reply.code(200).send({
      events: events.map((e) => ({ id: e.id, reminderId: e.reminderId, kind: e.kind, at: e.at, detail: e.detail })),
    });
  });

  /**
   * POST /internal/agent-api/reminders/fire  { id, version }   (DAEMON-internal)
   *
   * Idempotent on version: a stale/duplicate fire is a no-op (200 { ok:true, noop:true }),
   * NOT a 409. On a fresh fire: post the observable ⏰ system message into the channel via the
   * EXISTING message.created chain, append a 'fired' lifecycle event, and (one-shot) mark fired.
   *
   * Responses:
   *   200 { ok:true }                 — fired
   *   200 { ok:true, noop:true }      — stale/duplicate version (idempotent no-op)
   *   400 INVALID_BODY
   *   404 REMINDER_NOT_FOUND
   */
  app.post('/internal/agent-api/reminders/fire', async (request, reply) => {
    const auth = await authorizeAgentApi(request);
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: { code: auth.code, message: auth.message } });
    }
    const { agent } = auth;

    const body = request.body as { id?: unknown; version?: unknown } | null;
    if (!body?.id || typeof body.id !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'id is required' } });
    }
    if (typeof body.version !== 'number') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'version is required' } });
    }

    const row = await loadOwnedReminder(body.id, agent.id);
    if (!row) {
      return reply.code(404).send({ error: { code: 'REMINDER_NOT_FOUND', message: 'Reminder not found' } });
    }

    // Idempotent fire: a stale/duplicate version (already fired, or re-fired) is a no-op.
    // This is NOT a 409 — 409 is reserved for snooze/update/cancel mutations.
    if (body.version !== row.version) {
      return reply.code(200).send({ ok: true, noop: true });
    }
    // A reminder that is no longer scheduled (already fired/canceled) is also a no-op.
    if (row.status !== 'scheduled' && row.status !== 'snoozed') {
      return reply.code(200).send({ ok: true, noop: true });
    }

    // ── Observable message: reuse the EXISTING message.created chain ───────────
    // insertSystemMessage takes channelId ONLY (anchorMessageId is metadata, NOT a post target).
    const msgRow = await insertSystemMessage({
      workroomId: row.workroomId,
      channelId: row.channelId,
      content: `⏰ Reminder fired: ${row.title}`,
    });
    await writeEventAndBroadcast(msgRow);

    // ── Lifecycle event + state ───────────────────────────────────────────────
    await db.controlReminderEvent.create({ data: { reminderId: row.id, kind: 'fired' } });

    if (row.cadence != null) {
      // RECURRING (Chunk F): do NOT terminate. Compute the next fire from the cadence
      // rule (anchored at now — drift-on-jitter is intended; matches skip-backlog),
      // advance fireAt + version, keep status 'scheduled', append a 'rescheduled' event,
      // and broadcast reminder.upserted so each daemon's ReminderCache re-arms for the
      // next fire (the bumped version makes that fire a DISTINCT (id,version) → no
      // double-fire of the version we just fired).
      let nextFireAt: Date;
      try {
        nextFireAt = computeNextFireAt(row.cadence, new Date());
      } catch {
        // A stored-but-now-invalid cadence should not strand the reminder mid-fire.
        // Fall back to one-shot termination (defensive; schedule/update validate cadence).
        await db.controlReminder.update({
          where: { id: row.id },
          data: { status: 'fired', version: row.version + 1 },
        });
        return reply.code(200).send({ ok: true });
      }

      const rescheduled = await db.controlReminder.update({
        where: { id: row.id },
        data: { fireAt: nextFireAt, version: row.version + 1, status: 'scheduled' },
      });
      await db.controlReminderEvent.create({
        data: { reminderId: row.id, kind: 'rescheduled', detail: { nextFireAt: nextFireAt.toISOString() } },
      });
      await writeReminderEventAndBroadcast({
        workroomId: row.workroomId,
        topic: 'reminder.upserted',
        payload: { agentId: agent.id, reminder: toApi(rescheduled) },
      });

      return reply.code(200).send({ ok: true, rescheduled: true });
    }

    // ONE-SHOT (cadence == null) → terminal status 'fired' (unchanged).
    await db.controlReminder.update({
      where: { id: row.id },
      data: { status: 'fired', version: row.version + 1 },
    });

    return reply.code(200).send({ ok: true });
  });
}

// ── Shared helper ───────────────────────────────────────────────────────────────

/**
 * Load a reminder by id, enforcing author ownership.
 * Returns the row if it exists AND is authored by `agentId`; otherwise null
 * (caller maps null → 404 REMINDER_NOT_FOUND — we do not distinguish "missing" from
 * "not owned" to avoid leaking another agent's reminder ids).
 */
async function loadOwnedReminder(id: string, agentId: string) {
  const row = await db.controlReminder.findUnique({ where: { id } });
  if (!row || row.agentId !== agentId) return null;
  return row;
}
