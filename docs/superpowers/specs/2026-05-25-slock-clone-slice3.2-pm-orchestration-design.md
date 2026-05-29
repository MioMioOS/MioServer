# Slock Clone — Slice 3.2: PM Orchestration (decompose + delegate) — Design

**Date:** 2026-05-25
**Status:** Design (approved by user, pending spec review)
**Repos:** `mio-agent` only (prompt + a small role-threading wiring). NO MioServer code change (role is already returned by `/members`). NO schema change.
**Builds on:** Slice 3.1 (multi-agent hosting + per-channel delivery, shipped to prod) + Slice 2 (task model: `mio task create/claim/...`, `claimControlTaskCas`, `taskMessageBridge`) + Slice 1 (agentic spine).

---

## 1. Context & the gap

After Slice 3.1, one daemon hosts N agents; each receives only its member-channels' messages and self-governs replies. The task model (Slice 2) lets an agent create/claim/update tasks. What's missing is the **PM orchestration behavior**: a coordinating agent that, given a goal, **decomposes it into multiple tasks**, **groups/sequences them by phase + notes dependencies**, **@mentions the right teammate per task**, and tracks progress — while worker agents **claim, execute, report, and hand off for review**.

Per the source model (orchestration doc §4 line 85 — "拆任务给并行执行：按 phase 分组标依赖、优先独立子任务、避免串行链" — and the real transcript "PM 拆任务 + agent claim+汇报 / 📋 4 new tasks created"), this is **reasoning-driven, not a structured dependency graph**: the PM creates N tasks (N `mio task create` calls → N `📋` messages), expresses phases/dependencies in the task titles/descriptions + a coordinating message, and delegates via `@mention`. The mechanics it needs (multi-task creation, @mention, claim-before-work, assignee-independent-of-status) ALL already exist from Slices 1–3.1.

**Therefore Slice 3.2 is a PROMPT LAYER**, plus a small wiring change to surface the agent's structured `role` to its system prompt. No new MioServer endpoint, no schema change, no dependency/phase modeling.

---

## 2. Goal

A PM-role agent, given a goal in a channel, decomposes it into multiple delegated tasks and @mentions teammates; worker agents claim, execute, and report. All via prompt behavior on top of the existing multi-agent + task mechanics.

---

## 3. Key decision (approved): prompt layer, no new mechanism

- The PM decomposes via **reasoning**; phases/dependencies are expressed in **task titles/descriptions + coordinating messages** (text), NOT a DB dependency graph.
- **NOT done (YAGNI):** `ControlTask.dependsOn`/`phase` schema fields + dependency graph; wiring the latent `ControlGoal` table to the agent (the PM groups via the channel + messages, not a goal entity); a multi-title batch CLI (N single `mio task create` calls produce the same N `📋` messages and the agent-api already accepts a batch if ever needed).
- The structured `role` (ops|pm|engineer|designer|researcher|other), already on `ControlAgent` and returned by `/members`, is surfaced to the prompt so an agent knows its lane. Behavior remains **role-aware, not hard role-gated** — the orchestration guidance is shared by all agents (any agent decomposes when coordinating, claims+reports when executing); the role + persona bias which mode an agent leans into. This matches the source model where roles are seeds and behavior evolves.

---

## 4. Components & responsibilities

### 4.1 Thread the structured `role` into the system prompt (`mio-agent`)
- `AgentRuntimeContext` (`src/runtimes/systemPrompt.ts`) gains a `role?: string` field.
- `bootAgentSpine` (`src/cli/commands/run.ts`) passes `agentMember.role` per agent (inside the Slice-3.1 multi-spine loop) into `startAgentSpine` (a new `role` field on `AgentSpineDeps`), which sets `runtimeCtx.role`. `WorkroomMember.role` is already returned by `/members` (no server change). Mirror how `displayName`/`description`/`handle` already thread bootAgentSpine → startAgentSpine → `runtimeCtx` (NOTE: `model` is NOT a precedent here — it threads to `createClaudeStreamHost`, not into `AgentRuntimeContext`; the fields that actually land in `runtimeCtx` are `displayName`, `description`, and `handle`).
- `buildSystemPrompt` renders the role near the identity/"Initial role" section (e.g. "Your role on this team: **<role>**"). `WorkroomMember.role` is typed non-optional and always returned by the server, so in practice the guard is for the EMPTY-STRING case: when `role` is empty/whitespace, omit the line (no fabricated default) — the existing free-text "Initial role" (description) still renders.

