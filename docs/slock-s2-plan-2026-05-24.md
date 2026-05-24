# Slock S2 (Members/Agents + Threads) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Members tab and message Threads real (not mock) by adding MioServer endpoints + iOS Live wiring, and fix the agent display-name-as-UUID bug.

**Architecture:** Reuse every S1 pattern — `authorizeControlRead`/`authorizeOperatorWrite`, `sendMessageTransaction` + `nextChannelSeq`, `publishControlEvent` + `workroomBroadcaster`, Prisma migration dir, co-located `*.spec.ts`, iOS `hybridLive` + `StubURLProtocol`. Members = org `ControlAgent` rows (created on machine bind-org). Threads = `ControlMessage.parentMessageId` (nullable) + `ControlThread` bookkeeping, replies routed through an extended `sendMessageTransaction`.

**Tech Stack:** Fastify + Prisma + Postgres (MioServer, branch `feat/server-control-plane`); SwiftUI + XCTest (CodeLight, branch `main`).

**Spec:** `docs/slock-s2-members-threads-spec-2026-05-24.md` (read it; this plan implements it).

**Conventions (S1, do not deviate):**
- Branch `feat/server-control-plane` (MioServer). NEVER `git add -A` — stage only files you touched (both repos have unrelated uncommitted changes).
- Migrations via `npx prisma migrate dev --name <desc>` (NOT hand-written), then commit the generated dir.
- Tests: `npm test` (unit) + `npm run test:integration` (test DB). iOS: `xcodebuild ... test` on the booted simulator.
- Two migrations (one per backend chunk) so each chunk is self-contained.

---

## Chunk 1: Members backend (+ display-name fix)

**File Structure:**
- Modify: `prisma/schema.prisma` (ControlAgent `@@unique([orgId, machineId])`)
- Create: `prisma/migrations/<ts>_s2_agent_machine_unique/migration.sql` (generated)
- Modify: `sources/machines/machineRoutes.ts` (bind-org → create ControlAgent)
- Create: `prisma/backfill/s2_agents_for_bound_machines.ts`
- Modify: `sources/control/messages/messageRoutes.ts` (`resolveSenderDisplayNames` additive)
- Create: `sources/control/members/memberRoutes.ts` (GET members)
- Modify: `sources/api.ts` (register memberRoutes)
- Modify: `sources/control/devTokens/devTokenAuth.ts` (allowlist + member path)
- Test: `sources/control/members/memberRoutes.integration.spec.ts`, `sources/machines/machineRoutes.spec.ts` (or existing), `sources/control/messages/messageRoutes.read.integration.spec.ts` (extend)

### Task 1.1: Schema — ControlAgent unique on (orgId, machineId)

