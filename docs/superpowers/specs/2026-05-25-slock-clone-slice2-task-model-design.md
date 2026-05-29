# Slock Clone — Slice 2: Task Model (hybrid) — Design Spec

- Date: 2026-05-25
- Status: design (pre-plan)
- Parent: option A "faithful Slock clone", sub-project 2 of 5. Builds on Slice 1 (real agentic session round-trip, deployed to prod + proven).
- Source-of-truth for the model: `CodeLight/docs/productization/slock-orchestration-model-2026-05-24.md` §4 (task model).
- Repos: `MioServer` (agent-api tasks + task→message bridge), `mio-agent` (mio task CLI + system prompt + the 2 deferred slice-1 fixes). NOT CodeLight (iOS task board is later).

## 1. Goal
Give agents a working task surface: an agent can create, claim (claim-before-work), and advance tasks through `todo→in_progress→in_review→done` via the `mio task` CLI, and **learns about tasks through the message flow** (the slice-1 inbound path) because task lifecycle events are mirrored into the channel as messages.

## 2. Architecture decision (user-approved): HYBRID
MioServer already has a **separate `ControlTask` table** (from prior S3 work) with `slockTaskRoutes.ts` (iOS-facing) + `taskRoutes.ts` (incl. a **CAS claim** — the claim-before-work concurrency primitive) + `slockTaskStatus.ts` (status-vocab translation). The real Slock model is "task = a message with task metadata." We RECONCILE via a hybrid, NOT a rewrite:
- **Keep `ControlTask` as the task entity** (reuse the table, the CAS claim/unclaim, the iOS routes, the status vocab). It stays the source of truth.
- **Bridge task lifecycle to messages:** on task create / status-change (via ANY path — agent or iOS), additionally emit a message into the channel via the slice-1 shared `writeEventAndBroadcast` helper, so it flows through `message.created` → the agent's slice-1 InboxCoordinator. This gives the agent the Slock chat-flow experience without making `ControlTask` literally a message.
- **Add the agent-facing surface:** `mio task …` CLI → agent-proxy (`tasks` capability) → MioServer `/internal/agent-api/tasks/*` operating on `ControlTask`.

