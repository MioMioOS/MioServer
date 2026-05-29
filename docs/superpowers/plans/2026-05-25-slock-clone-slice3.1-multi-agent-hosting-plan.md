# Slock Clone — Slice 3.1: Multi-Agent Hosting + Delivery Routing — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one daemon host N agent sessions concurrently, each receiving only the messages of channels it is a member of, each self-governing replies via the existing etiquette prompt.

**Architecture:** Generalize the slice-1 single-agent spine to N independent spines (one `startAgentSpine` per machine-owned agent discovered from the server). Add a per-agent channel-membership delivery filter in the inbox coordinator, sourced from a NEW agent-api endpoint. No central router — "who replies" stays in-prompt; concurrent task claims are de-duped by slice-2's `claimControlTaskCas`.

**Tech Stack:** TypeScript, Fastify + Prisma (MioServer), Node + tsx/SEA (mio-agent daemon), socket.io WS, vitest.

**Spec:** `MioServer/docs/superpowers/specs/2026-05-25-slock-clone-slice3.1-multi-agent-hosting-design.md`

**Hard constraints:**
- Repos are NOT git-tracked → **SKIP every commit step** (do not run `git`).
- MioServer integration tests: `npm run test:integration -- <paths>`; never `prisma migrate dev` (slice 3.1 adds NO migration — it only adds routes + a member-response field, no schema change). mio-agent: `npm test` + `npx tsc --noEmit`.
- Reuse, do not rebuild. Do NOT revive `agentLoopManager`/`replyGate`/`agentRouter` (the rejected central-router; stays dead).

---

## File Structure (decomposition)