- [ ] **Step 1:** In `prisma/schema.prisma`, add to `model ControlAgent` (after existing fields, alongside `@@index([orgId, status])`):
  ```prisma
  @@unique([orgId, machineId])
  ```
  (Full unique index — Postgres treats NULLs as distinct, so agents without a machineId don't collide. Do NOT hand-write a partial index; it would drift against `prisma migrate`.)
- [ ] **Step 2:** Generate the migration:
  Run: `npx prisma migrate dev --name s2_agent_machine_unique`
  Expected: creates `prisma/migrations/<ts>_s2_agent_machine_unique/` with a `CREATE UNIQUE INDEX "control_agents_org_id_machine_id_key" ON "control_agents"("org_id", "machine_id")`. No errors / no unexpected drift.
- [ ] **Step 3:** `npx prisma generate` (refresh client types). Verify `npx tsc --noEmit` clean.
- [ ] **Step 4:** Commit: `git add prisma/schema.prisma prisma/migrations && git commit -m "feat(s2): ControlAgent @@unique(orgId, machineId)"`

### Task 1.2: Create ControlAgent on machine bind-org

**Files:** Modify `sources/machines/machineRoutes.ts` (the `POST /api/v1/machines/:id/bind-org` handler, ~lines 122-155). Test: `sources/machines/machineRoutes.spec.ts` (or the integration spec where bind-org is tested).

- [ ] **Step 1: Write the failing test** — after bind-org, a ControlAgent row exists for the machine; calling bind-org twice does not create a second row.
  ```ts
  it('bind-org creates a ControlAgent for the machine (idempotent)', async () => {
    // register machine → bind-org(orgId) → assert one ControlAgent {machineId: machine.id, orgId, status:'online'}
    // call bind-org again → still exactly one ControlAgent row for that machineId+orgId
  });
  ```
- [ ] **Step 2:** Run it → FAIL (no agent created).
- [ ] **Step 3: Implement.** In the bind-org handler, after the machine is updated with `orgId`/`boundAt`, add (inside the same logical flow; use a transaction if the handler doesn't already):
  ```ts
  // Ensure an agent identity exists for this machine so it appears in the
  // members list and resolves a display name on its messages.
  const existing = await db.controlAgent.findFirst({
    where: { orgId, machineId: machine.id },
    select: { id: true },
  });
  if (!existing) {
    const displayName = machine.displayName?.trim() || 'Agent';
    await db.controlAgent.create({
      data: {
        orgId,
        machineId: machine.id,
        name: displayName,
        displayName,
        role: 'other',
        status: 'online',
      },
    });
  }
  ```
  (Use the exact `orgId`/`machine` variable names from the handler.)
- [ ] **Step 4:** Run test → PASS. Run `npm test` (machines) → green.
- [ ] **Step 5:** Commit: `git add sources/machines/machineRoutes.ts sources/machines/*.spec.ts && git commit -m "feat(s2): create ControlAgent on machine bind-org (idempotent)"`

### Task 1.3: Backfill ControlAgent for already-bound machines

**Files:** Create `prisma/backfill/s2_agents_for_bound_machines.ts` (mirror an existing backfill in `prisma/backfill/`).

- [ ] **Step 1: Implement** an idempotent script: for each `ControlMachine` with `boundAt != null && orgId != null` lacking a matching `ControlAgent` (by `{orgId, machineId}`), create one (`displayName = machine.displayName ?? 'Agent'`, `name` same, `role:'other'`, `status:'online'`). Print a count.
- [ ] **Step 2: Run against local dev DB:** `npx tsx --env-file=.env.dev prisma/backfill/s2_agents_for_bound_machines.ts`
  Expected: creates a row for the demo machine `e4d22ad8-002d-4678-a29f-3b86ae23c5ac`; second run prints "0 created" (idempotent).
- [ ] **Step 3: Verify:** `PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d codelight_test -tA -c "select machine_id, display_name, status from control_agents;"` shows the demo machine.
- [ ] **Step 4:** Commit: `git add prisma/backfill/s2_agents_for_bound_machines.ts && git commit -m "feat(s2): backfill ControlAgent for bound machines"`

### Task 1.4: Additive sender-name resolution (id ∪ machineId)

**Files:** Modify `sources/control/messages/messageRoutes.ts` `resolveSenderDisplayNames` (lines 47-76). Test: extend `sources/control/messages/messageRoutes.read.integration.spec.ts`.

- [ ] **Step 1: Write the failing test** — an agent message whose `senderId == ControlAgent.machineId` (daemon send) resolves `sender_display_name`; KEEP the existing test where `senderId == ControlAgent.id` still resolves.
  ```ts
  it('resolves agent display_name by machineId (daemon send)', async () => {
    // seed ControlAgent { id: <agentUuid>, machineId: <MACHINE_ID>, displayName: 'Mio' }
    // seed message senderKind:'agent', senderId: <MACHINE_ID>
    // GET messages → sender_display_name === 'Mio'
  });
  ```
- [ ] **Step 2:** Run it → FAIL (machineId not queried; resolves null).
- [ ] **Step 3: Implement.** Replace the query + map build so it matches by id OR machineId and keys the map by whichever the sender used:
  ```ts
  if (agentIds.length === 0) return result;

  const agents = await db.controlAgent.findMany({
    // id is @db.Uuid (agentIds already uuid-filtered → safe); machineId is text.
    where: { OR: [{ id: { in: agentIds } }, { machineId: { in: agentIds } }] },
    select: { id: true, machineId: true, displayName: true, name: true },
  });

  for (const a of agents) {
    const label = a.displayName?.trim() || a.name?.trim();
    if (!label) continue;
    result.set(a.id, label);                       // agent-id senders (S1)
    if (a.machineId) result.set(a.machineId, label); // machine-id senders (daemon)
  }
  return result;
  ```
- [ ] **Step 4:** Run test → PASS. Run the FULL read integration spec → the existing id-based + P2023 tests still green.
- [ ] **Step 5:** Commit: `git add sources/control/messages/messageRoutes.ts sources/control/messages/messageRoutes.read.integration.spec.ts && git commit -m "feat(s2): resolve agent names by id OR machineId (fix daemon UUID names)"`

### Task 1.5: GET /workrooms/:wid/members

**Files:** Create `sources/control/members/memberRoutes.ts`. Modify `sources/api.ts` (register). Modify `sources/control/devTokens/devTokenAuth.ts` (allowlist). Test: `sources/control/members/memberRoutes.integration.spec.ts`.

- [ ] **Step 1: Write the failing test(s)** (mirror an existing `*.integration.spec.ts`): machine token → 200 with agents for the workroom's org; dev_ctl_ (in scope) → 200; dev_ctl_ for a different workroom → 403; machine bound to another org → 403; wire shape `{ members: [{id, kind:'agent', display_name, role, status, machine_id}] }`.
- [ ] **Step 2:** Run → FAIL (route 404).
- [ ] **Step 3: Implement** `memberRoutes(app)` with `GET /api/v1/workrooms/:wid/members`:
  - `const auth = await authorizeControlRead(request)`; on `!auth.ok` reply `auth.status` + code.
  - Machine mode: `requireMachineAccessToWorkroom(auth.machine, wid)` (reuse the helper used by other workroom-scoped machine routes; 403 on mismatch).
  - Resolve org: `const wr = await db.controlWorkroom.findUnique({ where:{id:wid}, select:{orgId:true} })`; 404 if absent.
  - `const agents = await db.controlAgent.findMany({ where:{ orgId: wr.orgId }, select:{ id:true, displayName:true, name:true, role:true, status:true, machineId:true }, orderBy:[{status:'asc'},{displayName:'asc'}] })`.
  - Map to `{ id, kind:'agent', display_name: displayName||name, role, status, machine_id: machineId }`. Reply `{ members }`.
  - Register in `sources/api.ts`: import `memberRoutes` and add `await app.register(memberRoutes);` alongside the other control routes (~line 81).
- [ ] **Step 4:** In `devTokenAuth.ts`, add `/^\/api\/v1\/workrooms\/[^/]+\/members$/` to the GET allowlist array (next to the messages/channels entries). (workroom-scope is already enforced by `devTokenInWorkroomScope`.)
- [ ] **Step 5:** Run member tests → PASS. `npm test && npm run test:integration` → green. `npx tsc --noEmit` clean.
- [ ] **Step 6:** Commit: `git add sources/control/members/ sources/api.ts sources/control/devTokens/devTokenAuth.ts && git commit -m "feat(s2): GET /workrooms/:wid/members (agents)"`

### Task 1.6: Manual live check (members + names)

- [ ] **Step 1:** With local MioServer:3005 + daemon running + backfill done, `curl -s -H "Authorization: Bearer <dev_ctl_>" http://localhost:3005/api/v1/workrooms/ed224c68-1c51-462b-a86b-574dddc7667c/members | jq` → shows the agent with a name.
- [ ] **Step 2:** `curl` GET channel messages → agent messages now have `sender_display_name` non-null (the daemon machine has an agent row now). Note: this is the real fix for the UUID display in the iOS app too.

**→ Chunk 1 plan review (dispatch plan-document-reviewer), then proceed.**

---

## Chunk 2: Threads backend

**File Structure:**
- Modify: `prisma/schema.prisma` (ControlMessage `parentMessageId` + `@@index`)
- Create: `prisma/migrations/<ts>_s2_message_parent/migration.sql` (generated)
- Modify: `sources/control/messages/sendMessageTransaction.ts` (optional `parentMessageId` + thread upsert + parent bump)
- Modify: `sources/control/messages/messageRoutes.ts` (formatMessage `parent_message_id`; GET excludes replies; full POST response; thread routes)
- Modify: `sources/control/devTokens/devTokenAuth.ts` (2 thread allowlist paths)
- Test: `sources/control/messages/messageRoutes.thread.integration.spec.ts` (new), extend write/read specs

### Task 2.1: Schema — ControlMessage.parentMessageId

- [ ] **Step 1:** In `prisma/schema.prisma` `model ControlMessage`, add:
  ```prisma
  parentMessageId String?  @map("parent_message_id") @db.Uuid
  @@index([parentMessageId])
  ```
- [ ] **Step 2:** `npx prisma migrate dev --name s2_message_parent` → adds nullable column + index. No drift.
- [ ] **Step 3:** `npx prisma generate`; `npx tsc --noEmit` clean.
- [ ] **Step 4:** Commit: `git add prisma/schema.prisma prisma/migrations && git commit -m "feat(s2): ControlMessage.parentMessageId column"`

### Task 2.2: Extend sendMessageTransaction (parentMessageId + thread bookkeeping)

**Files:** Modify `sources/control/messages/sendMessageTransaction.ts`. Test: extend `sendMessageTransaction.spec.ts` (or the write integration spec).

- [ ] **Step 1: Write failing tests:** (a) a reply (parentMessageId set) inserts a message with that parent; (b) first reply creates ControlThread `replyCount:1` + sets parent `threadReplyCount:1`; (c) second reply → ControlThread `replyCount:2`, parent `threadReplyCount:2`; (d) idempotent replay of a reply (same key) returns existing, does NOT double-bump.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Add `parentMessageId?: string | null` to `SendMessageInput`.
  - In `create.data`, add `parentMessageId: parentMessageId ?? null`; add `parentMessageId` to the `select`.
  - After the message `create` (still inside the `$transaction`, only when `parentMessageId` is set):
    ```ts
    if (parentMessageId) {
      await tx.controlThread.upsert({
        where: { parentMessageId },
        create: { parentMessageId, workroomId, replyCount: 1, lastReplyAt: created.createdAt },
        update: { replyCount: { increment: 1 }, lastReplyAt: created.createdAt },
      });
      await tx.controlMessage.update({
        where: { id: parentMessageId },
        data: { threadReplyCount: { increment: 1 }, lastThreadReplyAt: created.createdAt },
      });
    }
    ```
    (The `nextChannelSeq` FOR UPDATE earlier in the tx serializes concurrent first-replies, so the upsert create branch won't double-fire.)
  - Add `parentMessageId` to the returned object + the `SendMessageResult` ok shape (so the route can include it).
- [ ] **Step 4:** Run tests → PASS. `npm test` (messages) green.
- [ ] **Step 5:** Commit.

### Task 2.3: formatMessage parent_message_id + GET excludes replies + full POST response

**Files:** Modify `sources/control/messages/messageRoutes.ts`. Test: extend read + write integration specs.

- [ ] **Step 1: Write failing tests:** (a) GET channel messages does NOT include reply rows (parentMessageId set); (b) GET response messages include `parent_message_id: null` for top-level; (c) POST message response now returns full wire shape (`sender_kind`, `sender_id`, `content`, `parent_message_id`, …) not just `{id,seq,created_at,idempotent}`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - `formatMessage`: add param field `parentMessageId: string | null` and emit `parent_message_id: msg.parentMessageId ?? null`. Add `parentMessageId` to all message `select`s feeding formatMessage (GET list, GET :id).
  - GET channel messages query: add `parentMessageId: null` to the `where` (replies excluded). Keep `take: limit+1` has_more logic.
  - POST message handler: build the response via `formatMessage(<the created row>, senderNames)` + `idempotent`. Resolve the sender name for the single row (reuse `resolveSenderDisplayNames` for `[{senderId, senderKind}]`). Update the S1 write integration spec assertions to the full shape (additive — existing `toHaveProperty` checks still pass).
- [ ] **Step 4:** Run → PASS. Full `npm test && npm run test:integration` green.
- [ ] **Step 5:** Commit.

### Task 2.4: Thread routes (GET thread, GET replies, POST reply)

**Files:** Modify `sources/control/messages/messageRoutes.ts` (add 3 routes). Modify `devTokenAuth.ts` (2 allowlist paths). Test: `messageRoutes.thread.integration.spec.ts`.

- [ ] **Step 1: Write failing tests:**
  - `GET /workrooms/:wid/threads/:parentId` → `{id, parent_message_id, reply_count, last_reply_at, task_id:null}`; no ControlThread row → reply_count 0; parent not found → 404; parent in invisible channel → 404.
  - `GET /workrooms/:wid/threads/:parentId/replies?after_seq=&limit=` → `{parent_message_id, messages:[…], has_more}` ordered by seq; pagination.
  - `POST /workrooms/:wid/threads/:parentId/reply` → op_sess_ (idempotency key required) → 200 full message with `parent_message_id`; machine_token → 200 (kind agent); dev_ctl_ → 403; parent not found → 404; replies do NOT appear in GET channel messages.
- [ ] **Step 2:** Run → FAIL (routes 404).
- [ ] **Step 3: Implement** the 3 routes (mirror the existing GET/POST messages handlers):
  - Reads use `authorizeControlRead` + channel visibility via the parent's channelId (mirror `GET /messages/:id` at messageRoutes.ts:~244). GET thread reads `ControlThread` (derive reply_count 0 if absent).
  - GET replies: `controlMessage.findMany({ where:{ parentMessageId, seq:{ gt: afterSeq } }, orderBy:{seq:'asc'}, take: limit+1 })` → formatMessage each (resolve names batch).
  - POST reply: auth try op_sess_ (`authorizeOperatorWrite(request,{command:'send_message', workroomId:wid})`) else machine_token; dev_ctl_ → 403 (mirror messageRoutes POST). Derive senderKind/senderId. Load parent → its channelId (404 if missing). Call `sendMessageTransaction({ channelId, workroomId, senderKind, senderId, content, clientIdempotencyKey, parentMessageId })`. On ok, `publishControlEvent({workroomId, eventId:randomUUID(), topic:'thread.reply', payload:{channel_id, parent_message_id, message_id, seq, sender_kind, sender_id, preview}})` + broadcast (skip if idempotent). Respond full formatMessage + idempotent.
  - `devTokenAuth.ts`: add `/^\/api\/v1\/workrooms\/[^/]+\/threads\/[^/]+$/` and `/^\/api\/v1\/workrooms\/[^/]+\/threads\/[^/]+\/replies$/` to the GET allowlist. (`/messages/:id` already allowlisted — do NOT re-add.)
- [ ] **Step 4:** Run → PASS. Full `npm test && npm run test:integration` green. `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit.

**→ Chunk 2 plan review, then proceed.**

---

## Chunk 3: iOS Live wiring

**File Structure:**
- Create: `app/CodeLight/Slock/Live/LiveMemberRepository.swift`
- Create: `app/CodeLight/Slock/Live/LiveThreadRepository.swift`
- Modify: `app/CodeLight/Slock/Live/LiveMessageRepository.swift` (send maps full shape; add MessageDTO.parentMessageId optional)
- Modify: `app/CodeLight/Slock/Live/SlockAPIClient.swift` (if a GET-with-opToken or extra decode helper is needed — only if required)
- Modify: `app/CodeLight/Slock/Live/LiveConfig.swift` (hybridLive: members + threads → Live)
- Test: `app/CodeLightTests/Slock/LiveMemberRepositoryTests.swift`, `LiveThreadRepositoryTests.swift`, extend `LiveMessageRepositoryTests.swift`

**Before writing tests:** open `CodeLightTests/Slock/LiveMessageRepositoryTests.swift` and reuse its `StubURLProtocol` fixture + `msgJSON`/`msgListJSON` helpers (don't reinvent).

### Task 3.1: LiveMemberRepository

- [ ] **Step 1: Write failing tests** (StubURLProtocol): members maps `{id, kind, display_name, role, status}` → `Member(kind:.agent, displayName, roleDescription:role, runtime:…)`; status mapping `online→.online`, `busy→.working`, `drain→.paused`, `offline→.paused`, unknown→.paused; empty list; 401→authExpired; 403→empty; network error→offline.
- [ ] **Step 2:** Run → FAIL (type missing).
- [ ] **Step 3: Implement** `LiveMemberRepository: MemberRepository` (mirror LiveChannelRepository): `members(workspaceId)` → `api.get("/workrooms/\(workroomId)/members", as: MembersEnvelope.self)` → map; `member(id)` → filter members. Add a `runtimeFromStatus(_:)` total mapping with default `.paused`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit (CodeLight repo): `git add app/CodeLight/Slock/Live/LiveMemberRepository.swift app/CodeLightTests/Slock/LiveMemberRepositoryTests.swift && git commit -m "feat(slock-live): LiveMemberRepository"`

### Task 3.2: Fix LiveMessageRepository.send to map full POST shape

- [ ] **Step 1: Write failing test:** POST returns full wire shape → `send()` returns a `Message` with correct senderKind/senderId/content (previously the thin shape would throw). Use the now-full POST response shape.
- [ ] **Step 2:** Run → FAIL only if send currently mishandles; otherwise assert the mapping is correct against full shape.
- [ ] **Step 3: Implement:** ensure `send()` decodes the full `MessageDTO` (it already does) and that the server returns it (Chunk 2.3). Add `parentMessageId: String?` to `MessageDTO` (optional). No behavior change needed beyond confirming the decode works against the real (now full) response.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

### Task 3.3: LiveThreadRepository

- [ ] **Step 1: Write failing tests** (StubURLProtocol): `thread(parentMessageId)` maps to `ThreadConversation`; `parentMessage(id)` → `GET /messages/:id`; `replies(threadId)` maps `[Message]`; `reply(threadId, body)` → POST with opToken + idempotency key, maps full-shape response → `Message`; error mappings.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `LiveThreadRepository: ThreadRepository` reusing the message DTO mapping (extract a shared `mapMessageDTO` if convenient, or duplicate the small mapper). `reply` uses `api.post` (opToken).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

### Task 3.4: hybridLive swap + build + simulator verify

- [ ] **Step 1:** In `LiveConfig.swift` `hybridLive`, replace `members: MockMemberRepository(...)` → `LiveMemberRepository(workroomId:…, api: api)` and `threads: MockThreadRepository(...)` → `LiveThreadRepository(workroomId:…, api: api)`.
- [ ] **Step 2:** `xcodebuild ... build` → BUILD SUCCEEDED. `xcodebuild ... test` → all green (count > 250).
- [ ] **Step 3: Simulator live check:** relaunch with `--slock-live …` args (server/dev-token/op-token/workroom). Open Members tab → real agent(s) with name/role/online dot. Open a message's thread → real replies; send a reply → appears.
- [ ] **Step 4:** Commit (only the touched files).

**→ Final code review (whole S2), then superpowers:finishing-a-development-branch.**

---

## Acceptance (from spec §9)
- Server unit+integration green (members + threads routes, additive name resolution, thread tx counts, GET-excludes-replies, full POST shape).
- iOS tests green; simulator: Members shows real agents, sender names are real (not UUID), threads read + reply work.
- dev_ctl_ read-only; op_sess_/machine for reply; cross-workroom/org 403; parent-not-found 404; migrations safe on existing data.
