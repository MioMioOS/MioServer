# Slock Clone — Slice 3.1: Multi-Agent Hosting + Delivery Routing — Design

**Date:** 2026-05-25
**Status:** Design (approved by user, pending spec review)
**Repos:** `mio-agent` (daemon-side, the bulk) **plus a small `MioServer` addition** — a per-agent channel-membership endpoint (see §4.0). The acceptance harness boots `MioServer` via tsx and MUST drive that real endpoint (not only Prisma-seeded membership rows).
**Builds on:** Slice 1 (agentic-session spine) + Slice 2 (task model, claim-before-work). Both deployed to prod + acceptance-proven.

---

## 1. Context & the gap

The Slock clone runs each agent as a **full long-lived `claude`/`codex` session** woken by socket.io, acting only through an injected `mio` CLI → local agent-proxy → MioServer `/internal/agent-api/*`. There is **no central router**: "who replies" is self-governed by each agent via reply-etiquette baked into its system prompt.

**What already exists (slices 1+2):**
- Self-governing reply etiquette is ALREADY in `src/runtimes/systemPrompt.ts` (reply when @mentioned / addressed / can-do-the-work; respect ongoing conversations; only the worker reports; skip idle narration; mention others not yourself).
- `claim-before-work` + the full task model (`mio task …`, agent-api tasks, `claimControlTaskCas` CAS that returns a 409 conflict for double-claims).
- The single-agent spine: `startAgentSpine` stands up, per agent, a `prepareCliTransport` (mioDir + bound proxy socket + spawnEnv), a `claudeStreamHost` subprocess, and an `inboxCoordinator` (gateway WS subscription → render RFC-5424 header → gated injection). `bootAgentSpine` resolves the ONE `ControlAgent` owned by this machine_id in the workroom and starts one spine.

**The gap (this slice):** the daemon boots exactly ONE agent (`config.autonomous_agent`, singular). Multi-agent autonomy needs the daemon to host **N agent sessions concurrently**, and inbound messages must be **routed to the right agent(s) by channel membership** (`§5: channels are the isolation boundary`). The legacy multi-agent path (`agentLoopManager` + `replyGate` + `agentRouter` — a central router with @handle matching + quiet window) is the explicitly-rejected "wrong direction" and stays disabled; this slice does multi-agent the faithful way: N independent self-governing spines.

This slice is **3.1** — the foundational mechanism. PM decomposition/coordination behavior is **3.2** (out of scope here).

---

## 2. Goal

One daemon hosts N agent sessions; each inbound message is delivered only to the hosted agents that are members of that message's channel; each agent self-governs whether to reply via the existing etiquette prompt; concurrent task claims are de-duplicated by the existing `claimControlTaskCas`.

---

## 3. Key decisions (approved)

### 3.1 Agent set = server-discovered (not config-listed)
The daemon boots one spine per `ControlAgent` whose `machine_id` == this machine, in the configured workroom. Identity/handle/model/description/runtime come from the **member record** (`WorkroomMember` already carries `display_name`, `description`, `model`, `runtime`, `machine_id`). The server is the single source of truth; config does NOT re-list agents.

- `config.autonomous_agent` (singular) is retained for backward compatibility and the existing acceptance harnesses; it is normalized into the same code path. When present + enabled, it still names the workroom (and the existing single-agent behavior is the N=1 case of the generalized boot).

### 3.2 Delivery filtering = per-agent channel membership
Each hosted agent's `inboxCoordinator` delivers only `message.created` events for channels that agent is a member of (plus the existing skip-self). Membership is keyed off **`ControlChannelMember` rows (`memberId === agentId`)** — the same anchor `resolveAgentChannelTarget` uses — for BOTH public and private channels (a public channel does NOT auto-make an agent a member for delivery purposes; an agent receives a channel's traffic iff it has a member row there). Within a delivered channel, the agent decides reply/claim/stay-silent via the etiquette prompt. Deliver-all-then-prompt-filter is rejected (violates the channel isolation boundary, leaks cross-channel content, multiplies token cost).

> ⚠️ **Feasibility correction (from spec review):** the existing `GET /api/v1/workrooms/:wid/channels` is anchored to **machine.id** and returns all public channels unconditionally — it CANNOT tell the daemon which channels a specific agent is a member of, and would collapse the isolation boundary (every co-hosted agent would see every public channel). Resolving per-agent membership therefore requires the new MioServer endpoint in §4.0. This is the slice's one load-bearing server change.

