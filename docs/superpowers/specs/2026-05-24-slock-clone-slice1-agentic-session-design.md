# Slock Clone — Slice 1: Real Agentic Session Round-Trip (Design Spec)

- Date: 2026-05-24
- Status: design (pre-plan)
- Parent decomposition: option A "faithful alignment with real Slock architecture" → 5 sub-projects. **This spec is sub-project 1 only.**
- Source-of-truth for the model: `CodeLight/docs/productization/slock-orchestration-model-2026-05-24.md` (source-grounded from `@slock-ai/daemon@0.52.2`).
- Repos touched: `mio-agent` (runtime host, agent CLI, agent-proxy), `MioServer` (`/internal/agent-api/*`). NOT CodeLight (iOS is later slices).

---

## 1. Goal (one sentence)
One agent runs as a **real long-lived `claude` stream-json session** in a persistent workspace, woken by a streaming inbox, that reads and replies **only** through an injected `mio` CLI → local agent-proxy → MioServer `/internal/agent-api/{events,history,send}`.

## 2. Why this slice first
It is the architectural spine of option A. Every later sub-project (tasks, PM orchestration, reminders, action-cards, iOS) builds on "agent = real agentic session driven through a CLI surface, woken by streaming delivery." Proving this end-to-end first prevents building horizontally on an unvalidated spine.

## 3. Success criteria (acceptance)
From a test harness (or iOS) a human posts a message to `#channel` that exactly one agent is a member of. Within one turn:
1. The agent's running `claude` process receives the message via gated stdin stream-json injection driven by the socket.io wake path — proven by the `InboxCoordinator.onInjected` hook firing, NOT by the agent self-polling `mio message check`.
2. The agent's outbound chat actions go only through the `mio` CLI (the wake/delivery path is the daemon gateway; the agent never holds the machine token).
3. The agent posts an in-character reply via `mio message send`, which reaches MioServer and is visible in the channel.
4. Outbound agent action traffic flows agent CLI → agent-proxy (127.0.0.1) → MioServer `/internal/agent-api/{send,history}` with the real machine token attached only by the proxy.

Measured by the integration test in §10: it asserts (a) the reply row appears in MioServer with `sender = the agent`, AND (b) `onInjected` fired for the inbound message before the reply, AND (c) no `mio message check` call occurred for that message — so the spine (gated WS-driven injection, not polling) is actually exercised, not just "a reply appeared."

---

## 4. Architecture overview

```
 iOS / test harness ──POST message──▶ MioServer (control plane)
                                          │  persists + publishes (socket.io WS
                                          │  + per-channel seq catch-up)
                                          ▼
 mio-agent daemon ◀═ socket.io WS (existing gateway/wsClient, machine token) ═┐
   ├─ InboxCoordinator  (renders header, queues, gates)                       │
   ├─ AgentRuntimeHost  (long-lived `claude` stream-json proc)                │
   │     stdin ◀ gated user-turn injection                                    │
   │     stdout ▶ stream-json parse (turn boundaries, session)                │
   │     PATH has .mio/mio  ─────────────────────────┐                        │
   ├─ agent-proxy (127.0.0.1, holds machine token) ◀─┘ (CLI actions only)     │
   │     forwards send/history ──Bearer machine token + agent scope──▶ MioServer
   └─ workspace ~/.mio/agents/<agentId>/ (.mio/, MEMORY.md, notes/)           │
                                                                              │
 (wake path) MioServer ═══════════════════════════════════════════════════════┘
```

**Two distinct paths, do not conflate them:**
- **Wake/delivery (inbound):** the daemon already holds the machine token and already speaks MioServer's socket.io WS + seq catch-up via `gateway/serverGateway.ts`/`wsClient.ts`. The InboxCoordinator subscribes through that existing gateway. This path does NOT go through the agent-proxy and is NOT SSE. No new server endpoint is added for wake in slice 1.
- **Actions (outbound):** the agent's `mio` CLI calls the local agent-proxy, which attaches the machine token and forwards to MioServer `/internal/agent-api/{send,history}`.

The agent *process* never sees the machine token. It sees only the proxy URL + a per-launch proxy token file + capability flags (env). The proxy is the single trust boundary for agent-originated actions; it attaches the machine token and enforces capability + ownership. The wake path's machine token lives in the daemon, never in the agent process.

