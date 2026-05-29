# Slock Clone — Slice 4.1: Reminders (self-wake subsystem) — Design

**Date:** 2026-05-25
**Status:** Design (approved by user — server-side faithful + full scope incl. recurrence; pending spec review)
**Repos:** `MioServer` (schema + agent-api + fire-recording + WS broadcast) AND `mio-agent` (ReminderCache + sync + onFire + proxy + CLI + prompt). Schema-touching → migration + prod deploy.
**Builds on:** Slices 1–3.2 (multi-agent spine, tasks, PM orchestration — shipped). Reuses: `insertSystemMessage` (slice 2, member-gate-bypassing system message), `writeEventAndBroadcast` + `workroomBroadcaster` (WS), `authorizeAgentApi` + agent-api route shape, `claudeStreamHost.enqueueUserTurn` (gated injection), inboxDelivery WS subscription, agentProxy action dispatch, agentcli, systemPrompt, slice3RoundTrip harness.

---

## 1. Context & source-grounded model

Slices 1–3.2 made agents **reactive** (woken only by messages). Reminders add **proactive self-wake**: an agent schedules a future wake ("follow up in 1h", "check the deploy tomorrow 9am"), and the system wakes it at that time.

**Verified against the real Slock daemon source** (`@slock-ai/daemon@0.52.2`): a reminder is "an author-owned, persistent, observable, snoozable, updatable, cancelable wake-up signal anchored to a Slock message or thread; when it fires, it wakes the author who scheduled it, not other people. If anchored to a message or thread, the receipt/fire system message is visible in that surface, but wake ownership does not transfer." The architecture is a **hybrid**:
- **Server = source of truth**: REST `/reminders` endpoints; persistent; versioned (`reminder.version`); observable (fire writes a system message in the anchored surface).
- **Daemon = `ReminderCache`**: the server broadcasts reminder changes over WS (`snapshot(agentId, reminders)` / `upsert(reminder)` / `cancel(reminderId, version)`); the cache holds local fire-timer jobs keyed on `fireAt` and fires them locally (`onFire(job)` → `onReminderFire`) because only the daemon can wake its agent's claude session.
- **Recurrence**: real Slock supports `--cadence/--repeat <rule>` (`every:15m | every:2h | every:1d | daily@HH:MM | weekly:<day>@HH:MM`) with `nextFireAt` rescheduling.

**Why server-side (not daemon-local) — confirmed by the user's needs:** multi-device access (phone/computer/other phones must see + manage reminders) REQUIRES server persistence; long-context tasks need durability across daemon restart / machine change / context compression. Performance is not a counter-argument: scheduling is a rare non-latency-sensitive CRUD round-trip, and the latency-sensitive FIRE is local in this design either way (daemon cache fires without a network hop).

---

## 2. Goal

An agent uses `mio reminder schedule/list/snooze/update/cancel/log` (incl. recurring cadences, anchored to a message/thread or the channel) → the server persists + broadcasts → the daemon's ReminderCache fires locally at the time → wakes the author's session AND records an observable system message in the anchored surface. Survives restart, visible on every device.

---

## 3. Components

### 3.1 MioServer — schema (migration)
- **`ControlReminder`**: `id` (uuid), `workroomId`, `agentId` (author/owner FK → ControlAgent), `channelId` (anchor surface), `anchorMessageId?` / `anchorThreadId?` (nullable — anchor to a specific message/thread; null → channel-anchored), `title` (the note text), `fireAt` (DateTime — next fire time), `cadence?` (nullable string rule, e.g. `every:15m`; null → one-shot), `status` (`scheduled` | `fired` | `canceled`), `version` (Int, optimistic concurrency, starts 1), `snoozedUntil?`, `createdAt`, `updatedAt`. Index `(agentId, status)` + `(workroomId)`.
- **`ControlReminderEvent`** (for `log`): `id`, `reminderId` (FK), `kind` (`scheduled`|`fired`|`snoozed`|`updated`|`canceled`|`rescheduled`), `at`, `detail?` (jsonb — e.g. nextFireAt). Append-only.