---

## 4. Components & responsibilities

### 4.0 MioServer — per-agent channel-membership endpoint (NEW, load-bearing)
The daemon must be able to fetch, for a given agent it hosts, the set of channels that agent is a member of. No such endpoint exists today.

- **Endpoint:** `GET /internal/agent-api/channels` (agent-api family, behind `authorizeAgentApi` = machine token + `X-Mio-Agent-Id`), returning `{ channels: [{ id, name }] }` for the channels where the **authenticated agent** (the `X-Mio-Agent-Id`) has a `ControlChannelMember` row in its workroom. Reuse the `controlChannelMember.findMany({ where: { memberId: agent.id } })` pattern already in `agentApiTargets.ts`; join to channel id+name. This keeps membership anchored to the agent id (correct boundary) and to the machine that owns the agent (authorizeAgentApi already enforces machine↔agent ownership).
- Why agent-api (not the public `/api/v1` channels route): the daemon already holds the machine token + per-agent `X-Mio-Agent-Id` for every action; this is an agent-scoped read, consistent with slice-1/2 agent-api endpoints, and avoids changing the machine-scoped public channels route's contract.
- Register it alongside the other agent-api routes (literal `/internal/agent-api/*`), and in the acceptance harness `mioServerSetup.ts`.

### 4.1 `bootAgentSpine` → multi-spine boot (`src/cli/commands/run.ts`)
- Resolve ALL `ControlAgent`s owned by this `machine_id` in the workroom (from `getWorkroomMembersFn`, filtering `kind==='agent'` + `machine_id===config.machine_id`), instead of just the first match.
- For each resolved agent, derive a per-agent working directory **from that agent's server identity (handle), NOT from the single config handle** and call `startAgentSpine` with that agent's id/handle/displayName/description/model/runtime. (`deriveAgentWorkspace(handle, machineId, mioDir)` already composes a `<safeHandle>-<safeMachine>` path; passing each agent's DISTINCT server handle — `ControlAgent.name` is server-unique — yields distinct workspaces with NO signature change. The bug today is solely that the caller passes the single `config.autonomous_agent.handle` for every agent.)
- **Config fields consulted in multi-agent mode:** only `config.autonomous_agent.enabled` (gates whether to boot at all) and `config.autonomous_agent.workroom_id` (names the workroom to enumerate). The other singular fields (`handle`, `channel_id`, `quiet_seconds`, `max_replies_per_window`, `window_seconds`) become vestigial under server-discovered agents — per-agent `displayName`/`description`/`model`/`runtime` come from each `WorkroomMember`. (Legacy N=1 behavior is preserved as the special case where the server returns exactly one machine-owned agent.)
- Per-agent boot is **best-effort + isolated**: one agent failing to start (e.g. runtime unavailable per C3, or a spawn error) logs a clear error and does NOT prevent the others from starting. Return a collection of handles (a `MultiSpineHandle` whose `stop()` stops each child spine idempotently).
- The C3 runtime-detection seam applies per agent (claude → start; codex/unknown → documented-gap log + skip that agent).

### 4.2 Per-agent isolation (`startAgentSpine` — already mostly parameterized)
Each spine must have fully independent, non-colliding resources:
- **Working directory:** `<base>/agents/<agentId>/` (own cwd + MEMORY.md). The single-agent default workspace derivation generalizes to per-agent.
- **mioDir + injected `mio` wrapper + mcp-config + system-prompt.md:** already per-agent (keyed by agentId/launchId in `prepareCliTransport`).
- **Proxy port:** ALREADY isolated per agent — `registerAgentProxy` binds `127.0.0.1:0` (OS-assigned ephemeral port) per launch and the per-agent wrapper points at the resolved URL. No change needed; N agents cannot collide by construction. (A `server.listen` bind failure for one agent still fails that agent's boot best-effort while others continue — see §6.)
- **claude subprocess:** one per agent.
- **cursor store:** per agent+channel (already keyed by agentId).

### 4.3 Per-agent channel-membership delivery filter (`src/orchestrator/inboxDelivery.ts` / `inboxCoordinator`)
- Add a membership-scoped predicate: the coordinator resolves the set of channel ids the agent is a member of, and SKIPS `message.created` events whose `channel_id` is not in that set (in addition to skip-self).
- **Membership source (explicit):** the NEW agent-api endpoint from §4.0 (`GET /internal/agent-api/channels`, machine token + this agent's `X-Mio-Agent-Id`) → the channel ids where this agent has a `ControlChannelMember` row. The resolver is injectable for tests. This does NOT reuse the channel-name path (`getWorkroomChannels` is machine-scoped + all-public and cannot answer per-agent membership — see §3.2 correction).
- **Caching + freshness (committed, not deferred):** resolve the membership set at coordinator start; **invalidate the cache on the `channel.member_added` / `channel.member_removed` WS events** (already broadcast by the server on the same workroom WS the coordinator subscribes to) so an agent added to a channel mid-session starts receiving its traffic without a restart. On a re-resolve triggered by those events, re-fetch via §4.0.
- **Resolution failure = fail safe:** if the membership set cannot be resolved (endpoint error at boot or on invalidation), deliver NOTHING for that agent (never fall back to delivering all — no cross-channel leak) AND retry with backoff until it resolves. Log each failure.

### 4.4 De-duplication (no new code)
Concurrent claims of the same task by multiple hosted agents are resolved by Slice 2's `claimControlTaskCas` (CAS on `ownerInstanceId IS NULL`): exactly one agent wins; the others receive 409 `TASK_CLAIM_CONFLICT`, which their CLI surfaces and the etiquette prompt handles ("if claim fails, move on"). This slice only must NOT regress that path.

---

## 5. Data flow

```
server WS (workroom) ──message.created──> [each hosted agent's inboxCoordinator]
   │
   ├─ skip if sender === selfAgentId            (existing)
   ├─ skip if channel_id ∉ agent's memberships  (NEW — 3.1 delivery routing)
   ├─ fetch message, render RFC-5424 header      (existing)
   ├─ persist inbox cursor (agentId, channelId)  (existing)
   └─ gated inject into that agent's claudeStreamHost (existing)
        │
        └─ agent self-governs via etiquette prompt → maybe `mio message send` / `mio task claim` …
             └─ injected mio wrapper → that agent's proxy (X-Mio-Agent-Id) → agent-api
```

N coordinators subscribe to the same workroom WS; each independently filters for its own agent. No shared mutable routing state, no central router.

---

## 6. Error handling

- **Per-agent boot failure** → log + skip that agent; other agents unaffected; daemon stays up.
- **Per-agent claude crash** → existing claudeStreamHost crash-loop bound + restart applies per agent; one agent's crash does not affect others.
- **Membership resolution failure** → fail safe: deliver NOTHING for that agent (never deliver-all — no cross-channel leak) AND retry with backoff until resolved; log each failure. (Committed decision, see §4.3 — not "choose later".)
- **Membership staleness** → invalidate + re-resolve on `channel.member_added`/`channel.member_removed` WS events (§4.3); the only residual window is between an event and its re-fetch, which is bounded and self-healing.
- **Proxy bind failure** → ephemeral ports make collision impossible; a rare `listen` failure for one agent fails that agent's boot best-effort, others continue.
- **Shutdown** → `MultiSpineHandle.stop()` stops each child spine (coord → host → proxy) idempotently; partial-startup cleanup mirrors the existing single-spine try/catch.

---

## 7. Testing

### Unit
- **MioServer §4.0 endpoint** (`agentApiChannels` integration spec, mirroring agentApiTasks): an agent with member rows in #frontend + #general → `GET /internal/agent-api/channels` returns exactly those two (id+name); a channel the agent is NOT a member of is absent (incl. a public channel it lacks a member row in — proves agent-anchored, not all-public); not-the-machine's agent → 403/authorizeAgentApi rejects.
- `bootAgentSpine` multi: given members with 2 machine-owned agents (+ a human + an other-machine agent), starts exactly 2 spines with the right ids; an other-machine/human member is not started. One agent's `startSpineFn` throwing → the other still starts (best-effort), returns 1 handle + logs the failure. N=1 (legacy `autonomous_agent`) still works. Per-agent workspace derived from each member's id/handle (two agents → two distinct dirs, no collision on the config handle).
- `inboxCoordinator` membership filter: a `message.created` in a non-member channel is NOT injected (host receives nothing); a member-channel message IS injected; skip-self still holds; the membership resolver is injectable; a `channel.member_added` event invalidates the cache so a newly-added channel's next message IS injected; resolution failure → nothing injected (fail-safe), not deliver-all.
- Per-agent isolation: two spines get distinct working dirs + distinct ephemeral proxy ports. (Proxy-port distinctness is a REGRESSION confirmation of existing `listen(0)` behavior, not new work.)

### Acceptance — `src/simulation/slice3RoundTrip.ts` (modeled on slice2RoundTrip)
Boot the sim MioServer; seed 2 agents owned by the test machine: A (member of #frontend + #general), B (member of #backend + #general). Boot the multi-spine daemon. Assert:
- (a) a human message in **#frontend** is injected into **A only** (B's host receives nothing — channel isolation).
- (b) a human message in **#general** is injected into **both** A and B (each then self-governs).
- (c) a task in #general claimed by both → exactly one wins; the other gets 409 (claimControlTaskCas), real path through wrapper→proxy→agent-api.
- (d) B never receives any #frontend content (cross-channel isolation, asserted explicitly).
- Stub variant = deterministic hard gate; real-claude variant (`MIO_SPINE_RUNTIME=claude`) = best-effort (per the slice-2 precedent for real-claude non-determinism).
- The harness (`mioServerSetup.ts`) extends to seed multiple agents + multiple channels + per-agent `ControlChannelMember` rows, register the §4.0 endpoint, and reuse the slice-2 task endpoints. **The membership filter in the round-trip MUST resolve via the real §4.0 endpoint** (not read Prisma-seeded rows directly) — otherwise the test passes while the daemon's real fetch path is broken. The Prisma seeding sets up the rows; the daemon learns them through the endpoint.

### Regression
- `slice1RoundTrip.ts` (10/10) and `slice2RoundTrip.ts` (stub 13/13) still pass — the N=1 path is unchanged behavior.
- mio-agent `npm test` + `npx tsc --noEmit` green.

---

## 8. Out of scope (explicit)

- **PM decomposition/coordination behavior** (a PM-role agent splitting a goal into phase-grouped tasks + @mentioning teammates) — that is Slice 3.2.
- **@mention-based wake priority** within a channel — channel-membership delivery + the etiquette prompt already cover correct reply targeting; an @mention fast-path is an optimization, not needed for 3.1.
- **Cross-machine agent coordination** — co-hosting on one daemon is the MioIsland target form; cross-machine works for free via the shared server (no new mechanism).
- **Cheap pre-filter to avoid N claude turns per channel message** — the faithful self-governing model runs one turn per member agent per channel message; a cost optimization (cheap classifier before waking claude) is a possible future slice, not 3.1.
- **Reviving `agentLoopManager`/`replyGate`/`agentRouter`** — the rejected central-router approach stays disabled/dead.

---

## 9. Reuse map (do not rebuild)

| Need | Reuse from |
|---|---|
| Per-agent spine (transport/host/coord) | `startAgentSpine` (slice 1) — generalize the boot, not the spine |
| Wake/inject + RFC-5424 render + skip-self + cursor | `inboxDelivery`/`inboxCoordinator` (slice 1) — ADD membership filter |
| Agent identity (handle/model/description/runtime/machine_id) | `WorkroomMember` (slice 1/2) |
| Runtime selection (claude/codex/unknown) | C3 runtime-detection seam (slice 2) — applies per agent |
| Task claim de-dup (409 on double-claim) | `claimControlTaskCas` (slice 2) |
| Acceptance harness (sim MioServer boot + task endpoints) | `mioServerSetup` + `slice2RoundTrip` (slice 1/2) — extend for multi-agent + §4.0 |
| Reply etiquette / claim-before-work | `systemPrompt` (slice 2) — already present, no change |
| Per-agent membership query (NEW §4.0) | model on `agentApiTasks` route shape + `agentApiTargets.ts`'s `controlChannelMember.findMany({where:{memberId}})` |
| Membership-change signal | existing `channel.member_added`/`channel.member_removed` WS events (same workroom WS the coordinator already subscribes to) |
