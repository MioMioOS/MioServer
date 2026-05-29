# Slock Clone Slice 1 — Real Agentic Session Round-Trip — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one agent run as a real long-lived `claude` stream-json session, woken by the existing socket.io gateway, that reads and replies only through an injected `mio` CLI → local agent-proxy → MioServer `/internal/agent-api/{send,history}`.

**Architecture:** Build server-first (agent-api endpoints), then the agent's outbound path (agent-proxy + CliTransport + `mio agentcli`), then the inbound path (claudeStreamHost + InboxCoordinator + cursor store), then wire `run` and prove the spine with a headless integration test. Wake = existing socket.io WS gateway (NOT SSE); actions = proxy with the machine token attached only at the proxy boundary.

**Tech Stack:** TypeScript, Fastify + Prisma + Postgres (MioServer), Node + socket.io-client + vitest (mio-agent), the `claude` CLI v2.1.150 stream-json protocol.

**Spec:** `MioServer/docs/superpowers/specs/2026-05-24-slock-clone-slice1-agentic-session-design.md` (read it; this plan implements it).

**Cross-repo paths:** MioServer = `/Users/ying/Documents/AI/MioServer`, mio-agent = `/Users/ying/Documents/AI/mio-agent`. Run test/commit commands from the relevant repo root.

**Conventions to mirror (verified):**
- MioServer routes: `app.get/post('/api/v1/...')`; auth via `verifyMachineToken` (`@/machines/machineRoutes`), `requireMachineAccessToWorkroom` (`@/control/auth/machineAccess`), `authorizeControlRead` (`@/control/devTokens/devTokenAuth`); message create via `sendMessageTransaction` (`@/control/messages/sendMessageTransaction`). Test DB uses the project's hand-curated SQL discipline — NEVER `prisma migrate dev`.
- mio-agent tests: vitest `describe/it/expect`, pure-function unit tests with small builder helpers (see `src/orchestrator/replyGate.spec.ts`). Build: `npm run build` (tsc) + `npm test` (vitest run).
- mio-agent gateway: `ServerGateway.subscribe(workroomId, handler)` delivers `WorkroomEvent` with `topic:'message.created'`; socket.io at `/api/v1/ws/control`, event name `workroom:event`.
- The agent is added as the `agentcli` case of the existing `src/cli/index.ts` switch-dispatcher, loaded via a **string-literal** `await import('./commands/agentcli.js')` so esbuild bundles it into the SEA.

---

## Chunk 1: MioServer `/internal/agent-api/*` (server side)

**File structure:**
- Create: `MioServer/sources/control/agentApi/agentApiAuth.ts` — `authorizeAgentApi(request)`: verify machine token + resolve agent + ownership.
- Create: `MioServer/sources/control/agentApi/agentApiRoutes.ts` — `POST /internal/agent-api/send`, `GET /internal/agent-api/history`.
- Create: `MioServer/sources/control/agentApi/agentApiAuth.spec.ts`, `agentApiRoutes.spec.ts`.
- Modify: `MioServer/sources/**/api.ts` (the route-registration entry; find with `grep -rl "register(messageRoutes\|register(memberRoutes" sources`) — register `agentApiRoutes`.

### Task 1.1: `authorizeAgentApi` — machine token + agent ownership

**Files:**
- Create: `sources/control/agentApi/agentApiAuth.ts`
- Test: `sources/control/agentApi/agentApiAuth.spec.ts`

