# Slock Clone — Slice 3.2: PM Orchestration (decompose + delegate) — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PM-role agent, given a goal in a channel, decomposes it into multiple delegated tasks and @mentions teammates; worker agents claim + execute — all via prompt behavior on the existing multi-agent + task mechanics.

**Architecture:** Pure prompt layer in `mio-agent`: surface the structured `role` (already on the member record) into the system prompt, and add an "Orchestration & delegation" prompt section (DRY-referencing the existing Tasks / claim-before-work / reply-etiquette sections). No MioServer change, no schema change. Acceptance extends the Slice-3.1 multi-agent harness.

**Tech Stack:** TypeScript, Node + tsx, vitest (mio-agent).

**Spec:** `MioServer/docs/superpowers/specs/2026-05-25-slock-clone-slice3.2-pm-orchestration-design.md`

**Hard constraints:**
- Repos NOT git-tracked → **SKIP every commit step** (never run `git`).
- mio-agent: `npm test` + `npx tsc --noEmit`. No MioServer code/schema change in this slice.
- Reuse, do not rebuild. Do NOT revive agentLoopManager/replyGate/agentRouter.

---

## File Structure
**Chunk A (prompt + role thread):**
- Modify `src/runtimes/systemPrompt.ts` — `SystemPromptCtx` gains `role?: string`; render a role line in "Current Runtime Context"; add an "Orchestration & delegation" section after "Tasks".
- Modify `src/cli/commands/run.ts` — `AgentSpineDeps` gains `role?`; `startAgentSpine` sets `runtimeCtx.role`; `bootAgentSpine`'s multi-spine loop passes `agentMember.role` per agent.
- Tests: `src/runtimes/systemPrompt.spec.ts`, `src/cli/commands/run.spec.ts`.