### 3.2 MioServer — agent-api `/internal/agent-api/reminders/*` (all behind `authorizeAgentApi`)
- `POST /reminders/schedule` `{title, in?|at?|cadence?, channel, message_id?}` → resolve the anchor surface via `resolveAgentChannelTarget(channel, auth.agent.id)` (same helper agentApiTasks uses — gives `channelId` + `workroomId` + membership check); create ControlReminder with `agentId = auth.agent.id` (author), the resolved `channelId`/`workroomId`, `anchorMessageId = message_id?`; compute initial `fireAt` from `in`/`at`/cadence; version=1; status=scheduled) + a `scheduled` event + **emit `reminder.upserted`** (publishControlEvent+broadcast, §3.3) → returns the reminder. (So schedule uses BOTH the channel-resolve path AND author-anchoring; `list` below is pure author-anchored.)
- `GET /reminders/list?status=&channel=?` → the author's reminders only (`where: { agentId: auth.agent.id }` — agentId-anchored, mirroring agentApiChannels' memberId query).
- `POST /reminders/snooze` `{id, in|until, version}` → version-checked; push `fireAt`/`snoozedUntil`; bump version; `snoozed` event; broadcast upsert.
- `POST /reminders/update` `{id, title?, cadence?, in?|at?, version}` → version-checked; change meaning/schedule; bump version; `updated` event; broadcast upsert.
- `POST /reminders/cancel` `{id, version}` → version-checked; status=canceled; `canceled` event; **broadcast `reminder.canceled`**.
- `GET /reminders/log?id=` → the ControlReminderEvent stream for a reminder.
- `POST /reminders/fire` `{id, version}` (called by the DAEMON when its cache fires) → version-checked; write the **observable system message** in the anchored surface via `insertSystemMessage` (e.g. `⏰ Reminder fired: <title>`) + `fired` event; then: one-shot → status=fired; recurring → compute `nextFireAt` from `cadence`, set `fireAt=nextFireAt`, bump version, `rescheduled` event, **broadcast upsert** (so the cache re-arms). Idempotent on version (a duplicate fire for an already-advanced version → no-op).

### 3.3 MioServer — WS reminder broadcast
On any reminder change, emit a reminder event carrying `{agentId, reminder|reminderId, version}` **via `publishControlEvent` THEN `workroomBroadcaster.broadcast` (the `writeEventAndBroadcast` pattern — NOT a raw broadcast)**. WHY: `publishControlEvent` writes the event to the events table with a seq, so the daemon's reconnect **catch-up replay** (`apiGetEventsCatchUp` → `dispatchCatchUpEvents`) replays reminder events that occurred during a WS gap. A raw `workroomBroadcaster.broadcast` alone gets no seq + is not in the events table → the cache silently desyncs after any disconnect. Topics (we own both sides): `reminder.upserted`, `reminder.canceled`. The daemon routes these (by `event.topic`, additive to the existing message.created/channel.member_* handlers) to the ReminderCache. On boot / WS (re)connect the daemon requests a `reminder.snapshot` `{agentId, reminders[]}` for a full resync (also the safety net for the `seq_expired` catch-up case the daemon logs).