- [ ] **Step 1: Write the failing test.** Cover: (a) missing/invalid machine token → `{ok:false, status:401, code:'MACHINE_TOKEN_INVALID'}`; (b) valid token but `agentId` not owned by the machine (agent.machineId !== machine.id) → `{ok:false, status:403, code:'AGENT_NOT_OWNED'}`; (c) valid token + owned agent → `{ok:true, machine, agent}`. Mock `verifyMachineToken` + `db.controlAgent.findUnique`. Read `sources/control/messages/messageRoutes.ts` (auth usage) and `sources/machines/machineRoutes.ts` (`verifyMachineToken`) first to match the real return shapes.
- [ ] **Step 2: Run test, verify it fails** — `cd MioServer && npx vitest run sources/control/agentApi/agentApiAuth.spec.ts`. Expected: module-not-found / assertion fail.
- [ ] **Step 3: Implement `authorizeAgentApi`.** Read the `Authorization: Bearer <machineToken>` header + the agent id from header `X-Mio-Agent-Id` (the proxy sets it). `verifyMachineToken` → machine; `db.controlAgent.findUnique({where:{id:agentId}})`; assert ownership. NOTE: `ControlAgent.machineId` is nullable (`String?`) — treat `agent.machineId == null` (unbound agent) as NOT owned (→ 403 AGENT_NOT_OWNED), do not let `null === machine.id` slip through. Return discriminated union `{ok:true, machine, agent} | {ok:false, status, code, message}`.
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit** — `git -C MioServer add sources/control/agentApi/agentApiAuth.ts sources/control/agentApi/agentApiAuth.spec.ts && git -C MioServer commit -m "feat(agent-api): authorizeAgentApi machine+agent ownership"` (branch first if on default — repo is not git-tracked per environment; skip commit if `git -C MioServer rev-parse` fails).

### Task 1.2: `POST /internal/agent-api/send`

**Files:**
- Create/extend: `sources/control/agentApi/agentApiRoutes.ts`
- Test: `sources/control/agentApi/agentApiRoutes.integration.spec.ts` (real rows → MUST be `.integration.spec.ts`, run via `npm run test:integration`; the integration config refuses to run unless `DATABASE_URL` points at a `*_test` DB — that is the test-DB safety guard. Do NOT name it `.spec.ts`, which the default config would run without the guard.)

**Target model for slice 1 (the contract — there is NO existing resolver, you must build it):**
- Only `#channel-name` targets. `ControlChannel.name` is NOT unique, and an agent relates to a workroom only via membership, so resolution is membership-anchored:
  - Resolve `#name` → the `ControlChannel` where `name = <name>` AND a `ControlChannelMember{ memberId: agent.id }` row exists for it. Read the real membership table/field names first (`grep -rn "ControlChannelMember\|channelMember\|memberId" sources/control/channels sources/control/messages prisma`).
  - 0 matches → `404 NOT_A_MEMBER`. >1 match → `409 AMBIGUOUS_CHANNEL`. The matched channel yields both `channelId` and its `workroomId`.
- `dm:@peer` is OUT of slice 1 (peer→dm-channel resolution is unspecified; deferred). Any target with a `:` suffix (thread) or starting `dm:` → `400 TARGET_UNSUPPORTED`.

- [ ] **Step 1: Write the failing test** (Fastify `inject`, mirror an existing integration route spec). Cases: `#channel-name` happy path (agent is a member) → 200 `{id, seq}`, the created `ControlMessage` row has `senderId = agent.id`, `senderKind:'agent'`; agent not a member of any `#name` → 404 `NOT_A_MEMBER`; two channels named `#name` both with the agent as member → 409 `AMBIGUOUS_CHANNEL`; thread suffix `#c:abcd1234` or `dm:@x` → 400 `TARGET_UNSUPPORTED`; not-owned agent → 403 (delegates to authorizeAgentApi); **public channel where the agent is NOT a member → 404 NOT_A_MEMBER** (the route enforces its own membership gate for ALL channel types — do not rely on `sendMessageTransaction`, which only gates non-public channels and would let a public-channel send through).
- [ ] **Step 2: Run test, verify it fails** — `cd MioServer && npm run test:integration -- sources/control/agentApi/agentApiRoutes.integration.spec.ts`.
- [ ] **Step 3: Implement the route.** Body `{target, content, clientIdempotencyKey?}`. `authorizeAgentApi`. Reject non-`#name` targets (regex: must match `^#[^:]+$`; else 400 TARGET_UNSUPPORTED). Resolve per the contract above (membership-anchored; 404/409). **Enforce membership explicitly for all channel types** (query `ControlChannelMember{channelId, memberId:agent.id}`) BEFORE sending — do not delegate the gate to `sendMessageTransaction` (it skips the gate for public channels). Then call `sendMessageTransaction({workroomId, channelId, senderKind:'agent', senderId:agent.id, content, clientIdempotencyKey})`. **CRITICAL: persist + broadcast** — after the transaction succeeds, call the write-before-broadcast helper exactly like every `messageRoutes.ts` POST path does (`publishControlEvent` + `workroomBroadcaster.broadcast`). That helper (`writeEventAndBroadcast`) is currently module-private in `messageRoutes.ts` (~line 1171) — extract it to a shared `sources/control/messages/writeEventAndBroadcast.ts` (export + re-import into messageRoutes, behavior identical) and call it here. WITHOUT this the socket.io gateway never delivers `message.created` to the daemon and the entire slice-1 inbound wake path is silently broken. The integration test MUST assert a `message.created` event-log row exists for the created message (mirror `messageRoutes.write.integration.spec.ts`). Return `201 {id, seq}` (201 matches the message-create convention).
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 1.3: `GET /internal/agent-api/history`

