# Slock Clone — Slice 4.1: Reminders (self-wake) — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A faithful server-side reminder/self-wake subsystem — agents `mio reminder schedule/list/snooze/update/cancel/log` (incl. recurring cadences, anchored to a message/thread or channel); the server persists + broadcasts; the daemon's per-agent ReminderCache fires locally at the time → wakes the author's session + records an observable system message in the surface.

**Architecture:** Server = source of truth (ControlReminder table + agent-api + versioned + observable fire system message via insertSystemMessage). Daemon = ReminderCache synced over WS (reminder.* events via publishControlEvent → catch-up replayable) that fires locally (enqueueUserTurn author wake) + reports the fire to the server. Recurrence via a cadence parser + nextFireAt reschedule-on-fire. No central router; no daemon-local persistence.

**Tech Stack:** Fastify + Prisma + Postgres (MioServer); Node + tsx/SEA, socket.io WS (mio-agent); vitest.

**Spec:** `MioServer/docs/superpowers/specs/2026-05-25-slock-clone-slice4.1-reminders-design.md`

**Hard constraints:**
- Repos NOT git-tracked → **SKIP every commit step** (never run `git`).
- MioServer: `npm run test:integration -- <paths>` (integration) / `npx vitest run <paths>` (unit) / `npx tsc --noEmit`. NEVER `prisma migrate dev` — test DB is built by `scripts/setup-test-db.sh`'s `CONTROL_PLANE_MIGRATIONS` array (add the new migration.sql path, mirroring the `20260525000000_s2_task_number` entry); prod via `prisma migrate deploy`.
- mio-agent: `npm test` + `npx tsc --noEmit`.
- **Sequence recurrence LAST (Chunk F)** — land + dogfood the one-shot core first.
- Reuse, don't rebuild. No central router.

---

## File Structure
**MioServer:**
- `prisma/schema.prisma` — add `ControlReminder` + `ControlReminderEvent` models.
- `prisma/migrations/<ts>_s4_reminders/migration.sql` — DDL; add its path to `scripts/setup-test-db.sh` `CONTROL_PLANE_MIGRATIONS`.
- `sources/control/reminders/reminderCadence.ts` — cadence parser + `computeNextFireAt` (Chunk F).
- `sources/control/reminders/writeReminderEventAndBroadcast.ts` — publishControlEvent(reminder.upserted/canceled)+broadcast helper.
- `sources/control/agentApi/agentApiReminders.ts` — the routes; register in `sources/api.ts`.
- Tests: `*.integration.spec.ts` + `reminderCadence.spec.ts`.

**mio-agent:**
- `src/orchestrator/reminderCache.ts` — the cache + onFire + timers + dedup.
- `src/gateway/restClient.ts` — `apiReminder*` client fns (+ gateway methods).
- `src/orchestrator/inboxDelivery.ts` OR the gateway WS routing — route `reminder.*` events to the cache (additive).
- `src/cli/commands/run.ts` — wire `createReminderCache` in `startAgentSpine`; report-fire.
- `src/proxy/agentProxy.ts` — `reminder` action; `src/proxy/cliTransport.ts` — capability `reminders`.
- `src/agentcli/index.ts` — `mio reminder` subcommands.
- `src/runtimes/systemPrompt.ts` — Reminders section.
- `src/simulation/{mioServerSetup,slice4_1RoundTrip}.ts` — acceptance.

---

## Chunk A: MioServer — schema + migration