---

## 5. Units (boundaries + interfaces)

### 5.1 AgentRuntimeHost — `mio-agent/src/runtimes/claudeStreamHost.ts` (NEW long-lived host)
**Responsibility:** own one long-lived `claude` process for one agent and the stdin/stdout stream-json protocol.

> **Not a light refactor.** The existing `runtimes/claudeRuntime.ts` spawns claude **one-shot** with `--output-format json` and immediately closes stdin (`child.stdin.end()`). This unit is a new long-lived `--input-format stream-json` host with a persistent stdin write loop, boundary gating, and `--resume`. Build it as a new file; the one-shot `claudeRuntime.ts` is retained for the operator `run` path (or removed if unused after the cutover) — the plan decides, but do not treat 5.1 as editing the one-shot file.

**Launch args (faithful to Slock `buildClaudeArgs`, verified claude v2.1.150):**
```
claude --allow-dangerously-skip-permissions --dangerously-skip-permissions
  --verbose --permission-mode bypassPermissions
  --output-format stream-json --input-format stream-json
  --model <config.model || "sonnet">
  --disallowed-tools EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete
  --append-system-prompt-file <.mio/system-prompt.md>
  [--resume <sessionId>]               # only if a persisted session id exists
  --mcp-config <.mio/mcp-config.json> --strict-mcp-config
```
- `cwd = ~/.mio/agents/<agentId>/`; `stdio = ["pipe","pipe","pipe"]`; `env` = spawnEnv from CliTransport (§5.4) with `CLAUDECODE` deleted.
- **First turn:** write one line of stream-json to stdin:
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":<prompt>}]}}\n`
  (no `session_id` on first launch; include it when resuming).
- **Subsequent turns:** `enqueueUserTurn(text)` appends to a queue; the gating logic (§5.3) writes the next queued turn to stdin only at a safe boundary.
- **stdout parse:** newline-delimited JSON events. Extract: `session_id` from the `system`/init event (persist for `--resume`); detect turn-boundary events (assistant `result`/turn-end) to drive gating; surface errors.
- **Interface:** `start(): Promise<void>`, `enqueueUserTurn(text): void`, `onBoundary(cb)`, `onSessionId(cb)`, `onExit(cb)`, `stop(): void`.