**Files:**
- Extend: `sources/control/agentApi/agentApiRoutes.ts`
- Extend: `sources/control/agentApi/agentApiRoutes.integration.spec.ts`

- [ ] **Step 1: Write the failing test.** Query `?channel=#name&after_seq=<seq>` returns seq-ordered messages newer than seq (same membership-anchored `#name` resolution + gate as Task 1.2; non-member → 404 NOT_A_MEMBER). `?channel=#name&around=<msgShortId>` resolves the 8-char short id → message → returns a centered window. No anchor → latest 20. Each row uses the same wire shape as `messageRoutes` GET (sender_id/sender_kind/seq/content/short id).
- [ ] **Step 2: Run test, verify it fails** — `cd MioServer && npm run test:integration -- sources/control/agentApi/agentApiRoutes.integration.spec.ts`.
- [ ] **Step 3: Implement.** Reuse the existing channel-messages read shaping + `resolveSenderDisplayNames` from `messageRoutes.ts`. Resolve `#name` via the Task 1.2 contract (factor it into a shared helper in `agentApiRoutes.ts` or an `agentApiTargets.ts` so send + history share one resolver — DRY). shortid→seq: `db.controlMessage.findFirst({where:{channelId, id:{startsWith:shortId}}})` (or the project's short-id resolution if one exists — grep `startsWith\|shortId\|substring` in `sources/control/messages`). `after_seq` filter `seq > BigInt(after_seq)`, order asc, limit (default 20).
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 1.4: Register routes (prod + reuse in tests)

**Files:**
- Modify: the route-registration entry (`grep -rl "memberRoutes\|messageRoutes" sources --include=*.ts | grep -i 'api\|index\|app'`).

- [ ] **Step 1: Register** `agentApiRoutes` alongside the existing control routes. Verify the `/internal/` prefix is not stripped by a global `/api/v1` prefix (these routes are `/internal/agent-api/*`, a DIFFERENT prefix — register without the `/api/v1` prefix wrapper).
- [ ] **Step 2: Typecheck + both suites** — `cd MioServer && npx tsc --noEmit && npx vitest run sources/control/agentApi/agentApiAuth.spec.ts && npm run test:integration -- sources/control/agentApi/agentApiRoutes.integration.spec.ts`. (Unit auth via default config; route specs via the DB-guarded integration config. Ensure `DATABASE_URL` points at the `*_test` DB before running integration — the guard will refuse otherwise.) Expected: pass.
- [ ] **Step 3: Commit.**

---

## Chunk 2: mio-agent outbound — agent-proxy + CliTransport + `mio agentcli`

**File structure:**
- Create: `mio-agent/src/proxy/agentProxy.ts` — local 127.0.0.1 HTTP, capability gate, machine-token attach, forward `send`/`history`.
- Create: `mio-agent/src/proxy/cliTransport.ts` — write `.mio/` wrapper (mode-aware), proxy token file, spawnEnv.
- Create: `mio-agent/src/orchestrator/agentInboxCursorStore.ts` — `<agentId>:<channelId>→seq` monotonic (model on `loopCursorStore.ts`).
- Create: `mio-agent/src/agentcli/index.ts` (+ `mio-agent/src/cli/commands/agentcli.ts` thin delegator) — `message check|send|read`.
- Modify: `mio-agent/src/cli/index.ts` — add `case 'agentcli': await import('./commands/agentcli.js')`.
- Tests: `agentProxy.spec.ts`, `cliTransport.spec.ts`, `agentInboxCursorStore.spec.ts`, `agentcli.spec.ts`.

### Task 2.1: `agentInboxCursorStore`

**Files:**
- Create: `src/orchestrator/agentInboxCursorStore.ts`
- Test: `src/orchestrator/agentInboxCursorStore.spec.ts`

- [ ] **Step 1: Write the failing test.** `loadInboxCursor(agentId, channelId)` → '0' when absent; `persistInboxCursor(agentId, channelId, seq)` monotonic (lower seq ignored); two different agentIds on the same channelId do NOT collide. File `~/.mio/agent-inbox-cursor.json`, key `${agentId}:${channelId}`. (Read `src/orchestrator/loopCursorStore.ts` and copy its monotonic-BigInt pattern.)
- [ ] **Step 2: Run test, verify fail** — `cd mio-agent && npx vitest run src/orchestrator/agentInboxCursorStore.spec.ts`.
- [ ] **Step 3: Implement** mirroring `loopCursorStore.ts` but with the composite key.
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 2.2: `agentProxy` (local HTTP trust boundary)

**Files:**
- Create: `src/proxy/agentProxy.ts`
- Test: `src/proxy/agentProxy.spec.ts`

- [ ] **Step 1: Write the failing test** against a mock upstream (a throwaway `http.createServer` capturing forwarded headers). Cases: request with valid proxy token + `send` capability → forwards `POST /internal/agent-api/send` with `Authorization: Bearer <machineToken>`, `X-Perf-Caller-Context: agent_originated`, `X-Mio-Agent-Id: <agentId>`; request for `send` when capabilities=`read` only → `403 CAPABILITY_DENIED` (no forward); bad proxy token → 401; upstream 4xx → relayed as `{ok:false, code, message}`.
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement.** `register({agentId, launchId, serverUrl, machineToken, capabilities}) → {proxyUrl, proxyToken, close()}`. Bind `127.0.0.1:0` (ephemeral). Validate `Authorization: Bearer <proxyToken>`; map action→capability (`send`→send; `history`→read); forward with machine token attached. Hold the per-agent inbox cursor (read/advance via `agentInboxCursorStore`) for `check`.
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 2.3: `cliTransport` (mode-aware wrapper injection)

**Files:**
- Create: `src/proxy/cliTransport.ts`
- Test: `src/proxy/cliTransport.spec.ts`

- [ ] **Step 1: Write the failing test** (use a temp workspace dir). Cases: writes `<ws>/.mio/mio` (mode 0755) whose body contains `MIO_AGENT_PROXY_URL=`, `MIO_AGENT_PROXY_TOKEN_FILE=`, `MIO_AGENT_ACTIVE_CAPABILITIES='send,read'` and `agentcli "$@"`; npm-mode launch shape (execPath=node, argv1=JS) → exec line `'<node>' '<...>/dist/cli/index.js' agentcli "$@"`; SEA-mode shape (execPath=binary, no JS argv1) → exec line `'<binary>' agentcli "$@"`; writes proxy token file to `~/.mio/agent-proxy-tokens/<agentId>/<launchId>.token` mode 0600; returns spawnEnv with `<ws>/.mio` prepended to PATH and `CLAUDECODE` deleted.
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement** mirroring Slock `prepareCliTransport` (see spec §5.4). Detect mode from `process.execPath`/`process.argv[1]` (injectable for tests). Write `.mio/mcp-config.json` = `{"mcpServers":{}}`.
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 2.4: `mio agentcli` (message check|send|read) + dispatcher wiring + SEA smoke

**Files:**
- Create: `src/agentcli/index.ts`, `src/cli/commands/agentcli.ts`
- Modify: `src/cli/index.ts` (add `agentcli` case via string-literal import)
- Modify: `scripts/build-sea.mjs` (append smoke step)
- Test: `src/agentcli/agentcli.spec.ts`

- [ ] **Step 1: Write the failing test** against a mock proxy. Cases: `message send --target "#x"` reads body from stdin → `POST send`, prints canonical confirmation, exit 0; `message read --channel "#x" --around abcd1234` → `GET history`; missing `MIO_AGENT_PROXY_TOKEN_FILE` → stderr `{"ok":false,"code":"MISSING_PROXY_TOKEN"}` exit≠0; upstream error → stderr JSON with relayed code.
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement** the three subcommands (env resolve → call proxy → canonical stdout / stderr JSON). Wire `case 'agentcli': await import('./commands/agentcli.js')` into `src/cli/index.ts`'s switch (string literal — required for SEA bundling).
- [ ] **Step 4: Run test, verify pass** + `npm run build`.
- [ ] **Step 5: SEA smoke gate.** In `scripts/build-sea.mjs`, after the binary is produced, run it as `<binary> agentcli --help` and assert exit 0 (fail the build otherwise). Run `npm run build:sea` and confirm it passes. (If `build:sea` needs network/signing unavailable here, document the smoke step and mark it to run in CI; do NOT skip writing the step.)
- [ ] **Step 6: Commit.**

---

## Chunk 3: mio-agent inbound — stream-json host + system prompt + inbox

**File structure:**
- Create: `mio-agent/src/runtimes/streamJsonParser.ts` — parse claude stdout stream-json (session_id + turn boundaries).
- Create: `mio-agent/src/runtimes/systemPrompt.ts` — `buildSystemPrompt(ctx)`.
- Create: `mio-agent/src/runtimes/claudeStreamHost.ts` — long-lived process + stdin gating + resume.
- Create: `mio-agent/src/orchestrator/inboxDelivery.ts` — subscribe gateway, render header, gated enqueue, `onInjected`.
- Tests for each.

### Task 3.1: `streamJsonParser`

**Files:**
- Create: `src/runtimes/streamJsonParser.ts`
- Test: `src/runtimes/streamJsonParser.spec.ts`

- [ ] **Step 1: Write the failing test** with canned newline-delimited JSON fixtures: a `system`/init line carrying `session_id` → `onSessionId('<uuid>')`; an assistant turn-end/`result` line → `onBoundary()`; partial line buffering across two `feed()` calls (split mid-JSON) reassembles correctly; non-JSON noise lines ignored. (Verify the exact init/result event shapes by running `claude -p --output-format stream-json --verbose 'hi' | head` once and matching field names — do NOT guess; capture a real fixture.)
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement** a line-buffering parser: `feed(chunk: string)`, callbacks `onSessionId`, `onBoundary`, `onError`.
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 3.2: `systemPrompt`

**Files:**
- Create: `src/runtimes/systemPrompt.ts`
- Test: `src/runtimes/systemPrompt.spec.ts`

- [ ] **Step 1: Write the failing test.** `buildSystemPrompt({agentId, handle, displayName, description, serverId, computer, hostname, workspace})` returns a string that contains: the handle (`@X`), the persona/description, the slice-1 command subset (`mio message check|send|read`), the RFC-5424 header format example, the reply etiquette lines, and the MEMORY.md instruction. Does NOT mention tasks/reminders/action-prepare (slice-1 scope).
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement** the builder (adapt the slock system prompt to mio, slice-1 subset — see spec §5.2 + the source-grounded model doc).
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 3.3: `claudeStreamHost`

**Files:**
- Create: `src/runtimes/claudeStreamHost.ts`
- Test: `src/runtimes/claudeStreamHost.spec.ts`

- [ ] **Step 1: Write the failing test** with an injectable spawn (fake child exposing stdin/stdout/exit). Assert: built argv equals the spec §5.1 recipe (`--allow-dangerously-skip-permissions --dangerously-skip-permissions --verbose --permission-mode bypassPermissions --output-format stream-json --input-format stream-json --model <m> --disallowed-tools EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete --append-system-prompt-file <path> --mcp-config <path> --strict-mcp-config`, plus `--resume <id>` when sessionId given); first user turn written to stdin as `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}\n`; `enqueueUserTurn` does NOT write until `onBoundary` fires (gating); after boundary, queued turns flush (coalesced); on child exit, restart with `--resume <capturedSessionId>`.
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement** the host: `start()`, `enqueueUserTurn(text)`, `onBoundary`/`onSessionId`/`onExit`/`onInjected`, `stop()`. Wire stdout through `streamJsonParser`. cwd=workspace, stdio piped, env from cliTransport, `CLAUDECODE` deleted. Max-wait timeout flushes only at end-of-turn (never mid-thinking).
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

### Task 3.4: `inboxDelivery` (InboxCoordinator)

**Files:**
- Create: `src/orchestrator/inboxDelivery.ts`
- Test: `src/orchestrator/inboxDelivery.spec.ts`

- [ ] **Step 1: Write the failing test** with a fake gateway (emits `WorkroomEvent{topic:'message.created'}`) + fake host. Assert: on event, fetches the message, renders the RFC-5424 header (`[target=#c msg=8char time=ISO type=human] @sender: body`), skips messages whose sender is self, calls `host.enqueueUserTurn(rendered)`; `onInjected(cb)` fires when the host reports the turn was written; advances `agentInboxCursorStore`.
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement** using `ServerGateway.subscribe(workroomId, handler)` (read `src/orchestrator/autonomousLoop.ts` for the existing event→GET pattern and the header/render helper if one exists; reuse `renderMessages` style). Skip-self via `senderId === selfAgentId`.
- [ ] **Step 4: Run test, verify pass.**
- [ ] **Step 5: Commit.**

---

## Chunk 4: Wiring + integration acceptance + harness

**File structure:**
- Modify: `mio-agent/src/cli/commands/run.ts` — boot host + inbox + proxy (the new spine) instead of the old dispatcher loop.
- Modify: `mio-agent/src/simulation/mioServerSetup.ts` — also register message routes + `agentApiRoutes` + socket.io broadcaster.
- Modify: `mio-agent/src/simulation/headlessSim.ts` — the acceptance test driver.
- Create: `mio-agent/src/simulation/slice1RoundTrip.spec.ts` — the acceptance test.

### Task 4.1: `run` boots the new spine

**Files:**
- Modify: `src/cli/commands/run.ts`
- Test: `src/cli/commands/run.spec.ts` (or extend existing)

- [ ] **Step 1: Write the failing test** (injectable deps): `run` for a configured agent → calls `cliTransport.prepare`, starts `agentProxy.register`, constructs `claudeStreamHost` with the built system prompt, starts `inboxDelivery`, and keeps the health server (127.0.0.1:7878) responding. Read current `run.ts` first; preserve health-server + config-load behavior the GUI depends on.
- [ ] **Step 2: Run test, verify fail.**
- [ ] **Step 3: Implement** the wiring. Keep `run` resilient (one agent for slice 1; multi-agent is later). **Surface the `inboxDelivery` instance (or at least its `onInjected` hook) to the caller** — return it from the run entry or accept an observer — so the Task 4.3 runner (which drives `run` in-process) can assert condition (b). This is the one cross-boundary observation the acceptance test needs; nail it here.
- [ ] **Step 4: Run test, verify pass** + `npm run build`.
- [ ] **Step 5: Commit.**

### Task 4.2: Extend `mioServerSetup` to mount message + agent-api + socket.io

**Files:**
- Modify: `src/simulation/mioServerSetup.ts`
- Create: `src/simulation/simServerBoot.ts` (extract the boot helper — see Step 2)

**IMPORTANT harness mechanics (verified — read `headlessSim.ts` lines 184-249 first):** `mioServerSetup.ts` imports MioServer via `@/` aliases, so it **cannot be imported into a mio-agent vitest process** — it only resolves when **copied into `MIOSERVER_DIR` at runtime and spawned as `npx tsx <copy>` with `cwd=MIOSERVER_DIR`** (then it prints a first-line JSON `{serverUrl, ...}` on stdout). The acceptance test is therefore a **standalone tsx runner** (like `headlessSim.ts`), NOT a `.spec.ts`. Do not try to `import { mioServerSetup }` from vitest.

- [ ] **Step 1:** In `mioServerSetup.ts` add `await app.register(messageRoutes)` + `await app.register(agentApiRoutes)` (both resolve via `@/` because the script runs copied-into-MIOSERVER_DIR) and stand up the socket.io control namespace/broadcaster that `workroomBroadcaster` emits on, so WS events actually flow to a subscriber. Seed: one workroom, one channel `#sim`, one human member, one ControlAgent owned by the test machine, and a `ControlChannelMember{channelId, memberId:agent.id}` so the agent can send/read. Extend the printed first-line JSON to include `{ serverUrl, workroomId, channelId, agentId, machineToken, humanOpToken }`.
- [ ] **Step 2:** Factor `headlessSim.ts`'s "copy setup into MIOSERVER_DIR + `npx tsx` spawn + read first JSON line + cleanup" into `src/simulation/simServerBoot.ts` exporting `bootSimServer(): Promise<{ child, setup, cleanup }>`. Refactor `headlessSim.ts` to use it (no behavior change). Run `MIOSERVER_DIR=../MioServer npx tsx src/simulation/headlessSim.ts` once to confirm the refactor still boots + prints serverUrl (smoke; it asserts via its own `assertPass`).
- [ ] **Step 3: Commit.**

### Task 4.3: Acceptance test — the spine (standalone tsx runner, not vitest)

**Files:**
- Create: `src/simulation/slice1RoundTrip.ts` (runner modeled on `headlessSim.ts`: `main()` + `assertPass` + `process.exit(code)`)
- Create: `src/simulation/stubStreamRuntime.ts` (the fake runtime, below)

- [ ] **Step 1: Build the stub runtime.** `stubStreamRuntime.ts` is a tiny program the host launches INSTEAD of `claude` (the host takes an injectable command). It reads stream-json user turns on stdin; on the first turn it writes a stream-json init line carrying a `session_id`, then executes the injected `mio message send --target "#sim"` via the real `.mio/mio` wrapper (proving the CLI→proxy→server path), then writes a turn-boundary line. This exercises the real outbound spine without depending on a live LLM.
- [ ] **Step 2: Write the runner** `slice1RoundTrip.ts`. Use `bootSimServer()` (Task 4.2). Configure + `run` the seeded agent with the runtime command pointed at `stubStreamRuntime.ts` (default) or real `claude` when **`MIO_SPINE_RUNTIME=claude`** (use a DISTINCT env name — do NOT reuse `MIO_RUNTIME`, which already selects the claude-vs-codex one-shot action runtime; this axis is stub-vs-real stream-json host, injected as the runtime command into `claudeStreamHost`). Post a human message to `#sim` via the message route using `humanOpToken` (minted with `mintOperatorSession` from `@/control/operatorSessions/operatorSessionMint` — `{orgId, workroomId, operatorSubjectId, issuedBy}` → raw `op_sess_`; posting with it yields `senderKind='user'`). Then `assertPass` ALL THREE spec §3 conditions: (a) within a timeout, a `ControlMessage` in `#sim` has `senderId = agentId` (poll via `GET /internal/agent-api/history` or the message route); (b) `inboxDelivery.onInjected` fired for the inbound message before that reply — the runner drives `run` in-process so it can read the hook directly (see Task 4.1: `run` must surface the `inboxDelivery` instance / its `onInjected` to the caller's scope); (c) no `mio message check` poll occurred for that message (the agentcli/proxy increments a spy counter that must stay 0 for the inbound). Exit 0 on all-pass, 1 otherwise.
- [ ] **Step 3: Run the stub variant** — `cd mio-agent && MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice1RoundTrip.ts`. Expected: all three assertions pass, exit 0.
- [ ] **Step 4: Run the real-claude variant once** on the dev box — `MIO_SPINE_RUNTIME=claude MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice1RoundTrip.ts` (claude v2.1.150 is installed). Record the outcome in the commit. If it reveals a stream-json protocol mismatch, fix `streamJsonParser`/`claudeStreamHost` and re-run.
- [ ] **Step 5: Commit.**

### Task 4.4: Final review + handoff

- [ ] **Step 1:** Run the full suites: `cd MioServer && npx tsc --noEmit && npx vitest run sources/control/agentApi/agentApiAuth.spec.ts && npm run test:integration -- sources/control/agentApi/agentApiRoutes.integration.spec.ts` (integration needs `DATABASE_URL`→`*_test`); then `cd mio-agent && npm run build && npm test` (vitest unit) and the spine runner `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice1RoundTrip.ts` (exit 0). All green.
- [ ] **Step 2:** Manual dogfood (the spine, end-user action): on the dev box, with a real agent configured, post a message from the iOS app / a real workroom channel and confirm the agent replies in-character. (This is the "do the user's own action end-to-end before declaring complete" gate.)
- [ ] **Step 3:** Update spec §13 npm row if `@miomioos/mio-agent` gets published during this slice; otherwise leave as "target/not published".
- [ ] **Step 4: Commit** + report slice-1 completion against the spec §3 acceptance criteria.

---

## Out of scope (do not build here — later slices)
Tasks (task=message/claim/update), multi-agent/PM orchestration, reply-routing beyond one agent, reminders, action-prepare, profile/react/attachments/search/channel-join, codex runtime, runtime-profile migration + `chat` MCP, threads, Windows wrappers, CodeLight iOS surfaces, npm publish (unless trivially done in 4.3). See spec §12.