### Task A1: `ControlReminder` + `ControlReminderEvent` schema + migration (2 registrations, 1 DDL)
**Files:** `prisma/schema.prisma`; `prisma/migrations/<ts>_s4_reminders/migration.sql`; `scripts/setup-test-db.sh`.
- [ ] **Step 1:** Add to `schema.prisma` (mirror `ControlTask` ~line 586 for FK/index/map style):
  - `ControlReminder`: `id @id @default(uuid()) @db.Uuid`, `workroomId @map("workroom_id") @db.Uuid`, `agentId @map("agent_id") @db.Uuid` (author, FK→ControlAgent), `channelId @map("channel_id") @db.Uuid` (anchor surface), `anchorMessageId String? @map("anchor_message_id") @db.Uuid`, `title String`, `fireAt DateTime @map("fire_at")`, `cadence String?` (null=one-shot), `status String @default("scheduled")`, `version Int @default(1)`, `snoozedUntil DateTime? @map("snoozed_until")`, `createdAt @default(now())`, `updatedAt @updatedAt`. `@@index([agentId, status])`, `@@index([workroomId])`, `@@map("control_reminders")`. Relation back from ControlAgent if needed (match ControlTask's owner relation style; a plain FK column is fine if no relation field is required).
  - `ControlReminderEvent`: `id`, `reminderId @map("reminder_id") @db.Uuid` (FK→ControlReminder), `kind String`, `at DateTime @default(now())`, `detail Json?`. `@@index([reminderId])`, `@@map("control_reminder_events")`.
- [ ] **Step 2:** Create `prisma/migrations/<ts>_s4_reminders/migration.sql` with the CREATE TABLE DDL for both (snake_case columns, the two indexes each). Since the schema uses plain FK columns WITHOUT Prisma relation fields (valid — `ControlMessage.senderId`/`ControlAction.approvalId` are plain-FK precedents), the DB-level `FOREIGN KEY` constraints exist ONLY if the hand-written DDL adds them — so explicitly add `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` (agent_id→control_agents, channel_id→control_channels, workroom_id→control_workrooms; reminder_id→control_reminders). **Open `prisma/migrations/20260524050000_s3_task_channel/migration.sql` and mirror its exact FK + index SQL syntax.** Use a timestamp later than `20260525000000`.
- [ ] **Step 3:** Add the migration.sql path to `CONTROL_PLANE_MIGRATIONS` in `scripts/setup-test-db.sh` (after the `20260525000000_s2_task_number` entry, line ~72). Run `npm run test:db:setup` → confirm the tables are created (no error).
- [ ] **Step 4:** `npx prisma generate` (local, to update the client types) + `npx tsc --noEmit` clean.
- [ ] **Step 5: (no git).**

---

## Chunk B: MioServer — agent-api reminders routes + fire endpoint

### Task B1: `writeReminderEventAndBroadcast` helper
**Files:** Create `sources/control/reminders/writeReminderEventAndBroadcast.ts`; Test (unit or via the routes' integration).
- [ ] Mirror `sources/control/messages/writeEventAndBroadcast.ts` EXACTLY for signatures (it hardcodes topic `'message.created'`; we parameterize the topic). Single name + object form everywhere: `writeReminderEventAndBroadcast({ workroomId, topic, payload })` where `topic ∈ 'reminder.upserted'|'reminder.canceled'`:
  ```ts
  const event = await publishControlEvent({ workroomId, eventId: randomUUID(), topic, payload });
  if (!event.idempotent) {
    workroomBroadcaster.broadcast(workroomId, {
      event_id: event.eventId,
      workroom_id: event.workroomId,
      seq: event.seq.toString(),
      topic: event.topic,
      payload: event.payloadJson as Record<string, unknown>,
      created_at: event.createdAt.toISOString(),
    });
  }
  ```
  **EXACT signatures (verified — do NOT follow the stale docstring at the top of publishControlEvent.ts):** `publishControlEvent` takes the OBJECT form `{ workroomId, eventId, topic, payload }` — there is NO `db` field (it opens its own tx). `workroomBroadcaster.broadcast(workroomId, payload)` requires `{ event_id, workroom_id, seq, topic, payload, created_at }` (NOT `{id,seq,topic,payload}`). The `if (!event.idempotent)` guard mirrors writeEventAndBroadcast.ts:49 (don't re-broadcast an idempotent re-publish). All callers use `writeReminderEventAndBroadcast({workroomId, topic, payload})` (object form — fix any `writeReminderEvent('topic', {...})` positional calls in B2 to this).
- [ ] Test: assert publishControlEvent called with the reminder topic + broadcast emitted with the 6-field shape (mock or via integration in B2).

### Task B2: agent-api reminders routes (one-shot core; cadence accepted but reschedule wired in F)
**Files:** Create `sources/control/agentApi/agentApiReminders.ts`; Modify `sources/api.ts` (register, sibling of agentApiTasks); Test `sources/control/agentApi/agentApiReminders.integration.spec.ts`.

Endpoints (all `authorizeAgentApi`; mirror `agentApiTasks.ts` structure + error-reply shape):
- `POST /internal/agent-api/reminders/schedule` `{title, in?|at?|cadence?, channel, message_id?}` → `resolveAgentChannelTarget(channel, auth.agent.id)` for channelId/workroomId/membership; compute `fireAt` (from `in` duration or `at` ISO; if only `cadence`, fireAt = computeNextFireAt(cadence, now) — but Chunk F owns computeNextFireAt, so for B accept `in`/`at` and treat `cadence` as stored-but-fireAt-from-in/at-or-now; F wires cadence→fireAt); create row (agentId=author, version=1, status=scheduled, cadence stored); append `scheduled` ControlReminderEvent; `writeReminderEventAndBroadcast({workroomId, topic:'reminder.upserted', payload:{agentId, reminder}})`; return the reminder.
- `GET /internal/agent-api/reminders/list?status=&channel=` → `where:{ agentId: auth.agent.id, ...status?, ...channel? }` (author-anchored). Return `{reminders:[...]}`.
- `POST /reminders/snooze` `{id, in|until, version}` → load by id (author-owned check); if `version !== row.version` → 409 REMINDER_VERSION_CONFLICT; set fireAt (now+in or until) + snoozedUntil; `version++`; `snoozed` event; upsert broadcast.
- `POST /reminders/update` `{id, title?, cadence?, in?|at?, version}` → version-check; apply changes; `version++`; `updated` event; upsert broadcast.
- `POST /reminders/snooze`/`/update`: on success → `writeReminderEventAndBroadcast({workroomId, topic:'reminder.upserted', payload:{agentId, reminder}})`.
- `POST /reminders/cancel` `{id, version}` → version-check; status=canceled; `canceled` event; `writeReminderEventAndBroadcast({workroomId, topic:'reminder.canceled', payload:{agentId, reminderId:id, version}})`.
- `GET /reminders/log?id=` → the ControlReminderEvent rows for that reminder (author-owned check).
- `POST /reminders/fire` `{id, version}` (DAEMON-internal) → version-check (idempotent: if version already advanced → 200 no-op); `insertSystemMessage({workroomId, channelId, content:`⏰ Reminder fired: ${title}`})` (NOTE: `insertSystemMessage` takes `channelId` ONLY — there is no thread-target param; the fire message always goes to the row's `channelId`. `anchor_message_id` is stored metadata, NOT a different post target — drop any thread-or-channel ternary) then `writeEventAndBroadcast(...)` (the OBSERVABLE message reuses the EXISTING slice-2 `message.created` chain, NOT the reminder helper); append `fired` event; ONE-SHOT (cadence==null) → status=fired; (RECURRING handled in F — for B, one-shot only). Return ok.

- [ ] **Step 1:** Failing integration test (mirror `agentApiTasks.integration.spec.ts` boot+seed; seed a machine+agent+channel the agent is a member of). Cases: schedule(in 60s)→row+scheduled-event+upsert-broadcast; list→only own; snooze(version ok / stale→409); update; cancel(→canceled event+broadcast); log→events; fire(→observable system message in channel + fired event + status=fired; duplicate fire same version→no-op). not-member channel on schedule→404; another machine's agent→403.
- [ ] **Step 2:** Run fail (`npm run test:integration -- sources/control/agentApi/agentApiReminders.integration.spec.ts`).
- [ ] **Step 3:** Implement the routes + register in `sources/api.ts` (`await app.register(agentApiReminders)`).
- [ ] **Step 4:** Run pass + `npm run test:integration -- sources/control/agentApi` (no regression) + `npx tsc --noEmit`.
- [ ] **Step 5: (no git).**

---

## Chunk C: mio-agent — ReminderCache + sync + onFire + wiring

### Task C1: `apiReminder*` client + gateway methods
**Files:** Modify `src/gateway/restClient.ts` (+ ServerGateway); Test `restClient.spec.ts`.
- [ ] Add `apiReminderSchedule/List/Snooze/Update/Cancel/Log/Fire(serverUrl, token, agentId, payload)` → `POST|GET /internal/agent-api/reminders/<op>` with `Authorization: Bearer` + `X-Mio-Agent-Id` (mirror `apiGetAgentChannels`). Add matching `ServerGateway` methods (at least `reminderFire(agentId, id, version)` + a `listReminders(agentId)` for snapshot). Tests mirror the apiGetAgentChannels test (URL + both headers + parse + non-2xx throws).

### Task C2: `ReminderCache`
**Files:** Create `src/orchestrator/reminderCache.ts`; Test `reminderCache.spec.ts`.
- [ ] **Design:** `createReminderCache({ agentId, onFire, clock?, })` (clock injectable, default Date.now). **In-memory ONLY — no disk persistence** (server is the source of truth; do NOT mirror agentInboxCursorStore's on-disk JSON — the cache is a transient Map). Internal `Map<reminderId, {reminder, timer}>`. Methods: `upsert(reminder)` (ignore if held version OLDER; (re)arm a `setTimeout(fireAt-now)` unref'd; if fireAt already past → fire now), `cancel(reminderId, version?)` (terminal — clear timer + remove by id regardless of version), `snapshot(reminders[])` (clear the job Map + upsert each), `clear()`, `stop()`. **Wake-dedup:** a `Map<reminderId, lastWakeFiredVersion>` (monotonic — smaller + sufficient vs a string Set); before calling the onFire cb, check `version > lastWakeFired[id]` — if not greater → skip the wake (do NOT call onFire cb) but still allow the caller's fire-report retry. **CRITICAL: the wake-dedup Map is INDEPENDENT of the job Map — it is NOT cleared by `clear()`/`snapshot()` (only `stop()` discards it).** Else a snapshot re-arming a just-fired one-shot (report in flight) would double-wake. The `onFire` callback (wired in C3) does the inject + report.
- [ ] Tests (injected clock): upsert arms+fires at fireAt; past fireAt fires immediately; cancel removes (any version); snapshot rebuilds; stale-version (older) upsert ignored; (id,version) wake-dedup (two fires same version → onFire cb once); **snapshot re-including a just-wake-fired reminder → onFire cb NOT called again** (dedup survives snapshot); stop() clears timers.

### Task C3: wire ReminderCache into startAgentSpine + WS routing + report-fire
**Files:** Modify `src/cli/commands/run.ts` (startAgentSpine + the AgentSpineHandle stop()); Modify the daemon WS routing (`inboxDelivery.ts` handler OR the gateway) to route `reminder.*` to the cache; Test `run.spec.ts`.
- [ ] In `startAgentSpine`, create `const reminderCache = createReminderCache({ agentId, onFire: async (job) => { host.enqueueUserTurn(`[reminder fired] ${job.title}`); await gateway.reminderFire(agentId, job.id, job.version).catch(log-and-retry); } })`. On boot, `gateway.listReminders(agentId)` → `reminderCache.snapshot(...)`. Add `reminderCache.stop()` to the handle's `stop()` (alongside coord/host/proxy).
- [ ] WS routing: in the coordinator's event handler (or a sibling handler subscribed to the same gateway), route `event.topic === 'reminder.upserted'` → `reminderCache.upsert(payload.reminder)`, `'reminder.canceled'` → `reminderCache.cancel(payload.reminderId, payload.version)`. Additive — must not disturb message.created/channel.member_* routing. (NO `reminder.snapshot` WS topic — snapshot is a REST PULL: `gateway.listReminders(agentId)` on boot/reconnect → `reminderCache.snapshot(...)`. The server never broadcasts a snapshot topic; routing one would be a phantom branch.)
- [ ] Tests: startAgentSpine creates the cache + snapshots on boot; a reminder.upserted event arms it; onFire injects into host + calls gateway.reminderFire; handle.stop() stops the cache. (MultiSpineHandle already exposes per-agent handles — each agent gets its own cache.)
- [ ] Run pass + `npm test` + `npx tsc --noEmit`.

---

## Chunk D: mio-agent — proxy action + CLI + prompt

### Task D1: agentProxy `reminder` action + capability
**Files:** Modify `src/proxy/agentProxy.ts`; `src/proxy/cliTransport.ts` (capability); Test `agentProxy.spec.ts`.
- [ ] Add `reminder` to the `Action` union + `CAPABILITY_REQUIRED` (`reminders`). `forwardReminder` maps `payload.op ∈ {schedule,list,snooze,update,cancel,log}` → `/internal/agent-api/reminders/<op>` (GET for list/log, POST else), strips `op` from the body, relays errors (incl 409). (Mirror `forwardTask` exactly. NOTE: `fire` is NOT a CLI op — daemon-internal only; do not expose it via the proxy action.) cliTransport capabilities → `send,read,tasks,reminders`. Run.ts startAgentSpine prepareCliTransport capabilities list → add `reminders`.
- [ ] Tests: each op → right method+path; unknown op → 400; missing `reminders` cap → 403; 409 relayed; op stripped; `fire` NOT routable via the action.

### Task D2: `mio reminder` CLI + systemPrompt section
**Files:** Modify `src/agentcli/index.ts`; `src/runtimes/systemPrompt.ts`; Tests.
- [ ] CLI `mio reminder schedule --title "<t>" (--in <dur>|--at <ISO>|--cadence <rule>) [--channel #x] [--message-id <id>]`, `list [--channel]`, `snooze <id> (--in|--until)`, `update <id> [--title][--cadence][--in|--at]`, `cancel <id>`, `log <id>` → proxy reminder action with payload.op. Canonical text out / stderr-JSON on error. Version for snooze/update/cancel: read current via list then pass (or pass-through + surface 409). Mirror the `mio task` CLI branch.
- [ ] systemPrompt `## Reminders` section (after Orchestration or Tasks): when to use (follow-up depending on future state; self check-backs; "to notify someone later, schedule a reminder and @mention them when it fires"), the 6 commands, cadence rules (`every:<dur>|daily@HH:MM|weekly:<dow>@HH:MM`, UTC), that a fired reminder wakes only you + is observable in the surface, prefer snooze/update over re-create.
- [ ] Tests: each subcommand sends right payload; missing required flags → MISSING_ARG; systemPrompt contains the `## Reminders` heading + commands + cadence note + capability `reminders` in the wrapper.
- [ ] Run pass + `npm test` + `npx tsc --noEmit`.

---

## Chunk E: acceptance (one-shot core) + regression

### Task E1: extend mioServerSetup + `slice4_1RoundTrip.ts` (one-shot)
**Files:** Modify `src/simulation/mioServerSetup.ts` (register agentApiReminders; the existing seeded agent in #general suffices as author); Create `src/simulation/slice4_1RoundTrip.ts` (model on slice3_2RoundTrip — reuse TestGateway, per-agent coord.onInjected recorder, op/human path, assertPass/exit, workDirs cleanup).
- [ ] Register `agentApiReminders` in mioServerSetup.
- [ ] Runner: boot sim MioServer + the agent spine (with its ReminderCache). Drive a `mio reminder schedule --title "X" --in <~1s> --channel #sim` through the real path (stub on a trigger, or a direct proxy/CLI call via the wrapper). Wait ~fire window. Assert (HARD, real path): (a) the author's host received `[reminder fired] X` (onInjected recorder); (b) an observable `⏰ Reminder fired: X` system message exists in #sim (read channel history / messages); (c) the reminder row advanced to `status=fired` (read via reminders/list). PLUS: list shows the reminder pre-fire; snooze pushes fireAt; cancel → canceled (no fire); a version-conflict (snooze with stale version → 409); restart-overdue (recreate the cache from a snapshot whose fireAt is past → fires immediately).
- [ ] Run stub: `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice4_1RoundTrip.ts` → exit 0, green. (test DB has the reminder tables from Chunk A's setup-test-db.sh entry; `npm run test:db:setup` if needed.)
- [ ] Attempt real-claude once (best-effort on the agent's reaction; a/b/c stay hard).

### Task E2: regression (one-shot core)
- [ ] mio-agent `npm test` + `npx tsc --noEmit`; slice1 10/10, slice2 13/13, slice3 20/20, slice3.2 14/14. MioServer `npm run test:integration -- sources/control/agentApi sources/control/reminders` + `npx tsc --noEmit`.

---

## Chunk F: RECURRENCE (last — on the proven one-shot core)

### Task F1: cadence parser + `computeNextFireAt`
**Files:** Create `sources/control/reminders/reminderCadence.ts`; Test `reminderCadence.spec.ts`.
- [ ] `parseCadence(rule)` + `computeNextFireAt(cadence, from: Date): Date` for `every:<int><m|h|d>`, `daily@HH:MM` (UTC), `weekly:<dow>@HH:MM` (dow = lowercase mon..sun, UTC). Invalid rule → throw a clear error (the schedule/update route maps it to 400). Pure function, UTC-deterministic.
- [ ] Tests (fixed `from`): every:15m → +15min; every:2h; every:1d; daily@09:00 from 08:00 → today 09:00, from 10:00 → tomorrow 09:00; weekly:mon@09:00; invalid → throws.

### Task F2: wire cadence into schedule + fire-reschedule
**Files:** Modify `sources/control/agentApi/agentApiReminders.ts`; extend its integration spec.
- [ ] schedule: if `cadence` provided (and no explicit `in`/`at`), `fireAt = computeNextFireAt(cadence, now)`; validate cadence (400 on bad rule). update: same when cadence changes.
- [ ] fire endpoint: RECURRING (cadence != null) → instead of status=fired, set `fireAt = computeNextFireAt(cadence, now)`, `version++`, append `rescheduled` event, `writeReminderEvent('reminder.upserted', ...)` (so the cache re-arms). One-shot path unchanged.
- [ ] Tests: schedule with cadence → fireAt computed; fire a recurring → status stays scheduled + fireAt advanced + version bumped + upsert broadcast; one-shot still → fired.

### Task F3: ReminderCache recurring-overdue + acceptance
**Files:** Modify `src/orchestrator/reminderCache.ts` (recurring overdue: the cache just re-arms on the upsert it gets back after fire — but a snapshot with a past recurring fireAt should fire once then await the server's rescheduled upsert; ensure no double-fire via the (id,version) dedup); Modify `src/simulation/slice4_1RoundTrip.ts`.
- [ ] Cache: confirm recurring overdue fires ONCE (the (id,version) dedup + the server advancing version on fire prevents a re-fire of the same version; the re-armed timer uses the NEW version from the upsert). Unit test: a recurring job overdue → fires once; after the server's upsert (new version, future fireAt) → arms for the next.
- [ ] Acceptance: a recurring `--cadence every:1s` reminder fires ≥2× , each advancing nextFireAt + version (assert ≥2 `[reminder fired]` injects + ≥2 `⏰` system messages + the row's version advanced). Add to slice4_1RoundTrip (gated so the one-shot assertions still run).
- [ ] Run stub → exit 0; `npm test` + `npx tsc --noEmit`; MioServer cadence + routes tests green.

---

## Chunk G: prod migrate-deploy + dogfood (REQUIRES user authorization before touching prod)

### Task G1: full pre-deploy verification
- [ ] MioServer `npx tsc --noEmit` + `npm run test:integration -- sources/control/agentApi sources/control/reminders`; mio-agent `npm test` + `npx tsc --noEmit` + all 5 round-trips (slice1/2/3/3.2/4.1) green.

### Task G2: prod migration + deploy (106.54.19.137 — authorize first)
- [ ] **Predeploy backups (both):** code tar `tar czf /var/www/mioserver-code-predeploy-<ts>.tar.gz -C /var/www/mioserver sources prisma` AND `pg_dump "$DATABASE_URL" > /var/www/mioserver-predeploy-<ts>.sql`.
- [ ] Read-only preflight: confirm prod healthy (/health 200), the new migration NOT yet applied (`prisma migrate status`), reminder tables absent.
- [ ] rsync `sources/` (exclude *.spec.ts) + `prisma/schema.prisma` + the new `prisma/migrations/<ts>_s4_reminders/` dir.
- [ ] `cd /var/www/mioserver && set -a && . ./.env && set +a && npx prisma migrate deploy` (confirm ONE new migration applied, not a reset) + `npx prisma generate`.
- [ ] `pm2 restart mioserver`; smoke: /health 200, `/internal/agent-api/reminders/list` 401 (mounted), existing routes (tasks/channels/history) 401 no-regression, public mio.wdao.chat/health 200, pm2 logs clean.
- [ ] Verify reminder tables + the migration row in `_prisma_migrations`.
- [ ] **Live dogfood:** mint op/use the dogfood agent's machine token (note: agent-api needs machine token + X-Mio-Agent-Id — same limitation as slice 2/3.1; if no machine-token mint, dogfood via a tsx-run daemon or document the boundary). Schedule a short reminder, confirm it fires + the observable system message; self-clean.
- [ ] (no git).

---

## Reuse map
| Need | Reuse |
|---|---|
| observable fire system message | `insertSystemMessage` (slice 2) → then `writeEventAndBroadcast` |
| seq'd + catch-up-replayable WS events | `publishControlEvent` + `workroomBroadcaster` (NEW `writeReminderEventAndBroadcast`, mirroring `writeEventAndBroadcast`) |
| agent-api route + auth + register | `agentApiTasks` + `authorizeAgentApi` + `sources/api.ts` |
| schedule channel anchor | `resolveAgentChannelTarget(channel, agent.id)` |
| list author-anchor | `where:{agentId:auth.agent.id}` (agentApiChannels memberId pattern) |
| author wake | `claudeStreamHost.enqueueUserTurn` |
| daemon WS event routing (additive) | inboxDelivery handler / gateway subscription (slice 1/3.1) |
| per-agent cache in spine | `createInboxCoordinator` wiring in `startAgentSpine` (slice 1) → parallel `createReminderCache` |
| proxy action + cap + CLI + prompt | `task` action + cliTransport + agentcli + systemPrompt (slice 2/3.2) |
| acceptance harness | slice3_2RoundTrip + mioServerSetup + zero-footprint workDirs |
| migration (2 registrations, 1 DDL) | s2_task_number migration.sql + its CONTROL_PLANE_MIGRATIONS entry |
| prod deploy discipline | slice 2 `prisma migrate deploy` + predeploy backups |