### 3.4 mio-agent — `ReminderCache` (per agent, in startAgentSpine)
- API: `upsert(reminder)`, `cancel(reminderId, version)`, `snapshot(agentId, reminders[])`, `clear()`. Holds a `Map<reminderId, job>` with a local `setTimeout` per job keyed on `fireAt` (injectable clock for tests; `unref()` timers).
- **onFire(job)** (the wake): (1) `host.enqueueUserTurn("[reminder fired] <title>")` — inject the actionable wake into the AUTHOR's session (author-only, local, no network); (2) POST `/internal/agent-api/reminders/fire {id, version}` → server writes the observable system message + advances status/nextFireAt + re-broadcasts (recurring → cache gets the upsert and re-arms).
- **Sync:** wired into the daemon's WS subscription — `reminder.upserted`/`canceled`/`snapshot` events update the cache (additive topic routing alongside message.created). On boot / WS (re)connect → request/receive a snapshot per hosted agent → rebuild the job set. **Overdue on restart:** a one-shot job whose `fireAt` is already past → fire immediately (don't lose it); a RECURRING overdue job → fire ONCE then reschedule from now via `computeNextFireAt(cadence, now)` (skip the missed backlog — no thundering catch-up).
- **Versioning:** `upsert` carries `version`; the cache ignores an upsert whose `version` is OLDER than what it holds (avoids races with in-flight fires). `cancel` is TERMINAL: it removes the job by `reminderId` regardless of version (a stale-but-equal or any cancel wins — a later upsert for a canceled reminder shouldn't exist).
- **Local wake dedup (idempotent onFire):** before calling `enqueueUserTurn`, mark `(reminderId, version)` as wake-fired; refuse to re-inject for the same `(id, version)`. WHY: the local wake (step 1) precedes the server fire-report (step 2); a failed report + retry, or a snapshot re-arming a just-fired timer, must re-POST `/fire` (for the record) WITHOUT re-waking the author. The server's fire endpoint is idempotent-on-version (protects the observable message/status); this dedup makes the LOCAL wake idempotent too.

### 3.5 mio-agent — proxy + CLI + prompt
- `agentProxy` `reminder` action (capability `reminders`) → forwards to `/internal/agent-api/reminders/<op>` (like `task`): op ∈ schedule/list/snooze/update/cancel/log. (The `fire` endpoint is daemon-internal, NOT a CLI op.)
- `mio reminder` CLI: `schedule --title "<t>" (--in <dur> | --at <ISO> | --cadence <rule>) [--channel #x] [--message-id <id>]`, `list [--channel]`, `snooze <id> (--in <dur>|--until <ISO>)`, `update <id> [--title][--cadence][--in/--at]`, `cancel <id>`, `log <id>`. Canonical text out / stderr-JSON on error (house convention). Version is fetched-then-sent by the CLI for snooze/update/cancel (read current version from list, or the server returns it) — OR the CLI passes through and the server returns a version-conflict the CLI surfaces.
- `cliTransport` capabilities → add `reminders` (so `send,read,tasks,reminders`).
- `systemPrompt` "## Reminders" section: when to use (follow-up that depends on future state; self-driven check-backs; "to notify someone later, schedule a reminder and @mention them when it fires"), the 6 commands, cadence rules, that a fired reminder wakes only you + is observable in the surface, and to prefer snooze/update over re-creating.

### 3.6 Recurrence (cadence)
A `cadence` rule parser (server-side, used by schedule/update/fire-reschedule): `every:<dur>` (e.g. `every:15m`, `every:2h`, `every:1d`), `daily@HH:MM`, `weekly:<dow>@HH:MM`. `computeNextFireAt(cadence, from)` → the next DateTime. One-shot reminders have `cadence=null` → status=fired after firing; recurring → fireAt advances to nextFireAt + stays scheduled.

**Pinned edges (else the parser is non-deterministic / untestable):**
- **Timezone = UTC.** `daily@HH:MM` / `weekly:<dow>@HH:MM` are interpreted in UTC (deterministic across test DB / prod TZ). (A per-agent TZ is a future extension, out of scope.)
- **`<dow>` grammar:** lowercase 3-letter `mon|tue|wed|thu|fri|sat|sun`.
- **Recurring overdue (daemon was down across ≥1 periods):** fire ONCE, then `computeNextFireAt(cadence, now)` to skip the backlog — never fire N times to catch up.
- **`every:<dur>` durations:** `<int><unit>` where unit ∈ `m|h|d` (minutes/hours/days); positive only.

**Plan sequencing:** the one-shot core (schedule/list/snooze/update/cancel/log/fire + cache arm/fire/sync/overdue + version + dedup + observable message) is the coherent MVP and is independently shippable + dogfoodable — the PLAN should land it FIRST (and do the live dogfood) and sequence recurrence (cadence parser + reschedule-on-fire + recurring-overdue-skip) as the LAST chunk, so the cadence complexity lands on a proven core. (Single spec, multi-chunk plan.)

---

## 4. Data flow (fire)

```
mio reminder schedule --title "check deploy" --in 1h --channel #ops
  → proxy reminder(schedule) → agent-api → ControlReminder{fireAt=now+1h,v1,scheduled}
     + scheduled event + WS reminder.upserted → daemon ReminderCache.upsert (arms timer)
  ... 1h later, in the daemon (no network for the wake itself) ...
  ReminderCache job fires → onFire:
     (1) host.enqueueUserTurn("[reminder fired] check deploy")   ← AUTHOR woken (local)
     (2) POST /reminders/fire {id, v1}
          → server: insertSystemMessage(#ops, "⏰ Reminder fired: check deploy")  ← observable
            + fired event + (one-shot: status=fired | recurring: fireAt=next, v2, upsert broadcast)
          → WS message.created (system) delivered to #ops members via inboxDelivery (they skip type=system)
```
Multi-device: any device `GET /reminders/list` sees the reminder; the fire's system message is in the channel history on every device.

---

## 5. Error handling
- Version conflict (snooze/update/cancel/fire with stale version) → 409 REMINDER_VERSION_CONFLICT; the CLI re-reads + retries or surfaces. The fire endpoint is idempotent on version (duplicate fire → no-op).
- Daemon down at fire time → reminder fires when the daemon next boots + syncs (overdue-fire). Server does NOT independently write the fire system message (the daemon is the firer) — so a long-down daemon delays the observable fire; acceptable (the agent can't be woken while its daemon is down anyway). [Alternative considered: a server-side backstop scheduler — deferred; adds a second firing authority + dedup complexity.]
- Anchor message/thread deleted → fire falls back to channel-anchored system message.
- ReminderCache fire failing to reach the server (offline) → retry with backoff; the local wake already happened (author was woken); the observable record catches up on reconnect.

## 6. Testing
- **MioServer unit/integration:** reminders routes (schedule/list/snooze/update/cancel/log/fire) — version conflicts, agentId-anchoring (an agent only sees its own), the fire endpoint writes the system message + advances one-shot vs recurring (nextFireAt), the cadence parser (`computeNextFireAt` for every:/daily@/weekly:). WS broadcast emitted on change.
- **mio-agent unit:** ReminderCache (upsert arms a timer, onFire fires at fireAt via injected clock, cancel removes, snapshot rebuilds, overdue fires immediately, stale-version ignored); proxy reminder action routes to the right endpoint; CLI subcommands send the right payloads + render canonical output; systemPrompt has the Reminders section + capability.
- **Acceptance `slice4_1RoundTrip.ts`** (model on slice3): an agent schedules `--in <~1s>` → server persists + WS-syncs to cache → cache fires → asserts (HARD, real path): (a) the author's host received `[reminder fired]` (onInjected recorder); (b) the observable system message exists in the surface; (c) the reminder row advanced (one-shot→fired). PLUS a recurring `--cadence every:1s` fires ≥2× advancing nextFireAt; list/snooze/cancel; a version-conflict; restart-overdue (reload + immediate fire). Stub hard gate + real-claude best-effort on the agent's reaction.
- **Regression:** slice1/2/3/3.2 runners + npm test + tsc (both repos).

## 7. Deploy
Schema-touching (2nd after slice 2). **TWO migration artifacts with the SAME DDL** (slice-2 discipline): (1) a prod prisma migration `prisma/migrations/<ts>_s4_reminders/` (ControlReminder + ControlReminderEvent); (2) the matching hand-curated SQL appended to the `CONTROL_PLANE_MIGRATIONS` array in `scripts/setup-test-db.sh` (the test DB is built by this script's curated SQL, NOT `prisma migrate`, due to native-uuid-vs-text column typing — integration specs depend on it). NEVER `prisma migrate dev`.
- Prod: predeploy code tar + `pg_dump` → rsync sources + the new migration dir → `prisma migrate deploy` (reports the one new migration) + `prisma generate` → pm2 restart → smoke (/reminders/list 401 = mounted, /health 200, existing routes no regression, clean startup). Live dogfood: schedule a short reminder, confirm it fires + the observable system message. (mio-agent side reaches real devices only via the still-pending npm/SEA publish — same standing boundary; the server side + a tsx-run daemon can be dogfooded.)

## 8. Out of scope (explicit)
- Server-side backstop scheduler (daemon is the firer; server records). [noted alternative in §5]
- 4.2 action-prepare cards / 4.3 profile/react/attachments.
- Reminder UI on iOS (Slice 5).
- Cross-agent reminder delegation beyond "@mention them in the note when it fires" (the source's own pattern — handled by the agent writing an @mention on wake, not a system feature).

## 9. Reuse map
| Need | Reuse |
|---|---|
| observable fire system message (member-gate bypass) | `insertSystemMessage` (slice 2) |
| WS broadcast | `workroomBroadcaster` / `writeEventAndBroadcast` (slice 1/2) |
| agent-api route + auth | `agentApiTasks` shape + `authorizeAgentApi` |
| agentId-anchored query (list) | `agentApiChannels` (slice 3.1) `controlChannelMember`-style memberId anchoring → here `where:{agentId:auth.agent.id}` |
| channel-anchor resolve + membership (schedule) | `resolveAgentChannelTarget(channel, agent.id)` (slice 1/2, used by agentApiTasks) → gives channelId+workroomId for the fire surface |
| seq'd + catch-up-replayable WS events | `publishControlEvent` + `workroomBroadcaster` (the `writeEventAndBroadcast` pattern) — NOT raw broadcast |
| author wake injection | `claudeStreamHost.enqueueUserTurn` (slice 1) |
| daemon WS event routing | inboxDelivery's gateway subscription (slice 1/3.1) — add reminder.* routing to ReminderCache |
| proxy action + capability + CLI + prompt threading | `task` action (slice 2) + cliTransport capabilities + agentcli + systemPrompt sections |
| acceptance harness + recorders + zero-footprint cleanup | slice3RoundTrip / slice3_2RoundTrip |
| migration + prod deploy discipline | slice 2's `prisma migrate deploy` + predeploy backups |
