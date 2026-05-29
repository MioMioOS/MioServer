# Slock Clone Slice 2 — Task Model (hybrid) — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give agents a working task surface (`mio task list/create/claim/unclaim/update`, claim-before-work, `todo→in_progress→in_review→done`) where task lifecycle is mirrored into the channel as messages so agents perceive tasks via the slice-1 inbound path.

**Architecture:** HYBRID — keep MioServer's existing `ControlTask` table + reuse its CAS claim predicate; bridge task lifecycle to channel system-messages (`📋 …`); add the agent-facing surface (mio task CLI → agent-proxy `tasks` capability → `/internal/agent-api/tasks/*`). Reuse all slice-1 patterns. Also: resolve the slice-1 claude-isolation (one flag, verified) + the detectExecContext tsx fix + a runtime-detection seam.

**Tech Stack:** TypeScript, Fastify+Prisma+Postgres (MioServer), Node+vitest (mio-agent), the verified claude launch recipe + `--setting-sources project,local`.

**Spec:** `MioServer/docs/superpowers/specs/2026-05-25-slock-clone-slice2-task-model-design.md` (read it).

**Repos:** MioServer `/Users/ying/Documents/AI/MioServer`, mio-agent `/Users/ying/Documents/AI/mio-agent`. Not git-tracked → commit steps skipped.

**Verified groundwork (do NOT re-litigate):**
- claude isolation = add `--setting-sources project,local` to claudeStreamHost `buildArgs` (line ~185). VERIFIED: default config dir (login intact via keychain) + that flag → 0 pollution, claude replies, `is_error:false`. NO CLAUDE_CONFIG_DIR override, NO API key.
- MioServer reuse (spec-reviewer-verified): `taskRoutes.ts` has the CAS claim `updateMany({where:{id, ownerInstanceId:null, status:{notIn:['done','canceled']}}, data:{ownerInstanceId, status:'in_progress'}})`; `slockTaskStatus.ts` is a vocab translator ONLY (no transition ordering); `ControlTask` has `id, channelId(nullable), title, status, ownerInstanceId(assignee), threadId, createdAt` (NO `number`); `slockTaskRoutes` create is channel-scoped, `taskRoutes` create is workroom-level (channelId=null).
- mio-agent reuse: `runAgentCli(argv,streams)` dispatches on argv[0] (add `task`); `agentProxy` action∈{send,history,check}+capability map+route map (add `task` actions + `tasks` cap); `buildArgs` in claudeStreamHost.

---

## Chunk A: MioServer — agent-api tasks + CAS helper + transition validator + task→message bridge + ControlTask.number migration

### Task A1: Extract `claimControlTaskCas` shared helper
**Files:** Create `sources/control/tasks/claimControlTaskCas.ts`; Modify `sources/control/tasks/taskRoutes.ts` (use it); Test `sources/control/tasks/claimControlTaskCas.integration.spec.ts`.
- [ ] Step 1: Read `taskRoutes.ts` claim handler. Write failing integration test: `claimControlTaskCas(taskId, agentId)` → `{ok:true}` when unclaimed (sets ownerInstanceId=agentId, status=in_progress); `{ok:true, alreadyOwn:true}` when already owned by SAME agent (idempotent, via follow-up read after count===0); `{ok:false, code:'TASK_CLAIM_CONFLICT'}` when owned by ANOTHER; respects `status notIn done/canceled`. Two concurrent calls → exactly one wins (DB row lock).
- [ ] Step 2: Run fail — `cd MioServer && npm run test:integration -- sources/control/tasks/claimControlTaskCas.integration.spec.ts`.
- [ ] Step 3: Implement the helper = the exact CAS `updateMany` (full WHERE incl `ownerInstanceId:null`); on count===0 do a follow-up `findUnique` and return a DISCRIMINATED result so the existing route can keep its 4-way codes: `{ok:true}` | `{ok:true, alreadyOwn:true}` (post-read owner===agentId) | `{ok:false, reason:'not_found'}` (no row) | `{ok:false, reason:'terminal'}` (status in done/canceled) | `{ok:false, reason:'owned_by_other'}`. Refactor `taskRoutes.ts` claim to call the helper and MAP the reasons to its EXISTING HTTP codes (`not_found`→404 TASK_NOT_FOUND, `terminal`→409 TASK_TERMINAL, `owned_by_other`→409 TASK_ALREADY_CLAIMED) so behavior is identical and existing taskRoutes tests still pass. The agent-api claim (A5) maps `owned_by_other`→409 TASK_CLAIM_CONFLICT, `not_found`→404 TASK_NOT_FOUND, `alreadyOwn`→success.
- [ ] Step 4: Run pass + `npm run test:integration -- sources/control/tasks/taskRoutes` (no regression).
- [ ] Step 5: (no git).