This means the agent perceives tasks via messages (faithful to Slock's message-driven model) while the storage stays the proven `ControlTask` table.

## 3. Success criteria (acceptance)
Extending the slice-1 acceptance runner: a human posts "@Agent please create a task to do X and start it". Within the agent's turn:
1. The agent runs `mio task create` → a `ControlTask` row is created AND a `📋 ... new task created: #N ...` message appears in the channel (visible to the human + re-deliverable to agents via `message.created`).
2. The agent runs `mio task claim #N` → the CAS claim sets owner=agent, status=in_progress; a status-change message appears.
3. The agent runs `mio task update #N --status in_review` → status advances; a status-change message appears.
4. `mio task list` returns the channel's task board (the agent can read it).
5. A second concurrent claim of the same task fails (CAS) → the agent's CLI reports the conflict and the agent moves on (claim-before-work discipline).
Measured by a new `mio-agent/src/simulation/slice2RoundTrip.ts` runner that REUSES the slice-1 harness (`simServerBoot.ts` + the extended `mioServerSetup.ts` + `stubStreamRuntime.ts` pattern; the stub gains task-command behavior) — stub + real-claude variants asserting the ControlTask rows + the bridge messages + the CAS-conflict path. The mioServerSetup must additionally register the task routes + seed the `number` column.

## 4. Units (boundaries + interfaces)

### 4.1 agentApiTasks — `MioServer/sources/control/agentApi/agentApiTasks.ts`
The agent-facing task endpoints, registered into `agentApiRoutes`. All authed via slice-1 `authorizeAgentApi` (machine token + X-Mio-Agent-Id → real ControlAgent owned by the machine). Channel resolution reuses slice-1 `resolveAgentChannelTarget` (membership-anchored `#name`).
- `GET /internal/agent-api/tasks/list?channel=#name[&status=…]` → the channel's tasks (reuse `slockTaskRoutes`/`taskRoutes` formatting; return `{tasks:[{number, id, title, status, assignee_id, …}]}`).
- `POST /internal/agent-api/tasks/create` `{channel, title}` (batch titles allowed: `titles:[…]`) → creates ControlTask row(s) (status `todo`, no auto-claim — faithful to Slock `task create`), assigns a per-channel **task number** (see §4.4), emits the `📋 N new tasks created: #N …` bridge message, returns `{tasks:[{number,id}]}`.
- `POST /internal/agent-api/tasks/claim` `{channel, number}` (or `{number}`) → reuse the CAS **predicate** (NOT the existing HTTP route — that route uses a different auth `verifyMachineToken`+`agent_instance_id`+task-uuid, incompatible with the agent flow's `authorizeAgentApi`+`X-Mio-Agent-Id`+`#number`). Extract the atomic predicate into a shared helper `claimControlTaskCas(taskId, agentId)` called by BOTH the existing route and `agentApiTasks` (one home for the invariant). The FULL CAS predicate (the `ownerInstanceId IS NULL` clause is the entire concurrency guard — do NOT drop it): `updateMany({ where: { id: taskId, ownerInstanceId: null, status: { notIn: ['done','canceled'] } }, data: { ownerInstanceId: agentId, status: 'in_progress' } })`; `count===0` → conflict. **Self-claim is idempotent**: if the task is already owned by THIS agent, return success (not 409); only a claim of a task owned by ANOTHER agent → 409 `TASK_CLAIM_CONFLICT` (the route does a follow-up read after count===0: if ownerInstanceId===agentId → ok, else 409). Emits a status-change bridge message. (claim-before-work: agent must claim before working.)
- `POST /internal/agent-api/tasks/unclaim` `{channel, number}` → release (reuse the taskRoutes unclaim predicate, scoped to ownerInstanceId===agentId so an agent can only unclaim its own).
- `POST /internal/agent-api/tasks/update-status` `{channel, number, status}` → status ∈ `in_progress|in_review|done`. **Transition validation is NEW logic** (`slockTaskStatus.ts` is only a vocab TRANSLATOR — UPPERCASE↔lowercase — it does NOT validate ordering; keep it as the translator and ADD a validator). Legal transitions: `todo→in_progress` (also via claim), `in_progress→in_review`, `in_review→done` (and `in_review→in_progress` to send back; `in_progress→done` allowed). Illegal/terminal (`done`,`canceled`) → 400 `INVALID_TASK_TRANSITION`. The server-only `waiting_approval` status is NOT in the agent transition set (agents don't drive it). Emits a status-change bridge message.
- Errors: structured `{error:{code,message}}`. Not-a-member → 404; not-owned agent → 403; bad status → 400; claim conflict → 409.

### 4.2 taskMessageBridge — `MioServer/sources/control/tasks/taskMessageBridge.ts`
The hybrid bridge. One function `emitTaskLifecycleMessage({workroomId, channelId, kind:'created'|'status', tasks|task, actorId})` that composes the canonical Slock text (`📋 1 new task created: #N "title"` / `📋 N new tasks created: #12 …` / a status-change line) and posts it as a **system message** that broadcasts as `message.created`.
- **senderId/senderKind:** `ControlMessage.senderId` is non-nullable and `sendMessageTransaction` applies a membership guard keyed on senderId for non-public channels — a system sender is not a channel member, so it would hit `CHANNEL_FORBIDDEN`. THEREFORE the bridge does NOT go through `sendMessageTransaction`'s member-gated path. It writes the message with `senderKind:'system'`, `senderId:'system'` (a fixed sentinel) directly (system messages are server-originated and bypass the member gate), assigns the per-channel seq via `nextChannelSeq`, then calls `writeEventAndBroadcast` so it broadcasts as `message.created`. (Confirm in the plan whether to add a `system` bypass to `sendMessageTransaction` or write via a small dedicated `insertSystemMessage` helper — prefer the latter to avoid weakening the member gate for real sends.)
- **Channel required:** the bridge only fires when there is a `channelId`. `slockTaskRoutes` create sets `channelId` (good). But `taskRoutes` create (`POST /workrooms/:wid/tasks`) makes a **workroom-level task with `channelId=null`** — those have no channel to emit into, so the bridge is SKIPPED for null-channel tasks (and such tasks are outside the agent task flow, which always creates channel-scoped tasks). So "iOS-created tasks surface to agents" holds for channel-scoped tasks (`slockTaskRoutes`) only; workroom-level `taskRoutes` tasks do not bridge (documented limitation).
- Called by the agent-api task endpoints AND the channel-scoped `slockTaskRoutes` write path. Keep the existing `task.created`/`task.updated` events intact (iOS still uses them); the bridge ADDS the `message.created`.
- Decision: the bridge message is a `system`-kind message (type=system in the slice-1 header render), so agents treat it per the "don't reply to system messages unless they request action (e.g. a task assigned to you)" rule already in the system prompt.

### 4.3 mio task CLI — `mio-agent/src/agentcli/` (extend the slice-1 dispatcher)
Add `mio task list|create|claim|unclaim|update` to the `agentcli` command (slice-1 `runAgentCli`), → agent-proxy action `task` (payloads per subcommand) → `/internal/agent-api/tasks/*`. Reuse slice-1's env-resolution + canonical-output/stderr-JSON contract. The agentProxy (slice-1 `agentProxy.ts`) adds the `tasks` capability + maps task actions to the routes (all under the `tasks` capability flag).

### 4.4 Per-channel task number — schema + `nextChannelTaskNumber`
Real Slock shows `task #N` (a small per-channel integer) and `[task #N status=…]`. `ControlTask` currently has only a uuid `id` (no number). Add a **nullable** `number Int?` column to `ControlTask` (per-channel ordinal) + a `nextChannelTaskNumber(channelId)` helper (FOR UPDATE, mirroring the existing `nextChannelSeq` pattern) assigned at create **for channel-scoped tasks only**. Workroom-level tasks (`channelId=null`, from `taskRoutes` create) get `number=null` (they are outside the agent task flow). The unique key is `(channelId, number)` for non-null channel tasks. **This is a Prisma SCHEMA change → a migration** (slice 2 is the first slice to touch the schema; see §7 — prod deploy needs `prisma migrate deploy`). The `mio task claim/update` reference tasks by `#number` resolved to the ControlTask within the resolved channel (404 `TASK_NOT_FOUND` if no channel task with that number).

### 4.5 systemPrompt task section — `mio-agent/src/runtimes/systemPrompt.ts`
Add the task section that slice 1 deliberately omitted: the `mio task list/create/claim/unclaim/update` commands; the status flow `todo→in_progress→in_review→done`; the **claim-before-work discipline** ("if a message asks you to DO something, claim it before starting; if the claim fails, move on"); assignee independent of status; `[task #N status=]` reading; "only top-level messages become tasks." Capabilities env in the wrapper gains `tasks`.

## 5. Deferred slice-1 fixes folded into slice 2
### 5.1 claude isolation from host global config (the slice-1 dogfood blocker)
**DESIGN PRINCIPLE (user-confirmed):** the agent uses the user's **already-logged-in local claude/codex** — NO separate login, NO API key. This matches real Slock (it probes which runtime is available + uses the local login). Our daemon already does this: in the slice-1 dogfood the spawned claude authed via the user's local OAuth (it captured a session id) with NO API key — login was never the problem.

The spawned agent claude loaded the host's global `~/.claude/CLAUDE.md` + plugins (DevForge) → behaved as the dev's assistant, not the Mio agent. The ONLY problem is that pollution — NOT auth. So the fix must **preserve the local login while removing the CLAUDE.md/plugins pollution** (the `ANTHROPIC_API_KEY` option is REJECTED — it violates the no-separate-login principle).

**RESOLVED MECHANISM (verified empirically 2026-05-25):** Do NOT override `CLAUDE_CONFIG_DIR` (login is bound to the default `~/.claude` config dir — ANY override, even a copied-minus-CLAUDE.md/plugins dir, reports "Not logged in"; verified). Instead, add **`--setting-sources project,local`** to the claude launch args (claudeStreamHost). This excludes the "user" global setting source (which enables the global `~/.claude/CLAUDE.md`/memory + plugins like DevForge + hooks) while keeping the default config dir → **local OAuth/keychain login stays intact, zero pollution.** Verified: default config dir + `--setting-sources project,local` + `--strict-mcp-config` → claude replied "pong" (`is_error:false`), 0 devforge/codeisland mentions, 0 exploration tool calls. The agent's Mio context is still provided explicitly via `--append-system-prompt-file` (not a setting source) + `--mcp-config`; the workspace cwd is clean (no project CLAUDE.md). NO API key, NO config-dir override. The claudeStreamHost change is a one-flag addition to `buildClaudeArgs` (and the SEA build/tests update for the new flag).

### 5.1b runtime detection (claude / codex availability) — the Slock model
Real Slock probes which runtime is available (`probeClaude` / probe-codex) and uses the local logged-in CLI. mio-agent already has `runtimes/claudeRuntime.ts` + `runtimes/codexRuntime.ts` + claude probing. Slice 2 wires runtime SELECTION into the spine: the daemon detects which runtime is available + the agent's configured `runtime` (the ControlAgent.runtime field already exists from S2), and the claudeStreamHost is selected accordingly. For slice 2 the spine remains claude-first (codex stream-json host is a later increment), but the DETECTION + selection seam is added so codex can plug in without re-architecting. (The agent's runtime/model already come from the server member record per slice-1's bootAgentSpine fix.)
### 5.2 detectExecContext tsx-source mode — `mio-agent/src/proxy/cliTransport.ts`
`detectExecContext` currently emits a `node <…/src/cli/index.ts>` wrapper when the daemon runs from `.ts` source via tsx (node can't run `.ts`). Add a `tsx-source` mode: when `argv1` ends with `.ts`, the wrapper must invoke tsx (resolve the tsx binary) not bare node. Production (SEA/dist) is unaffected. Add a unit test.

## 6. Data flow (agent creates + claims a task)
1. Human posts "@Agent create a task to do X and start it" → slice-1 inbound delivers it to claude.
2. claude runs `mio task create --channel #slockai --title "do X"` → CLI → proxy (tasks cap) → `POST /internal/agent-api/tasks/create` → ControlTask row (status todo, number N) + `emitTaskLifecycleMessage('created')` → `📋 1 new task created: #N "do X"` message broadcast.
3. claude runs `mio task claim #N` → CAS claim (owner=agent, in_progress) → status-change bridge message.
4. claude works, posts progress (slice-1 `mio message send`), then `mio task update #N --status in_review` → bridge message.
5. The human (and other agents via `message.created`) see the 📋 + status messages in the channel.

## 7. Migration + deploy (slice 2 touches the schema — unlike slice 1)
Adding `ControlTask.number` (nullable Int) is a Prisma schema change. Prod (`prisma migrate deploy`, migration chain at `/var/www/mioserver/prisma/migrations`) requires a NEW migration. The plan MUST: create the migration via the project's discipline (hand-curated SQL for the test DB via `scripts/setup-test-db.sh`'s CONTROL_PLANE_MIGRATIONS array + a real prisma migration for prod); **back-fill `number` ONLY for channel-scoped existing rows** (per-channel ordinal by `createdAt` partitioned by `channelId WHERE channelId IS NOT NULL`); workroom-level rows (`channelId=null`) keep `number=null`. Deploy with the predeploy backup pattern (code tar + DB sql dump, per slice-1's deploy). This is the first slice-2 prod-deploy difference from slice 1 (which was code-only). The unique index `(channelId, number)` must be partial (`WHERE channelId IS NOT NULL AND number IS NOT NULL`) so multiple null-number/null-channel rows don't collide.

## 8. Error handling
- CAS claim conflict → 409 TASK_CLAIM_CONFLICT → CLI prints it → agent moves on (claim-before-work).
- Invalid status transition → 400 INVALID_TASK_TRANSITION (validated via the NEW transition validator — NOT slockTaskStatus, which stays a vocab translator). Plan note: `insertSystemMessage` should return the `{id, seq, created_at, workroomId, channelId, senderKind, senderId, content}` shape `writeEventAndBroadcast` expects (pass straight through, no re-fetch); bridge is best-effort-after-commit with no retry wrapper (so non-idempotent insert is acceptable — confirm no double-emit).
- Bridge message emission failure must NOT corrupt the task write: the task write (ControlTask + task.* event) is the source of truth; the bridge message is best-effort-after-commit (log on failure; the task still exists, iOS still sees it via task.* — only the agent-flow message is missed, recoverable). Mirror slice-1's write-before-broadcast ordering for the bridge message itself.
- Not-a-member / not-owned / bad channel → reuse slice-1 agent-api error codes.

## 9. Testing
- Unit: agentApiTasks handlers (create/claim/unclaim/update, CAS conflict, status validation, auth) — integration spec (real DB, `.integration.spec.ts`, `npm run test:integration`). taskMessageBridge (composes the canonical 📋/status text + emits via writeEventAndBroadcast — assert the message row + event). nextChannelTaskNumber (FOR UPDATE, monotonic per channel; concurrency). mio task CLI (agentcli, mock proxy). agentProxy `tasks` capability gate. systemPrompt task section presence. cliTransport tsx-source wrapper. claude-isolation flag (`--setting-sources project,local` in buildArgs — verified mechanism; NO CLAUDE_CONFIG_DIR override).
- Integration acceptance: extend the slice-1 runner → `slice2RoundTrip.ts`: human asks → agent creates+claims+advances a task → assert ControlTask rows + bridge messages + CAS-conflict path. Stub + real-claude variants (real-claude needs the §5.1 isolation resolved).

## 10. OUT of slice 2 (later)
Task Board UX (Creator/Assignee filters, Board/List views — slice-1 §12, → a later slice / CodeLight iOS), `dm:@peer` + threads (still deferred from slice 1; task progress for slice 2 posts in the CHANNEL, not a task thread — task-thread support is a later increment), multi-agent PM orchestration (slice 3), reminders/action-prepare (slice 4), the pure "task IS literally a message" refactor (the hybrid keeps ControlTask), npm publish, CodeLight iOS task surfaces (slice 5).

## 11. Decisions resolved
- Task model: HYBRID (ControlTask reused + message bridge), user-approved.
- claim-before-work: reuse the CAS `updateMany` **predicate** (extract `claimControlTaskCas(taskId, agentId)` shared helper from `taskRoutes.ts` — NOT the HTTP route, whose auth differs), full WHERE incl `ownerInstanceId IS NULL`; self-claim idempotent, other-owner → 409.
- status-transition validation is NEW logic (separate from `slockTaskStatus.ts`, which stays a vocab translator). `waiting_approval` is server-only, out of the agent transition set.
- bridge message: `senderKind:'system'`, `senderId:'system'` sentinel, written via a dedicated `insertSystemMessage` path that bypasses the member gate (system messages are server-originated), NOT via member-gated `sendMessageTransaction`. Bridge fires only for channel-scoped tasks; workroom-level (null-channel) tasks don't bridge.
- `ControlTask.number` nullable; per-channel for channel tasks, null for workroom-level; partial unique `(channelId, number)`.
- Task reference: per-channel `#number` (new `ControlTask.number` column + `nextChannelTaskNumber`).
- Bridge message kind: `system` (so the existing "don't reply to system messages unless they request action" rule applies).
- Slice-2 touches the schema → needs a migration (first slice to do so); deploy with predeploy backup.
- OPEN (resolve in plan): claude-isolation auth approach (§5.1) — must not hardcode a secret.