**MioServer (Chunk A):**
- Modify `sources/control/.../memberRoutes.ts` — add `handle` (= `ControlAgent.name`, leading `@`) to the `/members` response.
- Create `sources/control/agentApi/agentApiChannels.ts` — `GET /internal/agent-api/channels` (agent's member channels). Register in `sources/api.ts` + `mio-agent/src/simulation/mioServerSetup.ts`.
- Test `sources/control/agentApi/agentApiChannels.integration.spec.ts`.

**mio-agent (Chunks B, C):**
- Modify `src/gateway/restClient.ts` — add `handle?` to `WorkroomMember`; add `getAgentChannels(agentId)` (GET /internal/agent-api/channels via the agent-proxy/machine token path) OR a gateway method.
- Modify `src/orchestrator/inboxDelivery.ts` — add the membership filter (injectable resolver + cache + invalidation on member events + fail-safe).
- Modify `src/cli/commands/run.ts` — `bootAgentSpine` → multi-spine boot; `deriveAgentWorkspace` per-agent; `MultiSpineHandle`.

**mio-agent (Chunk D):**
- Modify `src/simulation/mioServerSetup.ts` — seed 2 agents + 3 channels + per-agent `ControlChannelMember` rows + register `agentApiChannels`.
- Create `src/simulation/slice3RoundTrip.ts` — acceptance runner.

---

## Chunk A: MioServer — `/members` handle field + agent-api channels endpoint

### Task A1: `/members` response carries each agent's `handle`
**Why:** In multi-agent mode each hosted agent needs its OWN `@handle` (its `@mention` identity in the system prompt). `ControlAgent.name` is the canonical handle but the `/members` response omits it (it only returns `display_name`). bootAgentSpine currently takes the handle from config — wrong for N>1.

**Files:**
- Modify: `sources/control/<members dir>/memberRoutes.ts` (the `agents.map(...)` projection — currently returns `id, kind, display_name, role, status, machine_id, runtime, model`; `select` already includes `name`? confirm — schema has `name` required; the select at ~line 62 lists `displayName, name, ...`).
- Test: extend the existing memberRoutes spec (find it: `*memberRoutes*spec*`).

- [ ] **Step 1: Failing test** — assert the `/members` response for an agent includes `handle` equal to `@<name>` (leading `@`, derived from `ControlAgent.name`). Use the existing memberRoutes test harness/seed; add an agent with `name: 'Sparky'` and assert `member.handle === '@Sparky'`.
- [ ] **Step 2: Run fail** — `npm run test:integration -- sources/control/<...>/memberRoutes.integration.spec.ts` (or the unit spec if that's how it's tested). Expect FAIL (no `handle` key).
- [ ] **Step 3: Implement** — in the `agents.map`, add `handle: a.name?.startsWith('@') ? a.name : `@${a.name}`` (normalize a single leading `@`; `name` is required so no null). Keep `display_name` unchanged.
- [ ] **Step 4: Run pass.**
- [ ] **Step 5: (no git).**

### Task A2: `GET /internal/agent-api/channels` — the authenticated agent's member channels
**Why:** The delivery filter (Chunk B) needs "which channels is THIS agent a member of." The existing `GET /api/v1/workrooms/:wid/channels` is machine-scoped + returns all public channels → cannot answer per-agent membership (would collapse the isolation boundary). New agent-api read, anchored to the agent id.

**Files:**
- Create: `sources/control/agentApi/agentApiChannels.ts`
- Modify: `sources/api.ts` (register, sibling of `agentApiTasks` / `agentApiRoutes`, literal `/internal/agent-api/*`)
- Test: `sources/control/agentApi/agentApiChannels.integration.spec.ts`

- [ ] **Step 1: Failing integration test** — mirror `sources/control/agentApi/agentApiTasks.integration.spec.ts` boot+seed. Seed: a machine + an agent owned by it, that agent a `ControlChannelMember` of `#frontend` + `#general` but NOT `#backend` (seed `#backend` public too, to prove public≠auto-member). Then:
  - `GET /internal/agent-api/channels` (Authorization: Bearer <machineToken>, `X-Mio-Agent-Id: <agentId>`) → `200 { channels: [{id,name}, ...] }` containing exactly `#frontend` + `#general` (by name), NOT `#backend` (even though public).
  - missing/blank `X-Mio-Agent-Id` or agent not owned by the machine → `authorizeAgentApi` rejects (401/403, same codes as agentApiTasks).
  - an agent with zero memberships → `{ channels: [] }`.
- [ ] **Step 2: Run fail** — `npm run test:integration -- sources/control/agentApi/agentApiChannels.integration.spec.ts`. Expect FAIL (route not found / 404).
- [ ] **Step 3: Implement** `agentApiChannels.ts`:
  - Fastify plugin; `app.get('/internal/agent-api/channels', handler)`.
  - `const auth = await authorizeAgentApi(request)` (reuse from `agentApiAuth.ts`); on `!auth.ok` → `reply.code(auth.status).send({error:{code:auth.code,message:auth.message}})`.
  - Query (single include, mirror `agentApiTargets.ts` which uses `controlChannelMember` with `memberId`):
    ```ts
    const rows = await db.controlChannelMember.findMany({
      where: { memberId: auth.agent.id },
      select: { channel: { select: { id: true, name: true } } },
    });
    return reply.send({ channels: rows.map(r => r.channel) });
    ```
  - `authorizeAgentApi` returns `{ ok: true, machine, agent }` where `agent` is the full ControlAgent row → use `auth.agent.id` (confirmed against `agentApiAuth.ts`).
  - **No workroom scoping (deliberate):** the query returns ALL of the agent's member channels regardless of workroom. This is correct + simpler because the inbox coordinator only ever checks `channel_id`s that arrive on the ONE workroom WS it subscribes to — any cross-workroom channel in the set can never match an inbound from another workroom, so it's harmless. (Matches `agentApiTargets.ts`, which also does not pre-scope by workroom.) The spec's "in its workroom" phrasing is satisfied in effect by the coordinator's per-workroom subscription, not by the query.
- [ ] **Step 4: Run pass** + no regression: `npm run test:integration -- sources/control/agentApi`.
- [ ] **Step 5:** Register in `sources/api.ts` (`await app.register(agentApiChannels)`, alongside `agentApiTasks`). Typecheck `npx tsc --noEmit`. (no git.)

---

## Chunk B: mio-agent — per-agent channel-membership delivery filter

### Task B1: `WorkroomMember.handle` + a gateway `getAgentChannels` resolver
**Files:**
- Modify: `src/gateway/restClient.ts` — add `handle?: string | null` to `WorkroomMember`; add `apiGetAgentChannels(serverUrl, token, agentId)` → `GET /internal/agent-api/channels` with `Authorization: Bearer <token>` + `X-Mio-Agent-Id: <agentId>`, returns `{id,name}[]`.
- Modify the gateway wrapper (the `ServerGateway` class that exposes `getWorkroomMembers`/`getWorkroomChannels`) — add `getAgentChannels(agentId)`.
- **ALSO add `getAgentChannels(agentId: string): Promise<Array<{id:string;name:string}>>` to the `InboxGateway` interface in `src/orchestrator/inboxDelivery.ts`** (the subset interface used for DI, currently declaring subscribe/unsubscribe/getChannelMessages/getWorkroomChannels) — otherwise B2's default resolver, typed against `InboxGateway`, cannot call it.
- Test: extend `restClient.spec.ts` (mock fetch; mirror the **`apiGetWorkroomMembers`** test suite shape — correct URL, Auth header, response parse, non-2xx throws — PLUS an `X-Mio-Agent-Id` header assertion). (`apiGetWorkroomChannels` has no existing spec; use the members one as the template.)

- [ ] **Step 1: Failing test** — `apiGetAgentChannels` issues `GET .../internal/agent-api/channels` with the machine token + `X-Mio-Agent-Id: <agentId>` and returns the channels array; a non-2xx surfaces an error like the other restClient calls.
- [ ] **Step 2: Run fail.**
- [ ] **Step 3: Implement** mirroring `apiGetWorkroomMembers`/`apiGetWorkroomChannels` (same `apiRequest` + `authHeaders` helpers; add the `X-Mio-Agent-Id` header).
- [ ] **Step 4: Run pass** + `npm test` (no regression) + `npx tsc --noEmit`.
- [ ] **Step 5: (no git).**

### Task B2: membership filter in the inbox coordinator
**Files:**
- Modify: `src/orchestrator/inboxDelivery.ts` (`createInboxCoordinator` + its event handler ~line 222 where it currently checks `event.topic !== 'message.created'` and skip-self).
- Test: extend `inboxDelivery.spec.ts`.

**Design:**
- Add to `InboxCoordinatorOpts` (NOT `InboxCoordinatorDeps` — the real DI type is `InboxCoordinatorOpts`, line ~48, same place as `fetchMessage?`/`resolveChannelName?`) an injectable `resolveAgentChannels?: () => Promise<Set<string>>` (default: calls `gateway.getAgentChannels(selfAgentId)` → `new Set(channels.map(c => c.id))`).
- **Resolve eagerly at `start()`** and store the promise as `membershipReady`; ALL event handlers `await membershipReady` before checking. On invalidation, REPLACE `membershipReady` with a fresh call so subsequent awaits pick up the new set. (Do NOT resolve lazily-on-first-event — that races: two rapid events both miss the cache and double-resolve.)
- **Insertion point (exact):** in the handler, after the `if (!channelId || !messageSeq) return` guard (line ~238) and **BEFORE the `doFetch` REST call (line ~246)** — NOT before skip-self (skip-self is at line ~260, AFTER the fetch; putting the membership check before the fetch avoids a wasted REST round-trip per non-member event): `const membership = await membershipReady; if (!membership.has(channelId)) return;`.
- **Invalidation:** also handle `event.topic === 'channel.member_added' | 'channel.member_removed'`. Confirmed payload shape (from `channelRoutes.ts`): `{ channel_id, member_id, added_by|removed_by }`. Guard: only invalidate when `payload.member_id === selfAgentId` (these events DO reach this coordinator — the server broadcasts them workroom-wide via `workroomBroadcaster`, same WS the coordinator subscribes to; `WorkroomEvent.topic` is typed `string` so string comparison is fine).
- **Fail-safe:** if `resolveAgentChannels` rejects, treat membership as EMPTY for the current event (do NOT deliver — no cross-channel leak) AND replace `membershipReady` with a retrying resolve (backoff) so a transient boot failure self-heals instead of muting the agent forever; log each failure. Never deliver-all on failure.

- [ ] **Step 1: Failing tests** (mock gateway + host):
  - membership `{#general}`; a `message.created` in `#general` → injected (host.enqueue called); a `message.created` in `#frontend` (not in set) → NOT injected.
  - skip-self still holds within a member channel.
  - `channel.member_added` event → cache invalidated → a subsequent message in the newly-added channel IS injected (resolver returns the larger set on re-call).
  - `resolveAgentChannels` rejects → message NOT injected (fail-safe), error logged; a later successful resolve → injected.
  - resolver is injectable (no real HTTP in tests).
- [ ] **Step 2: Run fail.**
- [ ] **Step 3: Implement** the filter + cache + invalidation + fail-safe. Keep the RFC-5424 render + cursor + gated inject path unchanged.
- [ ] **Step 4: Run pass** + `npm test` + `npx tsc --noEmit`.
- [ ] **Step 5: (no git).**

---

## Chunk C: mio-agent — multi-spine boot

### Task C1: per-agent workspace — pass each agent's handle to `deriveAgentWorkspace` (NO signature change)
**Why no signature change:** the collision is solely because the current caller passes `aa.handle` (the single config handle) for every agent. `deriveAgentWorkspace(handle, machineId, mioDir)` already composes a `<safeHandle>-<safeMachine>` path, so passing each agent's DISTINCT handle yields distinct dirs. `ControlAgent.name` (→ handle) is server-unique, so handles differ. **Do NOT change `deriveAgentWorkspace`'s signature or return format** — the existing I1 tests (`run.spec.ts` ~724–753) assert the exact `agentId`/path format and must stay green.

**Files:**
- Modify: `src/cli/commands/run.ts` (only the bootAgentSpine CALLER at line ~516 — done as part of C2's loop; this task is the test that proves per-agent dirs).
- Test: extend `run.spec.ts`.

- [ ] **Step 1: Failing test** — drive `bootAgentSpine` (or a small helper) with two members whose handles differ → the two `startSpineFn` calls receive two DISTINCT `workingDirectory` values. (Today, passing `aa.handle` for both → identical dirs → fails.)
- [ ] **Step 2: Run fail.**
- [ ] **Step 3: Implement** — in the C2 loop, call `deriveAgentWorkspace(agentMember.handle ?? ('@' + agentMember.display_name), config.machine_id, mioDir)` per agent (NOT `aa.handle`). No change to `deriveAgentWorkspace` itself.
- [ ] **Step 4: Run pass** — and confirm the existing I1 `deriveAgentWorkspace` tests still pass (unchanged signature).
- [ ] **Step 5: (no git).**

> **Caveat to note in code comment:** the fallback `'@'+display_name` only fires if `handle` is absent (older server pre-A1). If two agents shared a `display_name` AND lacked handles they'd collide — acceptable since A1 guarantees `handle` is present going forward; server-unique `name` makes the primary path safe.

### Task C2: `bootAgentSpine` → boot N spines (`MultiSpineHandle`)
**Files:**
- Modify: `src/cli/commands/run.ts` (`bootAgentSpine` lines 439–547; add a `MultiSpineHandle`).
- Test: extend `run.spec.ts`.

**Design:**
- Change `members.find(...)` → `const agentMembers = members.filter(m => m.kind==='agent' && m.machine_id===config.machine_id)`.
- Scope the OUTER `try/catch` (lines ~454–546) to cover only the token read + `getWorkroomMembersFn`. The PER-AGENT body runs in the loop with its OWN per-iteration try/catch so one agent's failure does not abort the others (note: `startAgentSpine` cleans up + RETHROWS on partial startup, so the loop-body catch is what keeps siblings alive).
- If `agentMembers` empty → log (as today) + return undefined.
- For EACH `agentMember` (own try/catch): C3 runtime normalize/probe → skip with the documented-gap log on codex/unsupported/unavailable; per-agent workspace via C1 (`agentMember.handle ?? '@'+display_name`); mkdir; displayName/description/model from member with fallbacks; `startSpineFn({... agentId: agentMember.id, agentHandle: agentMember.handle ?? '@'+display_name, ...})`; push the returned handle. On throw → log + continue.
- **Cross-chunk dep:** `agentMember.handle` requires B1's `WorkroomMember.handle` addition. Implement B (esp. B1) BEFORE C — otherwise `.handle` resolves to `unknown` via the `[key:string]:unknown` index signature and `npx tsc --noEmit` errors on C2. (Execution order already runs A→B→C→D.)
- **`MultiSpineHandle` shape (IMPORTANT — acceptance harness depends on it):**
  ```ts
  interface MultiSpineHandle {
    handles: AgentSpineHandle[];   // per-agent handles — the round-trip wires handle.coord.onInjected(...) per agent
    stop(): Promise<void>;          // stops each child handle.stop() idempotently, best-effort each
  }
  ```
  Exposing `handles` (not just `stop()`) is REQUIRED so `slice3RoundTrip.ts` can register a per-agent injection recorder on each coordinator (assertions a/d). `runDaemon` itself only calls `.stop()` (verified — consumer at run.ts ~698), so adding `handles` is backward-safe.
- If zero started → return undefined.
- `BootAgentSpineDeps` unchanged except behavior. Keep `aa.enabled`/`aa.workroom_id` as the only config fields consulted.

- [ ] **Step 1: Failing tests:**
  - members = [agentA(machine), agentB(machine), human, agentC(otherMachine)] → `startSpineFn` called exactly for A and B (right ids); not human, not C. Returns a `MultiSpineHandle` with `handles.length===2` whose `stop()` stops both.
  - agentB's `startSpineFn` throws → A still started; returns a `MultiSpineHandle` with `handles.length===1` (A); the failure is logged; daemon does not throw.
  - agentB.runtime='codex' → only A started (codex skipped with the documented-gap log), per-agent C3.
  - N=1 (one machine agent) → same as before (legacy parity).
  - the two started agents got DISTINCT workspaces + distinct `selfAgentId`.
- [ ] **Step 2: Run fail.**
- [ ] **Step 3: Implement** the loop + `MultiSpineHandle`. Reuse the existing C3 normalize/probe + startSpine call shape per agent.
- [ ] **Step 4: Run pass** + `npm test` + `npx tsc --noEmit`. Confirm `run.spec.ts` legacy tests still pass.
- [ ] **Step 5: (no git).**

---

## Chunk D: acceptance runner + regression

### Task D1: extend `mioServerSetup.ts` for multi-agent
**Files:**
- Modify: `src/simulation/mioServerSetup.ts` (runs in MioServer tsx context via `@/` alias; excluded from mio-agent typecheck).

- [ ] **Step 1:** Register `agentApiChannels` (`import { agentApiChannels } from '@/control/agentApi/agentApiChannels'; await app.register(agentApiChannels);`) alongside the slice-2 task routes.
- [ ] **Step 2:** Seed 3 channels in the sim workroom: `#frontend`, `#backend`, `#general`. Seed agent A (machine-owned) as `ControlChannelMember` of `#frontend` + `#general`; agent B (machine-owned — reuse the existing `AGENT2_ID`) of `#backend` + `#general`. Both agents' `ControlAgent.name` is already set (`sim-agent` / `sim-agent-2`) so `/members` returns distinct handles after A1. Extend `SimSetupPayload` in `simServerBoot.ts` (IS typechecked) with explicitly-named fields: `frontendChannelId`, `backendChannelId`, `generalChannelId` (keep the existing `channelId`/`agentId`/`agent2Id`). Return them from setup.
- [ ] **Step 3:** Typecheck the harness-adjacent typed files (`simServerBoot.ts`). (no git.)

### Task D2: `slice3RoundTrip.ts` acceptance runner
**Files:**
- Create: `src/simulation/slice3RoundTrip.ts` (model on `slice2RoundTrip.ts`).

**Asserts (a–d), driven through the REAL daemon path:**
- Boot sim MioServer (D1 setup) → boot the multi-spine daemon (`bootAgentSpine` → `MultiSpineHandle`). Iterate `handle.handles` (per-agent `AgentSpineHandle`s — exposed by C2) and register a per-agent injection recorder via `handle.coord.onInjected(...)` for each, into a per-agent array keyed by agentId. THIS is how a/d become observable.
- **Extend `TestGateway`** (reused from slice2) with `async getAgentChannels(agentId)` → real HTTP `GET ${serverUrl}/internal/agent-api/channels` with `Authorization: Bearer ${machineToken}` + `X-Mio-Agent-Id: ${agentId}`, returns `{id,name}[]`. This satisfies B1's updated `InboxGateway` interface AND ensures each coordinator resolves membership through the REAL §4.0 endpoint (NOT Prisma rows) — the spec §7 requirement.
- (a) Post a human message in `#frontend` → assert it lands in **A's recorder only** (B's recorder stays empty for it).
- (b) Post a human message in `#general` → assert it lands in **BOTH** A's and B's recorders.
- (c) In `#general`, drive both agents (stub) to `mio task claim` the same task → exactly one 200, the other 409 `TASK_CLAIM_CONFLICT` (real wrapper→proxy→agent-api→claimControlTaskCas; reuse slice2's second-agent 409 path).
- (d) Assert B's recorder NEVER contains any `#frontend` content across the whole run (cross-channel isolation).
- Stub variant = hard gate (exit 0 only if a–d all pass; `assertPass`/`failCount` + `process.exit`). Real-claude variant (`MIO_SPINE_RUNTIME=claude`) = best-effort on the agent's autonomous behavior, but (a)/(d) routing + (c) 409 stay hard (they're daemon/server mechanics, not claude judgment).

- [ ] **Step 1:** Write the runner: reuse simServerBoot + the C2 multi-spine boot + stub runtime from slice2; extend `TestGateway` with `getAgentChannels` (above); wire a per-agent injection recorder via `handle.handles[i].coord.onInjected(...)`. 
- [ ] **Step 2:** Run stub: `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice3RoundTrip.ts` → exit 0, a–d green. (Prepare the test DB if needed: in MioServer `npm run test:db:setup`; no new migration in this slice.)
- [ ] **Step 3:** Attempt real-claude once (`MIO_SPINE_RUNTIME=claude ...`); report routing/isolation (a/d) + 409 (c) hard results + any best-effort notes. If no real claude available here, report that (don't fake).
- [ ] **Step 4: (no git).**

### Task D3: full regression
- [ ] **Step 1:** mio-agent `npm test` (all green, report count) + `npx tsc --noEmit` clean.
- [ ] **Step 2:** `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice1RoundTrip.ts` → 10/10; `... slice2RoundTrip.ts` → stub 13/13 (N=1 parity intact).
- [ ] **Step 3:** MioServer `npm run test:integration -- sources/control/agentApi sources/control/tasks` (no regression) + `npx tsc --noEmit`.
- [ ] **Step 4: (no git).**

---

## Reuse map (do not rebuild)
| Need | Reuse |
|---|---|
| per-agent spine (transport/host/coord) | `startAgentSpine` — generalize the boot only |
| agent-api route + auth shape | `agentApiTasks.ts` + `authorizeAgentApi` (`agentApiAuth.ts`) |
| per-agent membership query | `agentApiTargets.ts` `controlChannelMember.findMany({where:{memberId}})` |
| wake/inject/render/skip-self/cursor | `inboxDelivery` — ADD membership filter only |
| runtime select (claude/codex/unknown) | C3 `normalizeRuntime` + probe (run.ts) — apply per agent |
| task claim de-dup (409) | `claimControlTaskCas` (slice 2) — no new code |
| acceptance harness | `mioServerSetup` + `slice2RoundTrip` — extend |
| membership-change signal | `channel.member_added`/`channel.member_removed` WS events |
| ephemeral per-agent proxy port | `registerAgentProxy` `listen(0)` — already isolated, regression-confirm only |