### 4.2 Add an "Orchestration & delegation" prompt section (`mio-agent`)
A new section in `buildSystemPrompt` (after the Tasks section, building on it), shared by all agents, role-aware:
- **Coordinating (decomposition):** when you're given a goal or multi-step request (especially as a PM):
  - Break it into concrete, independently-actionable tasks; create each with `mio task create` (one per subtask). Avoid one giant task.
  - Express ordering/dependencies in the task titles/descriptions and a short coordinating message (e.g. "Start #1 and #2 in parallel; #3 depends on #1"). Prefer independent subtasks; avoid unnecessary serial chains.
  - @mention the teammate best suited to each task (by their role) to pull them in. Don't do the hands-on work yourself when your job is to coordinate — delegate and track.
- **Executing (worker):** when you're @mentioned or a task suits you:
  - Claim it first (`mio task claim` — claim-before-work, already covered); if the claim fails, someone else took it — move on.
  - Do the work, post progress in the task thread, move it to `in_review` when done, and report back to the requester/PM.
- Keep it concise, in the existing prompt voice; reuse/reference the existing Tasks + Reply-etiquette sections rather than duplicating them (DRY — e.g. claim-before-work already exists; the new section frames decomposition + delegation + reporting).

### 4.3 Acceptance (`mio-agent`)
Extend the harness + add a round-trip (model on `slice3RoundTrip.ts`):
- Seed (in `mioServerSetup.ts`): a PM-role agent (role='pm') + at least one worker agent (role='engineer'), both machine-owned, both members of `#general`. (The harness currently seeds role='ops' for both — set distinct roles.)
- A human posts a goal to `#general` @mentioning the PM (e.g. "@PM please build X — needs a frontend and a backend part").

**Required stub changes (the current stub is hardwired to `#sim` — this must be addressed, the spec does not gloss it):**
- `stubStreamRuntime.ts` currently only acts on `text.includes('[target=#sim ')` and passes `--channel '#sim'`/`--target '#sim'` literally. Make it **channel-aware**: parse the injected RFC-5424 `target=#<name>` and use THAT channel for its `mio` calls, instead of the `#sim` literal. (Keep `#sim` working for slice1/2 — derive the channel from the message, which yields `#sim` there.)
- **PM-vs-worker discriminator (both agents spawn the SAME stub binary):** branch on message CONTENT (cleanest, matches the existing content-branching stub) — a goal-shaped message ("build X… needs A and B") → DECOMPOSE branch (loop ≥2 `mio task create` into the delivered channel + one `mio message send` "@<worker> take #N"); an `@<self> … claim/take #N`-shaped message → CLAIM branch (`mio task claim #N`). Do NOT rely on a per-agent env unless content-branching proves insufficient.