### Task A2: `ControlTask.number` schema + migration + back-fill + `nextChannelTaskNumber`
**Files:** Modify `prisma/schema.prisma` (ControlTask); Create migration SQL + append to `scripts/setup-test-db.sh` CONTROL_PLANE_MIGRATIONS; Create `sources/control/tasks/nextChannelTaskNumber.ts`; Test it.
- [ ] Step 1: Read `prisma/schema.prisma` ControlTask + an existing migration + `scripts/setup-test-db.sh` (CONTROL_PLANE_MIGRATIONS array) + the existing `nextChannelSeq` helper (grep `nextChannelSeq`). Add `number Int?` to ControlTask + a partial unique index `@@unique([channelId, number])` (Prisma: model-level, but partial-where needs raw SQL in the migration — the migration adds `CREATE UNIQUE INDEX … ON control_tasks(channel_id, number) WHERE channel_id IS NOT NULL AND number IS NOT NULL`).
- [ ] Step 2: Write the migration SQL: `ALTER TABLE control_tasks ADD COLUMN number integer;` + the partial unique index + **back-fill** channel-scoped rows: `WITH n AS (SELECT id, row_number() OVER (PARTITION BY channel_id ORDER BY created_at) rn FROM control_tasks WHERE channel_id IS NOT NULL) UPDATE control_tasks t SET number=n.rn FROM n WHERE t.id=n.id;` (null-channel rows keep number=null). Append the migration to `setup-test-db.sh` CONTROL_PLANE_MIGRATIONS (hand-curated, per project discipline — NEVER `prisma migrate dev`). Also create the real prisma migration dir for prod (`prisma/migrations/<ts>_s_task_number/migration.sql` with the same SQL).
- [ ] Step 3: `nextChannelTaskNumber(channelId)`: `SELECT COALESCE(MAX(number),0)+1 FROM control_tasks WHERE channel_id=$1 FOR UPDATE` (inside a transaction; mirror `nextChannelSeq`'s FOR UPDATE pattern). Test: monotonic per channel; concurrent creates get distinct numbers.
- [ ] Step 4: Run `npm run test:db:setup` (rebuild test DB with the new migration) + the nextChannelTaskNumber test + `npx prisma generate` (so the client has `number`). Verify no regression.
- [ ] Step 5: (no git).

### Task A3: `insertSystemMessage` + `taskMessageBridge`
**Files:** Create `sources/control/messages/insertSystemMessage.ts`; Create `sources/control/tasks/taskMessageBridge.ts`; Test both (integration).
- [ ] Step 1: Read `sendMessageTransaction.ts` (its result shape + the member gate) + `writeEventAndBroadcast.ts` (expected `{id,seq,created_at,workroomId,channelId,senderKind,senderId,content}`) + `nextChannelSeq`. Write failing test: `insertSystemMessage({workroomId, channelId, content})` inserts a ControlMessage with `senderKind:'system'`, `senderId:'system'`, seq via nextChannelSeq, **bypassing the member gate** (works on a PRIVATE channel where 'system' is not a member — assert it succeeds where a member-gated send would 403), returns the writeEventAndBroadcast shape. `taskMessageBridge.emitTaskLifecycleMessage({workroomId, channelId, kind, tasks|task})` composes the canonical text (`📋 1 new task created: #N "title"` / `📋 N new tasks created: #a,#b…` / `status change: task #N → in_review`) and calls insertSystemMessage + writeEventAndBroadcast → a `message.created` broadcast.
- [ ] Step 2: Run fail (integration).
- [ ] Step 3: Implement. insertSystemMessage writes the row directly (or a sendMessageTransaction variant with a system bypass — prefer the dedicated insert to avoid weakening the member gate; reuse the redact + event-write of writeEventAndBroadcast). taskMessageBridge composes text + calls it. Bridge fires ONLY when channelId present (null-channel tasks skipped).
- [ ] Step 4: Run pass (assert the message row + a `message.created` event row exist; assert EXACTLY ONE bridge message per lifecycle call — count===1, no double-emit; assert private-channel works).
- [ ] Step 5: (no git).

### Task A4: status transition validator
**Files:** Create `sources/control/tasks/taskTransition.ts`; Test (unit).
- [ ] Step 1: Failing unit test: `validateTaskTransition(from, to)` → ok for `todo→in_progress`, `in_progress→in_review`, `in_review→done`, `in_review→in_progress`, `in_progress→done`; → `{ok:false, code:'INVALID_TASK_TRANSITION'}` for terminal sources (`done`,`canceled`) and unknown. `waiting_approval` not in the agent set. (Separate from `slockTaskStatus.ts`, which stays a translator.)
- [ ] Step 2: Run fail.
- [ ] Step 3: Implement the transition table.
- [ ] Step 4: Run pass.
- [ ] Step 5: (no git).

### Task A5: agent-api tasks routes
**Files:** Create `sources/control/agentApi/agentApiTasks.ts`; Modify the api.ts registration (agentApiTasks registered with agentApiRoutes); Test `sources/control/agentApi/agentApiTasks.integration.spec.ts`.
- [ ] Step 1: Failing integration test (mirror agentApiRoutes.integration.spec.ts boot+seed; seed a ControlAgent owned by the test machine, member of `#sim`; seed tasks with numbers). Endpoints (all `authorizeAgentApi` + `resolveAgentChannelTarget`):
  - `GET /internal/agent-api/tasks/list?channel=#name` → channel tasks `{tasks:[{number,id,title,status,assignee_id,…}]}`.
  - `POST /internal/agent-api/tasks/create {channel, title|titles}` → ControlTask(s) status todo + number via nextChannelTaskNumber, NO auto-claim; emits the 📋 bridge message; returns `{tasks:[{number,id}]}`.
  - `POST /internal/agent-api/tasks/claim {channel, number}` → resolve #number→task; `claimControlTaskCas(task.id, agent.id)`; conflict→409 TASK_CLAIM_CONFLICT; self→ok; emits status bridge message.
  - `POST /internal/agent-api/tasks/unclaim {channel, number}` → release (owner===agent only).
  - `POST /internal/agent-api/tasks/update-status {channel, number, status}` → validateTaskTransition(current,status); 400 INVALID_TASK_TRANSITION on illegal; emits status bridge message.
  - Cases: create→row+number+📋 message; claim happy+self-idempotent+other-409; update legal+illegal; list; not-member→404; not-owned agent→403; unknown #number→404 TASK_NOT_FOUND.
- [ ] Step 2: Run fail (`npm run test:integration -- sources/control/agentApi/agentApiTasks.integration.spec.ts`).
- [ ] Step 3: Implement. Reuse claimControlTaskCas (A1), nextChannelTaskNumber (A2), taskMessageBridge (A3), taskTransition (A4), resolveAgentChannelTarget + authorizeAgentApi (slice 1).
- [ ] Step 4: Run pass.
- [ ] Step 5: Register `agentApiTasks` as its OWN `await app.register(agentApiTasks)` plugin in `sources/api.ts` (alongside the existing `agentApiRoutes` registration, literal `/internal/agent-api/tasks/*`, NOT under /api/v1) AND in `src/simulation/mioServerSetup.ts` (for the harness). Typecheck. (no git).

### Task A6: bridge the EXISTING slockTaskRoutes create path
**Files:** Modify `sources/control/tasks/slockTaskRoutes.ts` (call the bridge on channel-scoped create/status). Extend its integration spec.
- [ ] Step 1: Failing test: an iOS-style `POST /channels/:cid/tasks` create ALSO emits the 📋 bridge message (so agents see iOS-created tasks). taskRoutes workroom-level create (null channel) does NOT bridge.
- [ ] Step 2-4: Wire `emitTaskLifecycleMessage` into slockTaskRoutes create (+ assign number via nextChannelTaskNumber there too, so iOS-created tasks get numbers). Run; no regression to existing slockTaskRoutes tests.
- [ ] Step 5: (no git).

---

## Chunk B: mio-agent — mio task CLI + agentProxy tasks capability + systemPrompt task section

### Task B1: agentProxy `tasks` capability + task action routing
**Files:** Modify `src/proxy/agentProxy.ts`; extend `agentProxy.spec.ts`.
- [ ] Step 1: Failing test. **Action shape (mandated):** a single `task` action with `payload.op ∈ {list,create,claim,unclaim,update}` (matches the existing single-word `Action` union + `CAPABILITY_REQUIRED: Record<Action,string>` map — do NOT introduce dotted `task.create` actions). `{action:'task', payload:{op, channel, …}}` → forwards to `/internal/agent-api/tasks/<op>` (GET for list, POST for others) with the machine token + X-Mio-Agent-Id; requires `tasks` capability (403 CAPABILITY_DENIED without it); upstream errors (incl 409 conflict) relayed.
- [ ] Step 2-4: Implement: add `tasks` to the capability map, map task ops to the tasks routes (GET list, POST others). Run pass + `npm test` (no regression).
- [ ] Step 5: (no git).

### Task B2: `mio task` CLI subcommands
**Files:** Modify `src/agentcli/index.ts` (add `task` to the dispatcher); extend `agentcli.spec.ts`.
- [ ] Step 1: Failing test (mock proxy): `mio task list --channel #x`, `mio task create --channel #x --title "…"`, `mio task claim #N --channel #x`, `mio task unclaim #N --channel #x`, `mio task update #N --channel #x --status in_review` → correct proxy `task` action+payload; canonical output (e.g. the task board for list, confirmation for others); missing required flags → MISSING_ARG; proxy 409 conflict relayed.
- [ ] Step 2-4: Implement the `task` branch in `runAgentCli` (mirror the `message` branch). Run pass + `npm test` + tsc.
- [ ] Step 5: (no git).

### Task B3: systemPrompt task section + `tasks` capability in the wrapper
**Files:** Modify `src/runtimes/systemPrompt.ts` (add task section); Modify `src/proxy/cliTransport.ts` (capabilities → `send,read,tasks`); extend both specs.
- [ ] Step 1: Failing test: buildSystemPrompt output now contains the `mio task list/create/claim/unclaim/update` commands, the status flow `todo→in_progress→in_review→done`, the claim-before-work rule ("if a message asks you to DO something, claim it first; if claim fails, move on"), assignee-independent-of-status, `[task #N status=]` reading. cliTransport wrapper capabilities = `send,read,tasks`.
- [ ] Step 2-4: Implement (add the task section, mirroring the real Slock prompt's Tasks section, trimmed to these commands). Run pass + tsc.
- [ ] Step 5: (no git).

---

## Chunk C: deferred slice-1 fixes + runtime-detection seam

### Task C1: claude isolation — `--setting-sources project,local`
**Files:** Modify `src/runtimes/claudeStreamHost.ts` (`buildArgs`, ~line 185); extend `claudeStreamHost.spec.ts`; update `scripts/build-sea.mjs` smoke if it asserts argv.
- [ ] Step 1: Failing test: built argv includes `--setting-sources` `project,local` (assert the flag+value). 
- [ ] Step 2-4: Add `'--setting-sources','project,local'` to the args array. Run the host spec + `npm test`. **Manual verification (record in report):** run a real claude with the full buildArgs recipe + `--setting-sources project,local` in the agent workspace and confirm 0 host-global-CLAUDE.md/plugin pollution + login intact (this is the verified mechanism; re-confirm end-to-end).
- [ ] Step 5: (no git).

### Task C2: detectExecContext tsx-source mode
**Files:** Modify `src/proxy/cliTransport.ts` (`detectExecContext`); extend `cliTransport.spec.ts`.
- [ ] Step 1: Failing test: when `execPath`=node and `argv1` ends `.ts` (tsx-source dev mode), the wrapper exec line uses the tsx runner (resolve tsx) not bare `node <.ts>`. npm-dist (`.js`) and SEA modes unchanged.
- [ ] Step 2-4: Add a `tsx-source` branch to detectExecContext (resolve tsx like slice-1's slice1RoundTrip did: local node_modules/.bin/tsx then PATH). Run pass.
- [ ] Step 5: (no git).

### Task C3: runtime-detection seam (§5.1b)
**Files:** Modify `src/cli/commands/run.ts` (bootAgentSpine) to select runtime from the agent member record's `runtime` field + availability probe; Test.
- [ ] Step 1: Failing test: bootAgentSpine reads the agent member's `runtime` (claude|codex); for slice 2, `claude` → claudeStreamHost (as today). If `runtime==='codex'` → for slice 2, log a clear "codex stream-host not yet implemented (slice-later); spine not started for this agent" and don't start (don't fake). Probe claude availability (resolveClaudeCommand) before starting; if unavailable → clear error.
- [ ] Step 2-4: Implement the selection seam (claude-only host wired; codex is a documented gap, not a stub). Run pass.
- [ ] Step 5: (no git).

---

## Chunk D: acceptance runner + deploy

### Task D1: extend mioServerSetup for tasks + slice2RoundTrip runner
**Files:** Modify `src/simulation/mioServerSetup.ts` (register task routes + agentApiTasks + seed task `number`); Create `src/simulation/slice2RoundTrip.ts` (reuse simServerBoot + extend stubStreamRuntime with task behavior).
- [ ] Step 1: Extend mioServerSetup: `register(slockTaskRoutes, taskRoutes, agentApiTasks)`; ensure the seeded agent is a #sim member. The stub runtime, on a `[target=#sim` inbound asking to create+start a task, runs `mio task create … && mio task claim #N && mio task update #N --status in_review` via the real wrapper.
- [ ] Step 2: Write `slice2RoundTrip.ts` (runner, modeled on slice1RoundTrip): bootSimServer → start spine (real dispatcher cliEntry, `--setting-sources project,local` in effect) → post a human "create a task to do X and start it" → assert: ControlTask row created with number; `📋 …` bridge message in #sim; status advanced to in_progress (claim) then in_review; a SECOND concurrent claim → 409 path. Stub + real-claude (`MIO_SPINE_RUNTIME=claude`) variants.
- [ ] Step 3: Run stub variant `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice2RoundTrip.ts` → exit 0. Run real-claude variant once (now isolation-clean).
- [ ] Step 4: (no git).

### Task D2: migration + prod deploy + dogfood
- [ ] Step 1: Full suites: MioServer `npx tsc --noEmit` + `npm run test:integration -- sources/control/tasks sources/control/agentApi`; mio-agent `npm run build && npm test` + `npx tsc --noEmit` + `npm run build:sea` (smokes) + the slice2 runner.
- [ ] Step 2: **Prod migration + deploy** (slice 2 touches schema — FIRST schema-touching slice; get this right). On `106.54.19.137`:
  - **Predeploy backups (both):** code tar `tar czf /var/www/mioserver-code-predeploy-<ts>.tar.gz -C /var/www/mioserver sources` AND a DB dump (slice 1 was code-only so there's no DB-dump precedent — spell it out): on prod, `cd /var/www/mioserver && set -a && . ./.env && set +a && pg_dump "$DATABASE_URL" > /var/www/mioserver-predeploy-<ts>.sql` (DEPLOYMENT.md has no pg_dump; this is the literal command).
  - rsync `sources/` to prod (exclude *.spec.ts, node_modules) + the new `prisma/migrations/<ts>_s_task_number/` dir (the migration must be present on prod for migrate deploy).
  - **Apply the migration:** `cd /var/www/mioserver && set -a && . ./.env && set +a && npx prisma migrate deploy` (per DEPLOYMENT.md — the new migration applies as the next chain link; confirm it reports the one new migration applied, not a reset). Then `npx prisma generate`.
  - `pm2 restart mioserver`; smoke `/internal/agent-api/tasks/list` (401 unauth = mounted) + `/health` 200 + `pm2 logs mioserver` no errors.
  - Rollback path if migration fails: restore the predeploy .sql + the code tar + `pm2 restart`.
- [ ] Step 3: Live dogfood on prod (agent now isolated): post "@Agent create a task and start it" → confirm the 📋 message + status flow + the agent acting as the Mio agent (not exploring DevForge). Record outcome.
- [ ] Step 4: Final whole-slice review subagent. Update memory. (no git).

---

## Out of scope (later)
Task Board UX (filters/views/iOS — slice 5), task threads (progress posts in the channel for slice 2), dm/multi-agent-PM (slice 3)/reminders/action-prepare (slice 4), codex stream-json host (runtime seam added but codex host deferred), pure task=message refactor (hybrid keeps ControlTask), npm publish. See spec §10.