**Chunk B (acceptance):**
- Modify `src/simulation/stubStreamRuntime.ts` — channel-aware (parse `target=#<name>`); add decompose + claim branches behind a per-spine role discriminator.
- Modify `src/simulation/mioServerSetup.ts` — set distinct roles (pm / engineer) on the two seeded agents (already members of #general from 3.1).
- Create `src/simulation/slice3_2RoundTrip.ts` — the orchestration acceptance runner.
- (Maybe) Modify `src/simulation/simServerBoot.ts` if a new payload field is needed.

---

## Chunk A: role threading + orchestration prompt section

### Task A1: thread `role` into the system prompt context
**Files:** Modify `src/runtimes/systemPrompt.ts` + `src/cli/commands/run.ts`; Test `systemPrompt.spec.ts` + `run.spec.ts`.

- [ ] **Step 1: Failing test (systemPrompt):** `buildSystemPrompt({...ctx, role:'pm'})` output contains a role line (e.g. matches `/Your role on this team:\s*\*\*pm\*\*/` or similar stable substring); `buildSystemPrompt({...ctx, role:''})` (empty) does NOT contain that line (omitted on empty/whitespace). Mirror the existing systemPrompt.spec assertion style.
- [ ] **Step 2: Run fail** (`npx vitest run src/runtimes/systemPrompt.spec.ts`).
- [ ] **Step 3: Implement (systemPrompt.ts):**
  - Add `role?: string;` to `SystemPromptCtx` (after `description`, with a doc comment: structured team role — ops|pm|engineer|designer|researcher|other; surfaced so the agent knows its lane).
  - Destructure `role` in `buildSystemPrompt`. In the "Current Runtime Context" block (after the `Your stable Mio @mention handle is …` line, ~line 61), conditionally render: ``role && role.trim() ? `\nYour role on this team: **${role.trim()}**.` : ''``. (Keep the "Initial role" / `description` section unchanged — role is the structured lane, description is the persona seed; both coexist.)
- [ ] **Step 4: Run pass.**
- [ ] **Step 5 (run.ts threading):**
  - `AgentSpineDeps` (the `startAgentSpine` deps interface) gains `role?: string`.
  - In `startAgentSpine`, add `role` to the explicit `deps` destructure (~line 160-173 — the function destructures specific fields, NOT `...rest`, so `role` must be named there) AND when building `runtimeCtx` (the `AgentRuntimeContext` object, ~line 202-212 — the SAME object that gets `handle`/`displayName`/`description`), add `role` (NOT model — model goes to createClaudeStreamHost, not runtimeCtx).
  - In `bootAgentSpine`'s per-agent loop (Slice 3.1), pass `role: agentMember.role` into the `startSpineFn({...})` call (alongside the existing `agentHandle`/`displayName`/`description`/`model`). `WorkroomMember.role` is already typed + returned by `/members` — no server change.
- [ ] **Step 6: Failing+passing test (run.spec):** extend the existing "(server-fields) propagates display_name, description, model" multi-spine test to also assert `spineDeps.role` equals the member's role (the member fixture already has a `role` field). Run pass.
- [ ] **Step 7: (no git).** `npx tsc --noEmit` clean.

### Task A2: "Orchestration & delegation" prompt section
**Files:** Modify `src/runtimes/systemPrompt.ts`; Test `systemPrompt.spec.ts`.

- [ ] **Step 1: Failing test:** `buildSystemPrompt(ctx)` output contains the orchestration guidance — assert (a) the section heading itself `## Orchestration & delegation` (so content can't accidentally land under the wrong section + still pass), plus stable substrings for: (i) decomposition ("break it into" / "one per subtask" / multiple `mio task create`), (ii) delegation ("@mention" a teammate by role + "don't do the hands-on work yourself when … coordinate"), (iii) worker loop ("claim it first" reference + "post progress" + "report back"). Use `.toContain` checks on distinctive phrases you'll add.
- [ ] **Step 2: Run fail.**
- [ ] **Step 3: Implement:** insert a new `## Orchestration & delegation` section AFTER the `## Tasks` section (after the "Recognising tasks in the channel" subsection, ~line 160) and BEFORE `## @Mentions`. Content (concise, existing voice, DRY — reference don't restate):
  - **When you're coordinating (especially as a PM):** given a goal or multi-step request, break it into concrete, independently-actionable tasks and create each with `mio task create` (one per subtask — avoid one giant task). Express ordering/dependencies in the task titles/descriptions and a short coordinating message (e.g. "Start #1 and #2 in parallel; #3 depends on #1"). Prefer independent subtasks; avoid unnecessary serial chains. @mention the teammate best suited to each task (by their role) to pull them in. When your job is to coordinate, delegate and track — don't do all the hands-on work yourself.
  - **When you're executing a delegated task:** claim it first (see "Claim before you work" above), do the work, post progress in the task thread, move it to `in_review` when ready, and report back to the requester. (Reference the Tasks status flow + claim-before-work rather than restating them.)
- [ ] **Step 4: Run pass** + `npm test` (no regression — existing systemPrompt tests, esp. any that assert the full prompt or section ordering, may need their expected text updated; update, don't delete) + `npx tsc --noEmit`.
- [ ] **Step 5: (no git).**

---

## Chunk B: acceptance — orchestration round-trip

### Task B1: make the stub channel-aware + add decompose/claim branches
**Files:** Modify `src/simulation/stubStreamRuntime.ts`; (the runner B3 drives it). Stub behavior is exercised by the B3 runner, not a unit test.

**Background (current stub, confirmed):** `stubStreamRuntime.ts` branches on `text.includes('[target=#sim ')` (hardcoded, trailing space) and `runMioTaskFlow` passes `--channel '#sim'` literally; branches: firstTurn→emit, `type=system`→skip, `create a task`→runMioTaskFlow, else→slice-1 send.

**Discriminator finding (IMPORTANT — drives the design):** in the 3.2 scenario BOTH the PM and the worker are members of `#general`, so BOTH receive the human goal AND the PM's @mention message (3.1 delivery). Content-branching ALONE cannot tell the PM stub from the worker stub — if both decomposed on the goal you'd get 2× the tasks. So the stub needs a **per-spine role discriminator**. (The spec's "prefer content-branching; fall back to per-agent env if insufficient" — it IS insufficient here, so use the env.)

- [ ] **Step 1: Channel-aware** — replace the `text.includes('[target=#sim ')` gate with a parse: `const m = text.match(/\[target=#([^\s\]]+)/); const channel = m ? '#'+m[1] : null; if (!channel) { emitResult(); return; }`. Use this `channel` in ALL `mio` calls. NOTE the hardcoded `#sim` literals are at FOUR sites: `runMioTaskFlow` (3×: create/claim/update) AND `runMioSend` (`--target '#sim'`). `runMioSend(body)` currently takes NO channel param — change its signature to `runMioSend(channel, body)` (or pass channel in) and thread the parsed `channel` through; don't just swap literals. This keeps slice1/2 green (their messages are in `#sim` → parsed channel is `#sim`). The `[^\s\]]+` class preserves the old trailing-space safety (e.g. `#sim-other` captures `sim-other`, NOT a false `#sim`).
- [ ] **Step 2: Role discriminator** — read the stub's role from an env var the runner sets per spine: `const STUB_ROLE = process.env.MIO_STUB_ROLE ?? '';` (`'pm'` | `'worker'` | `''`). (How the runner sets per-spine env is B3's job; the stub just reads it. If the existing stub already reads any per-spine env for its mode, mirror that mechanism.)
- [ ] **Step 3: Branches** (keep `type=system`→skip and firstTurn→emit and the slice-2 `create a task`→runMioTaskFlow(channel) and slice-1 send branches INTACT — add the new branches BEFORE the slice-1 send fallback, gated by role + content):
  - **DECOMPOSE (role==='pm' AND goal-shaped):** if `STUB_ROLE==='pm'` and the text matches a goal trigger (e.g. `/\bbuild\b/i` + the runner's distinctive goal phrasing — pick a stable trigger the runner controls), run a new `runMioDecompose(channel, workerHandle)`: `mio task create channel "<title A>"` then `mio task create channel "<title B>"` (≥2 distinct titles), then `mio message send channel` with stdin `"@<workerHandle> take #<n1>; @<workerHandle> review #<n2> after"` (or similar). Parse each created `#N` from stdout like `runMioTaskFlow` does. Log actions (`task-create`×2, `send`). The workerHandle can be passed via env (`MIO_STUB_WORKER_HANDLE`) set by the runner, or hardcoded to the seeded worker handle the runner knows — runner's choice; the stub reads it from env.
  - **CLAIM (role==='worker' AND a take/claim @mention to self):** if `STUB_ROLE==='worker'` and the text matches `/\btake\b|\bclaim\b/i` with a `#<N>`, parse the FIRST `#(\d+)` and run `mio task claim #N channel`. Log `task-claim`.
  - A worker receiving the goal (not a take/claim) → no-op (emitResult). A PM receiving its own @mention echo / non-goal → no-op.
- [ ] **Step 4:** Verify slice1/2 still pass after the channel-aware refactor (run their round-trips in B4). No unit test for the stub itself (it's harness code exercised by B3); ensure `npx tsc --noEmit` clean.

### Task B2: seed distinct roles in the harness
**Files:** Modify `src/simulation/mioServerSetup.ts`.

- [ ] **Step 1:** The two machine-owned agents seeded for slice-3.1 (`AGENT_ID`, `AGENT2_ID`, both currently `role:'ops'`, both members of `#general` per 3.1) → set `AGENT_ID` role to `'pm'` and `AGENT2_ID` role to `'engineer'`. Keep their channel memberships (A∈{frontend,general}, B∈{backend,general}) — #general is where both meet, which the orchestration test uses. Keep their `name`/handle distinct (already so). Confirm `/members` returns these roles (it does — memberRoutes selects `role`).
- [ ] **Step 2:** Do NOT break slice3RoundTrip (it asserts channel routing, not roles) — changing role from ops→pm/engineer must not affect 3.1's a/b/c/d assertions. Verify in B4.
- [ ] **Step 3: (no git).**

### Task B3: `slice3_2RoundTrip.ts` acceptance runner
**Files:** Create `src/simulation/slice3_2RoundTrip.ts` (model on `slice3RoundTrip.ts`).

- [ ] **Step 1:** Boot the sim MioServer + the multi-spine daemon (PM=AGENT_ID, worker=AGENT2_ID, both in #general). Reuse slice3's wrapping `startSpineFn` that captures `deps.agentId` and wires per-agent `coord.onInjected` recorders. **Per-spine env (CONFIRMED FEASIBLE — precedent in slice2):** in the wrapping startSpineFn's custom `spawnFn`, merge a per-agent env into the stub spawn — map `agentId===PM → MIO_STUB_ROLE=pm` (+ `MIO_STUB_WORKER_HANDLE=<worker handle>`), `agentId===worker → MIO_STUB_ROLE=worker`. **Mechanism (verified):** slice2RoundTrip's spawnFn does `const env = { ...options.env, ...override }; return nodeSpawn(tsxPath,[stubPath],{...options,env})` (forwarding `MIO_STUB_ACTION_LOG_FILE`); the stub reads `process.env`. slice3RoundTrip's CURRENT spawnFn passes `options` through with NO env merge — you MUST ADD the merge (branch the override on `deps.agentId`, which is already in scope in slice3's wrapping startSpineFn). Do NOT assume slice3 already merges env (it doesn't; slice2 does). If for some reason the merge can't be done, STOP and report — do NOT fake the discriminator.
- [ ] **Step 2:** Post a human goal to `#general` (via the op/human path slice3 uses) containing the PM's handle + the decompose trigger, e.g. `"@<pmHandle> please build the X feature — it needs a frontend part and a backend part."` (matches the stub's goal trigger).
- [ ] **Step 3: Assertions (stub = MECHANICS/REGRESSION guard; HARD, drive exit code):**
  - (a) **≥2 tasks created in #general** — read TASK ROWS via the agent-api (`mio task list` through a TestGateway call OR a direct agent-api GET /tasks/list with a machine token + X-Mio-Agent-Id) and assert ≥2 tasks with DISTINCT titles. Count by rows, NOT by stub reacting to 📋 (stub skips `type=system`). 
  - (b) **@mention delivered to the worker** — assert the worker's recorder (`coord.onInjected`) contains the PM's `@<workerHandle> … take #` message (the `target=#general` line with the take text). Uses 3.1 per-agent recording.
  - (c) **worker claims a task → owned** — after the worker stub's claim branch runs (triggered by b's @mention), assert (via task list/row) that one task in #general is now owned by the worker (`assignee_id === workerAgentId`). If timing-sensitive, poll like slice2/3 helpers. 
  - Use `assertPass`/`failCount`/`process.exit(failCount>0?1:0)` exactly like slice3RoundTrip. Track + clean temp dirs via `workDirs` (zero-footprint, like slice3 post-fix).
- [ ] **Step 4: Run stub:** `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice3_2RoundTrip.ts` → exit 0, a/b/c green. (Prep test DB if needed: MioServer `npm run test:db:setup`; no migration.)
- [ ] **Step 5: Attempt real-claude once** (`MIO_SPINE_RUNTIME=claude …`) — the REAL orchestration-behavior proof: a real PM decomposes into ≥2 tasks + @mentions; report whether it produced ≥2 tasks + the @mention reached the worker + the worker (real or driven) claimed. Decomposition count/quality best-effort (log if <2 within window, slice-2/3.1 precedent); a/b/c stay hard where they're mechanics. If no real claude here, report (don't fake).
- [ ] **Step 6: (no git).**

### Task B4: regression
- [ ] **Step 1:** `npm test` (all green, report count) + `npx tsc --noEmit` clean.
- [ ] **Step 2:** `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice1RoundTrip.ts` → 10/10; `… slice2RoundTrip.ts` → 13/13; `… slice3RoundTrip.ts` → 20/20 (the channel-aware stub refactor + role seed must NOT regress these — #sim parses correctly, 3.1 routing unaffected by roles).
- [ ] **Step 3: (no git).**

---

## Reuse map
| Need | Reuse |
|---|---|
| multi-agent hosting + per-channel delivery + per-agent recorders | Slice 3.1 (`bootAgentSpine` multi-spine, membership filter, `MultiSpineHandle.handles`, `coord.onInjected`) |
| task create/claim + 📋 + claim-before-work | Slice 2 (`mio task`, `claimControlTaskCas`, `taskMessageBridge`, systemPrompt Tasks section) |
| role data | `WorkroomMember.role` (already returned by `/members`; resolved in bootAgentSpine) |
| prompt threading pattern | `handle`/`displayName`/`description` flow bootAgentSpine → startAgentSpine → `runtimeCtx` (NOT `model` — goes to createClaudeStreamHost) |
| acceptance harness + per-agent recorders + zero-footprint cleanup | `slice3RoundTrip.ts` + `mioServerSetup.ts` |
| channel-aware stub parse | the `target=#<name>` RFC-5424 header `renderInboundMessage` already emits |