**Stub variant = MECHANICS / REGRESSION GUARD (not proof of orchestration reasoning).** The stub is deterministic-scripted, so these assertions prove only that the daemon→server plumbing carries PM-shaped traffic (3.1 delivery routing + Slice-2 `📋` bridge + CAS claim) — they are a regression guard, NOT proof that an agent *reasons* a decomposition. Assert via the real path (wrapper→proxy→agent-api + the 3.1 recorders); HARD (drives exit code), but understood as plumbing:
  - (a) ≥2 tasks created in `#general` with distinct titles — count by reading the **task rows** (numbers) via the agent-api/DB, NOT by the stub reacting to `📋` (the stub's `type=system` skip means it ignores `📋` messages). 
  - (b) the PM's @mention message reaches the worker's recorder (3.1 per-agent `coord.onInjected`).
  - (c) the worker claims one task (real claim → 200; task owned by the worker).
- **Real-claude variant (`MIO_SPINE_RUNTIME=claude`) = the ACTUAL orchestration-behavior proof.** A real PM agent receives the goal + the new prompt section and must decompose into ≥2 tasks + @mention a worker. Decomposition QUALITY (count, dependency phrasing) is best-effort; "≥2 tasks created" + "@mention delivered" + "worker can claim" stay hard (daemon/server mechanics). If the real PM's autonomous task count is <2 within the window, log best-effort (slice-2/3.1 precedent) — but craft the goal prompt so ≥2 is the natural decomposition.

### 4.4 Reuse map
| Need | Reuse |
|---|---|
| multi-agent hosting + per-channel delivery + per-agent recorders | Slice 3.1 (`bootAgentSpine` multi-spine, inbox membership filter, `MultiSpineHandle.handles`, `coord.onInjected`) |
| task create/claim + 📋 messages + claim-before-work | Slice 2 (`mio task`, `claimControlTaskCas`, `taskMessageBridge`, systemPrompt Tasks section) |
| role data | `WorkroomMember.role` (already returned by `/members`; surfaced via Slice 1's member-resolution in bootAgentSpine) |
| prompt threading pattern | how `handle`/`displayName`/`description` already flow bootAgentSpine → startAgentSpine → AgentRuntimeContext (NOT `model` — that goes to createClaudeStreamHost) |
| acceptance harness | `mioServerSetup` + `slice3RoundTrip` (extend: seed roles + a decompose trigger in the stub) |

---

## 5. Data flow

```
human posts goal "@PM build X (frontend + backend)" in #general
  → 3.1 delivery routes it to the PM agent (member of #general)
  → PM (prompted by §4.2) decomposes:
       mio task create "#general" "frontend part"   → 📋 #1
       mio task create "#general" "backend part"    → 📋 #2
       mio message send "#general" "@Engineer take #1; @Backend take #2; #2 after #1"
  → 3.1 delivery routes the @mention to the worker agent(s)
  → worker (prompted by §4.2) claims:  mio task claim #1 "#general"  → owned
  → worker does work, posts progress in task thread, → in_review, reports back
```
All through the existing wrapper → proxy → agent-api path. No central router.

---

## 6. Error handling
- No new failure modes beyond Slices 1–3.1 (this is prompt + a `role` field that's non-optional from the server — always returned; the omit-line guard is for the empty-string case). `role` empty → the role line is omitted (no default). A worker claiming an already-claimed task → existing 409 / claim-before-work "move on" guidance. Decomposition is the agent's reasoning — no system-level error path.

## 7. Testing
- **Unit:** `buildSystemPrompt` output contains the role line when `role` is set (and omits it when absent); the output contains the orchestration/delegation guidance (decompose-into-tasks, @mention-teammates, claim-then-report). `bootAgentSpine` threads `agentMember.role` into the startSpineFn call (extend the existing multi-spine tests).
- **Acceptance:** `slice3RoundTrip.ts` extended (or a sibling) per §4.3 — stub hard gate (≥2 tasks + @mention delivered + worker claim), real-claude best-effort on decomposition quality.
- **Regression:** slice1 (10/10), slice2 (stub 13/13), slice3.1 (stub 20/20) still pass; mio-agent `npm test` + `npx tsc --noEmit` green. (No MioServer change → MioServer suite unaffected, but a quick `tsc` is cheap insurance.)

## 8. Out of scope (explicit)
- Task dependency/phase schema + graph (PM expresses these in text).
- Wiring `ControlGoal` to the agent (group via channel + messages).
- Multi-title batch CLI (N single creates suffice).
- Hard role-gating of capabilities (guidance is shared + role-aware).
- Slice 4 (reminders/action-prepare cards) + Slice 5 (iOS task board).
- Prod deploy: there's no MioServer change to deploy; the mio-agent prompt change reaches real devices only via the (separate, still-pending) mio-agent npm/SEA publish — same boundary as 3.1's agent side. This slice is build + acceptance.