**Disallowed native tools:** the six above are blocked so the agent uses `mio reminder` (later slice) / `mio` actions instead of native wake/cron/plan. (For slice 1 reminders aren't built; the disallow list still matches Slock to keep behavior identical.)

### 5.2 SystemPromptBuilder — `mio-agent/src/runtimes/systemPrompt.ts`
**Responsibility:** generate the per-agent behavioral contract written to `.mio/system-prompt.md`.
- mio-branded adaptation of the slock system prompt, **slice-1 scope**: "who you are" (persistent workspace + wake/sleep colleague framing), authoritative Runtime Context block (Agent ID / Server ID / Computer / Hostname / OS / Workspace), the message header format (§7), the **slice-1 `mio` command subset** (`message check|send|read`), reply etiquette (reply when @mentioned/clearly addressed/can do the work; respect ongoing conversations; skip idle narration; mention others not self), and the MEMORY.md convention.
- Persona seed: appended "Initial role" line from the agent's `description`.
- **Interface:** `build(agent: AgentRuntimeContext): string`.
- Commands NOT yet available (tasks/reminders/etc.) are simply absent from the prompt — no "coming soon" text.

### 5.3 InboxCoordinator + GatedDelivery — `mio-agent/src/orchestrator/inboxDelivery.ts`
**Responsibility:** turn server events into gated stdin injections.
- **Events source = the existing socket.io gateway** (`gateway/serverGateway.ts` + `wsClient.ts`), subscribed with the daemon's machine token. This is the same per-workroom socket.io WS + seq catch-up the daemon already uses. No SSE, no agent-proxy involvement on this path.
- On reconnect, use the existing seq catch-up (`after_seq`) so no message is missed; on `seq_expired`, fall back to a bounded history fetch.
- For each delivered message: render the RFC-5424 header line (§7) + body, skip messages authored by self, enqueue to AgentRuntimeHost.
- **Gating:** `busyDeliveryMode="gated"` — hold queued turns until AgentRuntimeHost reports a safe boundary; then flush (coalescing multiple pending messages into one injected user turn is allowed).
- **Interface:** `start()`, `stop()`. Depends on AgentRuntimeHost (enqueue + boundary callback) and the socket.io gateway. **Exposes a test hook** `onInjected(cb)` that fires when a turn is actually written to claude stdin (used by §10 to prove the spine).

### 5.4 CliTransport (agent-proxy bootstrap) — `mio-agent/src/proxy/cliTransport.ts`
**Responsibility:** mirror Slock `prepareCliTransport` — set up the per-launch credential proxy + inject the `mio` wrapper.
- Create `<workspace>/.mio/`. Register the agent-proxy launch (§5.5) → obtain `{ proxyUrl, proxyToken }`. Write proxy token to `~/.mio/agent-proxy-tokens/<agentId>/<launchId>.token` (mode 0600).
- Write POSIX wrapper `<workspace>/.mio/mio` (mode 0755). **The exec line is distribution-mode-aware** (see §13) — it points at the *same* mio-agent executable that the running daemon was launched from, dispatched to the `agentcli` subcommand:
  ```bash
  #!/usr/bin/env bash
  # npm mode (daemon = node + dist/cli/index.js):
  MIO_AGENT_PROXY_URL='<url>' MIO_AGENT_PROXY_TOKEN_FILE='<tokenfile>' MIO_AGENT_ACTIVE_CAPABILITIES='send,read' exec '<node>' '<mio-agent>/dist/cli/index.js' agentcli "$@"
  # SEA mode (daemon = ~/.mio/bin/mio-agent single binary, no node):
  MIO_AGENT_PROXY_URL='<url>' MIO_AGENT_PROXY_TOKEN_FILE='<tokenfile>' MIO_AGENT_ACTIVE_CAPABILITIES='send,read' exec '~/.mio/bin/mio-agent' agentcli "$@"
  ```
  CliTransport picks the line from how the daemon itself was started (`process.execPath` + whether `process.argv[1]` is a JS entry vs a SEA binary), mirroring Slock's `prepareCliTransport` (`process.execPath` + `slockCliPath`). The agent always invokes `mio message …`; the wrapper translates that to `<installed mio-agent> agentcli message …`.
  (slice-1 capabilities = `send,read` only; full set later. Capability mapping: `mio message send` → `send`; `mio message check` and `mio message read` both → `read`. The proxy gate must not 403 `check`/`read` under the `read` capability.)
- Build `spawnEnv` with `<workspace>/.mio` prepended to `PATH` so `mio` resolves to the wrapper; write `.mio/mcp-config.json` (slice 1: the `chat` runtime-actions MCP for migration-ack parity, or empty `{"mcpServers":{}}` — see §11 decision; default empty for slice 1 since migration isn't built).
- **Interface:** `prepare(ctx): { mioDir, spawnEnv, proxyHandle }`.
- Windows wrapper variants deferred (slice 1 targets darwin, matching the dev box).

### 5.5 agent-proxy — `mio-agent/src/proxy/agentProxy.ts`
**Responsibility:** local HTTP trust boundary. Holds the real machine token; never exposes it to the agent.
- Binds `127.0.0.1:<ephemeral port>`. Issues a per-launch `proxyToken`.
- Each request: validate `Authorization: Bearer <proxyToken>` against the launch; check the requested action against `MIO_AGENT_ACTIVE_CAPABILITIES`; forward to `<serverUrl>/internal/agent-api/<route>` with headers `Authorization: Bearer <machineToken>`, `X-Perf-Caller-Context: agent_originated`, and agent scoping (agentId).
- **slice-1 routes proxied: `POST /send`, `GET /history` only.** The proxy does NOT carry the wake/events stream — that path is the daemon's socket.io gateway (§5.3), not the agent-proxy.
- **Interface:** `register({agentId, launchId, serverUrl, machineToken, capabilities}): {proxyUrl, proxyToken, close()}`.
- Errors returned to CLI as `{ "ok": false, "code": "...", "message": "..." }` with non-2xx; capability denial → `403 CAPABILITY_DENIED`.

### 5.6 mio agent CLI — `mio-agent/src/agentcli/` wired as the `agentcli` subcommand of the existing `src/cli/index.ts` dispatcher
**Responsibility:** the agent's only action surface. **Slice-1 subcommands only.**

> **Multi-call, not a separate bin.** mio-agent already ships one bin (`mio-agent` → `dist/cli/index.js`) with a `mio-agent <command>` dispatcher and a SEA build (`scripts/build-sea.mjs`). The agent CLI is added as a new `agentcli` command in that dispatcher (logic in `src/agentcli/`). This makes it reachable identically in BOTH distribution modes (npm node-script and SEA single-binary) — see §13. It is NOT a standalone npm package and NOT a second bin. The operator commands (install/login/run/start/stop) stay in `src/cli/`; `agentcli` is a sibling command, not mixed into them.
- `mio message check` — non-blocking pull of messages newer than the agent's last-seen cursor. **Cursor model:** the cursor is the BigInt per-channel `seq` (MioServer's existing catch-up unit). The agent never passes it; the **daemon persists a per-agent+channel last-seen seq cursor** in a **NEW store `agentInboxCursorStore.ts` keyed `<agentId>:<channelId> → seq`**, modeled on the existing monotonic-BigInt `loopCursorStore.ts` (file `~/.mio/agent-inbox-cursor.json`, mode 0600). It must NOT reuse `loopCursorStore` (channelId-only → collides across agents on one machine) and must NOT touch `cursors.ts` (that is the workroom-level WS catch-up anchor; corrupting it breaks delivery). It **survives claude restarts/`--resume`** (NOT scoped to the per-launch proxy object — the proxy reads/advances it through the daemon). `check` **fans out one `GET /history?after_seq=<held>` call per channel the agent is a member of**, then advances each channel's cursor. Prints canonical text (same header format as §7).
- `mio message send --target <t>` — body from stdin (heredoc); proxy `POST /send`.
- `mio message read --channel <c> [--before <msgShortId> | --after <msgShortId> | --around <msgShortId>]` — proxy `GET /history`. **Anchor model:** agent-facing anchors are message short ids (`msg=`, first 8 chars of UUID, as shown in headers); the server resolves shortid → message → seq and returns a seq-ordered window. No anchor = latest N (default 20).
- Reads `MIO_AGENT_PROXY_URL`, `MIO_AGENT_PROXY_TOKEN_FILE`, `MIO_AGENT_ACTIVE_CAPABILITIES` from env. Success → canonical text on stdout, exit 0. Failure → JSON on stderr, non-zero exit, with code prefixes (`MISSING_*`/`TOKEN_*` local, `*_FAILED` server 4xx, `SERVER_5XX` unreachable).
- Lives in `src/agentcli/`, invoked via the dispatcher's `agentcli` case (a sibling of the operator commands in `src/cli/index.ts`, not mixed into them). CliTransport points the wrapper at the running mio-agent executable: npm → `node <pkg>/dist/cli/index.js agentcli`; SEA → `~/.mio/bin/mio-agent agentcli`. There is no separate agentcli bin to resolve.

### 5.7 MioServer agent-api — `MioServer/sources/control/agentApi/agentApiRoutes.ts` (new)
**Responsibility:** the two server endpoints the proxy calls. **Slice-1 subset — no events endpoint** (wake is the existing socket.io WS, §5.3).
- `POST /internal/agent-api/send` — `{ target, content, clientIdempotencyKey }`. Target resolution (slice 1): **`#channel-name` only** (`dm:@peer` deferred — peer→dm-channel resolution is unspecified; thread-suffix targets OUT, §7). `#name` is NOT unique and the agent links to a workroom only via membership, so resolution is **membership-anchored**: the channel where `name=<n>` AND a `ControlChannelMember{memberId:agent.id}` row exists (0 → 404 NOT_A_MEMBER, >1 → 409 AMBIGUOUS_CHANNEL). The route enforces membership **explicitly for all channel types** (do not rely on `sendMessageTransaction`, which skips the gate for public channels). Then create the message with `senderId = agent.id`, `senderKind:'agent'` via `sendMessageTransaction` → persist + broadcast. Returns `{ id, seq }`.
- `GET /internal/agent-api/history?channel=<t>&after_seq=<seq>|around=<msgShortId>|limit=<n>` — return messages visible to the agent in that target, seq-ordered, membership-gated. Maps the agent-facing shortid anchors (§5.6) to seq internally. Used by both `mio message check` (after_seq) and `mio message read` (around/before/after).
- Auth: a new `authorizeAgentApi(request)` — Bearer machine token + agent scoping; resolves the agent, verifies machine ownership, derives membership. Reuses existing `requireMachineAccessToWorkroom` patterns.
- **No new real-time infra.** Slice 1 reuses MioServer's existing event publication + socket.io broadcast unchanged; this file only adds the two REST routes above.

---

## 6. Workspace layout (faithful to Slock)
```
~/.mio/agents/<agentId>/
  .mio/
    system-prompt.md          # 0600, generated per launch
    mcp-config.json           # 0600
    mio                       # 0755 wrapper (POSIX)
    runtime-sessions/         # claude stream-json rollouts (claude manages)
  MEMORY.md                   # agent-owned, persists across launches
  notes/                      # agent-owned
~/.mio/agent-proxy-tokens/<agentId>/<launchId>.token   # 0600
```

## 7. Message header format (faithful to Slock)
Delivered messages rendered as:
```
[target=#general msg=a1b2c3d4 time=2026-05-24T01:00:00 type=human] @richard: hello
[target=dm:@richard msg=c9d0e1f2 time=... type=agent] @Research: hi
```
- `target` reused verbatim for replies. `msg` = first 8 chars of message UUID. `type` ∈ `human|agent|system`.
- **Threads AND DMs are OUT of slice 1.** The renderer produces the `target`/`msg`/`time`/`type` header for top-level `#channel` messages only. Thread-suffix targets (`#channel:shortid`) and `dm:@peer` targets — rendering, reading, replying, creation — are deferred to later slices (dm peer→channel resolution is unspecified). The `send`/`history` routes accept only `#channel` targets in slice 1 (`:` suffix or `dm:` prefix → 400 TARGET_UNSUPPORTED).

---

## 8. Data flow (one round-trip)
1. Human posts to `#channel` (existing message-create path).
2. MioServer persists + publishes the event over the existing socket.io WS.
3. The daemon's existing socket.io gateway (machine token) receives it; InboxCoordinator gets the event (NOT via the agent-proxy, NOT SSE).
4. InboxCoordinator renders header, skips self-authored, enqueues to AgentRuntimeHost.
5. AgentRuntimeHost injects the user turn to claude stdin at the next safe boundary (the `onInjected` hook fires here).
6. claude (per system prompt) decides to reply → runs `mio message send --target "#channel"`.
7. mio CLI → agent-proxy → `POST /internal/agent-api/send` (machine token attached by proxy) → persist + broadcast.
8. Reply visible to the human; mio CLI prints canonical confirmation; agent finishes its turn and idles.

## 9. Error handling
- **claude crash/exit:** AgentRuntimeHost restarts with `--resume <sessionId>`; if resume fails (e.g. corrupt session), start fresh without `--resume` and log. Pending queued turns are re-injected after restart.
- **Boundary never arrives (stuck turn):** a max-wait timeout flushes queued turns at end-of-turn only; never inject mid-thinking (matches Slock's "gated" rationale: raw injection can collide with signed thinking blocks).
- **proxy → server failures:** surface as CLI stderr JSON with the right code prefix; agent can retry or report.
- **capability/ownership/membership violations:** proxy `403 CAPABILITY_DENIED`; server `403 AGENT_NOT_OWNED` / `404 not a member`.
- **draft fallback:** out of scope for slice 1 (no `--send-draft`); a failed send is a plain error.

## 10. Testing
**Unit:**
- stream-json boundary parser: feed canned stdout fixtures (init w/ session_id, assistant turn, result) → asserts session id captured + boundary events emitted.
- header renderer: message rows → exact `[target=… msg=… time=… type=…] @name: body` strings; self-authored filtering.
- mio CLI: arg parsing + env resolution + canonical/stderr formatting against a mock proxy.
- agent-proxy: capability gating (allowed vs denied), machine-token attachment, error mapping, against a mock MioServer.
- agentApiRoutes: `send` (ownership + membership 403/404, happy path returns id/seq), `history` (membership-gated), via the existing server test harness (supertest / StubURLProtocol-equivalent). Test DB via the project's hand-curated SQL discipline (NOT `migrate dev`).

**Integration (the acceptance test):** extend `mio-agent/src/simulation/headlessSim.ts` + `mioServerSetup.ts` to: boot a local MioServer + one agent, spawn a **real** `claude` stream-json session (or a stubbed runtime that speaks the stream-json protocol if real-claude CI is undesirable), post a human message, and assert **all three** spine conditions from §3: (a) a reply row authored by the agent appears within a timeout; (b) `InboxCoordinator.onInjected` fired for the inbound message before the reply; (c) no `mio message check` poll was issued for that message (spy the CLI/proxy). Both a real-claude variant (dev box) and a protocol-stub variant (CI) are provided. **Planning note:** before writing this test, read `mioServerSetup.ts` to confirm the booted server mounts the message + socket.io event routes and to size the agent-api route registration.

## 11. Open decisions resolved
- **mio CLI placement:** the `agentcli` subcommand of the existing single `mio-agent` bin/dispatcher (logic in `src/agentcli/`), reachable identically in npm and SEA modes. NOT a standalone npm package, NOT a second bin. Operator CLI stays in `src/cli/`.
- **Distribution: BOTH modes are first-class (user's choice), see §13.** npm/npx (`npx @miomioos/mio-agent`, CLI bundled) AND MioIsland-embedded (the existing `MioAgentDistribution.swift` downloads the SEA binary to `~/.mio/bin/mio-agent` + LaunchAgent `io.miomioos.mio-agent` + GUI panel). Slice 1 must not break either; the only mode-dependent code is the CliTransport wrapper exec line (§5.4).
- **Wake mechanism:** long-lived stream-json with gated stdin injection (option ② / faithful), not resume-per-message.
- **Wake transport:** the existing MioServer socket.io WS + per-channel seq catch-up, consumed by the daemon's existing `gateway/serverGateway.ts`/`wsClient.ts`. **No SSE; no new server real-time endpoint.** The agent-proxy carries only outbound CLI actions (`send`/`history`).
- **History cursor/anchor contract:** internal cursor = BigInt per-channel `seq`, **daemon-persisted per agent+channel in a NEW `agentInboxCursorStore.ts` (`<agentId>:<channelId>→seq`, modeled on `loopCursorStore.ts`; NOT `cursors.ts` = WS anchor, NOT `loopCursorStore` = channelId-only/collides); survives launch/restart**, never passed by the agent; agent-facing read anchors = message short ids (`msg=`) resolved server-side to seq. `check` → fan-out `after_seq` per member channel; `read` → `around`/`before`/`after` shortid windows. The `/history` route is single-channel (`?channel=<t>`); `check`'s cross-channel behavior is the daemon fanning out per channel, not a multi-channel route.
- **Capability mapping:** `send`→`send`; `check`+`read`→`read`.
- **Threads + DMs:** OUT of slice 1 (top-level `#channel` only; `dm:@peer` deferred — unspecified peer resolution). Target resolution is membership-anchored (see §5.7).
- **mcp-config in slice 1:** empty `{"mcpServers":{}}` (the `chat` runtime-actions MCP and `runtime_profile_migration_done` are deferred with the migration feature). `--strict-mcp-config` still passed so the agent gets no user-global MCP servers.
- **Reference version:** verified against `@slock-ai/daemon` 0.52.2 and 0.53.0 (launch args, disallowed-tools, gated delivery, header format, `/internal/agent-api/*` routes consistent across both).

## 12. Explicitly OUT of slice 1 (later sub-projects)
Tasks (create/claim/update, task=message), multi-agent runtime + PM orchestration, reply-routing beyond the single agent, reminders, action-prepare cards, **DMs (`dm:@peer`)**, **threads**, profile/react/attachments/search/channel-join, codex runtime, runtime-profile migration + the `chat` MCP, Windows wrappers, CodeLight iOS surfaces, **npm publish of `@miomioos/mio-agent`**. Each is its own spec.

## 13. Distribution — two first-class modes (user's choice)
The same mio-agent (daemon + `agentcli`) ships two ways; both write to and share `~/.mio/`, so a machine uses one at a time but either is valid.

| | npm / npx mode | MioIsland-embedded mode (already substantially built) |
|---|---|---|
| Acquire | **TARGET / not yet published** — `npx @miomioos/mio-agent` (`npm view` → E404 as of 2026-05-25); package bundles daemon + `agentcli`. Publishing is a slice-1+ task, not a current fact. | **CURRENTLY THE ONLY WORKING PATH** — `MioAgentDistribution.swift` downloads the **SEA single binary** from GitHub Releases `MioMioOS/mio-agent` (pinned, currently 0.1.0), SHA-256 + anti-rollback `required_fixes` gate (`machine-api-v1-prefix`, `socketio-control-path`), atomic install to `~/.mio/bin/mio-agent` |
| Runtime | node + `dist/cli/index.js` | single binary, **no node, no `dist/`** |
| Lifecycle | operator CLI (`mio-agent start/stop`) or manual | GUI `AgentSettingsTab.swift` → LaunchAgent `io.miomioos.mio-agent`, `launchctl bootstrap gui/<uid>` (NOT `user/<uid>`), health `127.0.0.1:7878`, socket `~/.mio/agent.sock` (Phase 2) |
| Config | `~/.mio/agent.json` | `~/.mio/agent.json` (same) |
| agent CLI reach | `mio` wrapper → `node <pkg>/dist/cli/index.js agentcli` | `mio` wrapper → `~/.mio/bin/mio-agent agentcli` |

**Slice-1 obligations for dual distribution (small):**
- The `agentcli` command (§5.6) is mode-agnostic code — it runs the same whether hosted by node or baked into the SEA binary. Wire it via a string-literal dynamic import (`await import('./commands/agentcli.js')`) so esbuild statically resolves and bundles it into the SEA (a non-literal import or a runtime `dist/`-relative path is the one thing that would silently drop it from the SEA bundle).
- CliTransport (§5.4) detects the daemon's own launch shape and writes the matching wrapper exec line. This is the ONLY mode-dependent slice-1 code.
- **SEA-reach smoke test (required, not manual):** add a step to `scripts/build-sea.mjs` (or CI after it) that runs the built binary as `mio-agent agentcli --help` (a no-network probe) and asserts exit 0. This is the single highest-risk dual-distribution failure (an import slip drops `agentcli` from the SEA while npm mode still works) — make it a build gate, not a hope.
- **`run` must start the new runtime host.** The MioIsland LaunchAgent plist runs `mio-agent run`. Slice 1 changes what `run` does (it must boot the AgentRuntimeHost + InboxCoordinator + agent-proxy, not the old dispatcher) — that is mio-agent work, not MioIsland work. The health server on `127.0.0.1:7878` (used by the GUI probe) must keep responding.

**Already-built in MioIsland — precise scope (verified by reading `MioAgentDistribution.swift` + `AgentSettingsTab.swift`):**
- **Real, do NOT rebuild:** the download/SHA-256/anti-rollback/atomic-install pipeline; the LaunchAgent lifecycle (install = create dirs + download + ad-hoc codesign + write plist + `launchctl bootstrap gui/$uid`; start = bootstrap-then-`kickstart -k`; stop = `bootout`); the status panel's **real** probes (`fileExists` for binary/config, `launchctl list` for loaded, `pgrep -x mio-agent` for process, real HTTP GET to `/health` for healthy) and the phase state machine; the plist (`[binaryPath, "run"]`, KeepAlive, RunAtLoad, ExitTimeOut 15, logs → `~/.mio/agent.log`).
- **Honestly-stubbed Phase 2 (NOT built — do not assume these exist):** IPC drain over `~/.mio/agent.sock` (`requestDrain` is a no-op `TODO(Phase2)`; stop goes straight to bootout); the socket lifecycle row (hard-shows "Phase 2 pending", ignores the probed `socketExists`); real-time status / log streaming; the "upcoming capabilities" rows (action execution, workroom, log streaming, auto-upgrade — all "soon"). These are correctly labeled as pending, not faked. Slice 1 does not depend on any of them.
- **Co-residency caveat (later concern, flagged so the planner doesn't assume it's solved):** both modes write `~/.mio/agent.json` + `~/.mio/bin/` and bind health `127.0.0.1:7878`; switching modes (npm↔MioIsland) or running both at once is NOT detected/guarded anywhere today. Out of scope for slice 1; do not assume mode-switching is handled.
