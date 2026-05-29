# Slock Clone — Slice 4.2: Action-Prepare Cards — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent proposes a privileged structural change (`channel:create` / `channel:add_member`) via `mio action prepare` → server persists a lightweight `ControlPreparedAction` + posts an observable card → a human (operator) fulfills it → the op executes under the operator's identity via the existing channel routes → card→fulfilled.

**Architecture:** NEW lightweight `ControlPreparedAction` (NOT the heavy ControlAction). Agent-api `prepare`/`list` (authorizeAgentApi). Operator `fulfill`/`dismiss` (op_sess_) — agent NEVER fulfills its own proposal. Fulfill executes via SHARED cores (`createChannelCore`/`addMemberCore`) extracted from channelRoutes' inline handlers, passing the operator's subject id as `actorId` ("under the human's identity").

**Tech Stack:** Fastify + Prisma + Postgres (MioServer); Node + tsx, socket.io WS (mio-agent); vitest.

**Spec:** `MioServer/docs/superpowers/specs/2026-05-25-slock-clone-slice4.2-action-prepare-cards-design.md`

**Hard constraints:**
- Repos NOT git-tracked → SKIP every commit step.
- MioServer: `npm run test:integration -- <paths>` / `npx vitest run <paths>` / `npx tsc --noEmit`. NEVER `prisma migrate dev` (test DB via setup-test-db.sh CONTROL_PLANE_MIGRATIONS; prod via migrate deploy).
- mio-agent: `npm test` + `npx tsc --noEmit`.
- **Chunk A (the refactor) FIRST** — fulfill (D) depends on the extracted cores. Deploy (G) LAST + needs user authorization.
- Reuse, don't rebuild. Do NOT touch ControlAction. NO agent:create.

---

## File Structure
**MioServer:** `sources/control/channels/channelCore.ts` (NEW — extracted createChannelCore/addMemberCore + re-export writeChannelEventAndBroadcast) ; `channelRoutes.ts` (direct routes call the cores); `prisma/schema.prisma` + `prisma/migrations/<ts>_s4_2_prepared_actions/` + setup-test-db.sh ; `sources/control/actions/agentApiPreparedActions.ts` (agent-api prepare/list) ; `sources/control/actions/preparedActionOperatorRoutes.ts` (operator fulfill/dismiss) ; register both in api.ts.
**mio-agent:** `src/proxy/agentProxy.ts` (`action` action) ; `src/proxy/cliTransport.ts` + `src/cli/commands/run.ts` (capability `actions`) ; `src/agentcli/index.ts` (`mio action`) ; `src/runtimes/systemPrompt.ts` (section) ; `src/simulation/{mioServerSetup,slice4_2RoundTrip}.ts`.

---

## Chunk A: REFACTOR — extract createChannelCore + addMemberCore (behavior-preserving)

### Task A1: extract the shared cores
**Files:** Create `sources/control/channels/channelCore.ts`; Modify `sources/control/channels/channelRoutes.ts`; the EXISTING channelRoutes tests are the guard.
- [ ] **Step 1:** Read `channelRoutes.ts` create-channel handler (~395-469) + add-member handler (~479-514) + the module-private `writeChannelEventAndBroadcast` + `channelMemberCount`.
- [ ] **Step 2:** Create `channelCore.ts`. **CRITICAL DESIGN (so fulfill in Chunk D can run the core inside a $transaction with rollback-on-failure WITHOUT broadcasting a phantom event pre-commit):** the cores take an OPTIONAL Prisma tx client and do DB writes ONLY (incl. `publishControlEvent` for the event ROW on that client) — they DO NOT call `workroomBroadcaster.broadcast`; instead they RETURN the broadcast payload(s) for the caller to emit AFTER commit. Export:
  - `createChannelCore(input: { db?: PrismaTxClient, workroomId, actorId, name, visibility: 'public'|'private', description?, memberIds?: string[] }): Promise<{ channel, memberCount, events: BroadcastPayload[] }>` — body of lines 428-456 BUT using `input.db ?? db` for every write, and replacing the inline `writeChannelEventAndBroadcast('channel.created', …)` with `publishControlEvent(...)` (event row, in-tx) + pushing the broadcast payload into the returned `events` (do NOT broadcast here).
  - `addMemberCore(input: { db?: PrismaTxClient, workroomId, channelId, memberId, actorId }): Promise<{ added: boolean; notFound?: boolean; events: BroadcastPayload[] }>` — body of lines 491-511 similarly (in-tx writes; channel∈workroom → notFound; P2002→added:false, no event; on real insert → publishControlEvent('channel.member_added',{added_by:actorId}) + return the event in `events`).
  - To enable this, decompose the current `writeChannelEventAndBroadcast(wid, topic, payload)` into `publishChannelEvent(wid, topic, payload, db?)` (DB row, tx-aware, returns the BroadcastPayload) + a caller-side `broadcastChannelEvents(payloads)` (the workroomBroadcaster.broadcast loop). Keep a thin `writeChannelEventAndBroadcast` wrapper (publish-then-broadcast, no tx) for the OTHER channelRoutes call-sites that don't need a tx. Move `channelMemberCount` into the shared module too.
- [ ] **Step 2b: update ALL `writeChannelEventAndBroadcast` call-sites in channelRoutes.ts** — there are FOUR beyond the two being extracted: the DM-create POST (~line 361), member-remove DELETE (~542), stop-agents POST (~579). After the helper moves to `channelCore.ts`, channelRoutes.ts imports it back; confirm all four still compile + behave identically (they use the positional `(wid, topic, payload)` signature — preserve it).
- [ ] **Step 3:** Rewrite the two direct routes to: validate the request body (name/visibility/member_id — keep the existing 400s in the route), call the core (NO tx → uses default db), THEN `broadcastChannelEvents(result.events)` (post-write, mirrors the old inline behavior); map core results to the existing wire shapes (create → 201 + GET-item shape from {channel, memberCount}; add-member → notFound→404, else {ok:true}).
- [ ] **Step 4:** Run the EXISTING channelRoutes tests (find them: `channelRoutes*.spec.ts`) → ALL still green (behavior-preserving extraction). `npm run test:integration -- sources/control/channels` + `npx tsc --noEmit`.
- [ ] **Step 5: (no git).**

---

## Chunk B: ControlPreparedAction schema + migration

### Task B1: schema + migration (2 registrations, 1 DDL — mirror slice-4.1 ControlReminder)
**Files:** `prisma/schema.prisma`; `prisma/migrations/<ts>_s4_2_prepared_actions/migration.sql`; `scripts/setup-test-db.sh`.
- [ ] **Step 1:** `ControlPreparedAction` model: `id @id @default(uuid()) @db.Uuid`, `workroomId @map @db.Uuid`, `channelId @map @db.Uuid` (card surface), `proposerAgentId @map @db.Uuid` (FK→ControlAgent), `type String` (`channel:create`|`channel:add_member`), `params Json`, `status String @default("proposed")` (proposed|fulfilled|dismissed), `cardMessageId String? @map @db.Uuid`, `fulfilledByOperator String? @map("fulfilled_by_operator")` (**TEXT, NOT @db.Uuid — the operator subject id has the form `pairing:<uuid>`, not a bare uuid; in the migration.sql this column is `TEXT`**), `fulfilledResultId String? @map("fulfilled_result_id") @db.Uuid`, `createdAt @default(now()) @map`, `updatedAt @updatedAt @map`. `@@index([workroomId, status])`, `@@index([proposerAgentId])`, `@@map("control_prepared_actions")`. Plain FK columns (no relation fields).
- [ ] **Step 2:** `migration.sql` (`<ts>` later than `20260526000000`, e.g. `20260527000000`) — CREATE TABLE (snake_case, UUID/TIMESTAMPTZ/JSONB/TEXT/INTEGER as slice-4.1), the 2 indexes, inline `REFERENCES` FKs (workroom_id→control_workrooms, channel_id→control_channels, proposer_agent_id→control_agents). Mirror `20260526000000_s4_reminders/migration.sql`.
- [ ] **Step 3:** Add the migration.sql path to `CONTROL_PLANE_MIGRATIONS` in `scripts/setup-test-db.sh` (after the s4_reminders entry). `npm run test:db:setup` → table created.
- [ ] **Step 4:** `npx prisma generate` + `npx tsc --noEmit`.
- [ ] **Step 5: (no git).**

---

## Chunk C: agent-api — actions/prepare + list

### Task C1: agentApiPreparedActions (prepare + list)
**Files:** Create `sources/control/actions/agentApiPreparedActions.ts`; Modify `sources/api.ts`; Test `agentApiPreparedActions.integration.spec.ts`.
- [ ] **Step 1:** Failing integration test (mirror agentApiReminders.integration.spec.ts): seed machine+agent+channel(member). Cases: prepare channel:create {target:#sim, type, params:{name:'#foo', visibility:'public'}} → ControlPreparedAction(proposed) + a 🔧 card system message in #sim (cardMessageId set) + return; prepare channel:add_member {target, params:{channel:#x, member_handle/id}} → proposed + card; validation: bad type → 400, missing required param → 400; list → author-anchored {actions}; non-member target → 404; cross-machine agent → 403.
- [ ] **Step 2:** Run fail.
- [ ] **Step 3:** Implement: `authorizeAgentApi` → `resolveAgentChannelTarget(target, auth.agent.id)` (card channelId/workroomId) → validate `type ∈ {channel:create, channel:add_member}` + per-type params (channel:create: non-empty name + visibility default 'public'; channel:add_member: a resolvable target channel + a member id/handle) → **card FIRST** (`insertSystemMessage({workroomId, channelId, content:'🔧 @<agent> proposes: …'})` → `writeEventAndBroadcast(row)`) THEN create ControlPreparedAction(cardMessageId=card.id, proposerAgentId, status proposed) → return {action}. list: `where:{proposerAgentId: auth.agent.id, ...status?, ...channel?}` → {actions}. Register in api.ts (sibling).
- [ ] **Step 4:** Run pass + `npm run test:integration -- sources/control/actions sources/control/agentApi` (no regression) + tsc.
- [ ] **Step 5: (no git).**

---

## Chunk D: operator — actions/:id/fulfill + dismiss (executes via the cores)

### Task D1: preparedActionOperatorRoutes (fulfill + dismiss)
**Files:** Create `sources/control/actions/preparedActionOperatorRoutes.ts`; Modify `sources/api.ts`; Test its integration spec (use `mintOperatorSession` + `V1_OPERATOR_COMMANDS`).
- [ ] **Step 1:** Failing integration test: seed a prepared-action (proposed) + an operator session (op_sess_ with create_channel/manage_members). Cases:
  - fulfill channel:create → CAS proposed→fulfilled; a REAL channel created via `createChannelCore` with `actorId = operator subject id`; `fulfilledResultId` = new channel id; ✅ result system message; assert the channel row exists with `created_by` = operator.
  - fulfill channel:add_member → `addMemberCore` adds the member under the operator + `channel.member_added` fired + status=fulfilled.
  - double fulfill → 409 ACTION_ALREADY_RESOLVED (CAS); fulfill after dismiss → 409.
  - dismiss → status=dismissed + dismiss message, NO channel created.
  - non-operator token (agent/machine without the command) → 403; missing the underlying command authority → 403.
  - underlying op fails (e.g. add_member to a nonexistent channel) → status STAYS proposed + the core error returned (no `failed` enum).
- [ ] **Step 2:** Run fail.
- [ ] **Step 3:** Implement. First read the prepared-action to get its `type` (to choose the command authority) → `authorizeChannelWrite(request, type==='channel:create'?'create_channel':'manage_members', wid)` (op_sess_ operator auth — NOT authorizeAgentApi; `actor.actorId` = the operator subject id).
  - **ATOMIC fulfill (REQUIRED — do NOT use CAS-then-core-then-revert, it's racy + crash-unsafe; mirror `operatorCommandTransaction.ts`'s tx pattern):**
    ```ts
    let events; let resultId;
    await db.$transaction(async (tx) => {
      // CAS inside the tx:
      const cas = await tx.controlPreparedAction.updateMany({ where: { id, workroomId: wid, status: 'proposed' }, data: { status: 'fulfilled' } });
      if (cas.count === 0) throw new ConflictError('ACTION_ALREADY_RESOLVED');   // → 409
      // execute the core ON THE SAME tx client with the OPERATOR as actorId:
      const r = type === 'channel:create'
        ? await createChannelCore({ db: tx, workroomId: wid, actorId: actor.actorId, ...params })
        : await addMemberCore({ db: tx, workroomId: wid, actorId: actor.actorId, ...params });
      if (r.notFound) throw new NotFoundError('CHANNEL_NOT_FOUND');             // rolls back the CAS → stays proposed
      resultId = r.channel?.id ?? null;
      events = r.events;
      await tx.controlPreparedAction.update({ where: { id }, data: { fulfilledByOperator: actor.actorId, fulfilledResultId: resultId } });
    });
    // AFTER commit only: broadcast the channel event(s) + post the ✅ result system message (write-before-broadcast; never inside the tx)
    broadcastChannelEvents(events);
    await postResultCard(...);  // insertSystemMessage('✅ @<operator> approved: …') + writeEventAndBroadcast
    ```
    So a core failure (notFound / P-error) rolls the whole tx back → status atomically returns to 'proposed' (NO `failed` enum, no revert race, no phantom-fulfilled-on-crash). The channel/member event + ✅ card broadcast ONLY after the tx commits (so a rollback never emits a phantom channel.created/member_added). `fulfilledByOperator = actor.actorId`.
  - 409 mapping: ConflictError → 409 ACTION_ALREADY_RESOLVED. dismiss: a plain CAS `updateMany({where:{id, workroomId:wid, status:'proposed'}, data:{status:'dismissed'}})` count 0 → 409; else post a dismiss system message. Register both routes in api.ts.
- [ ] **Step 4:** Run pass + `npm run test:integration -- sources/control/actions sources/control/channels` (channels regression — the cores still serve direct routes) + tsc.
- [ ] **Step 5: (no git).**

---

## Chunk E: mio-agent — proxy action + capability + CLI + prompt

### Task E1: agentProxy `action` action + capability
**Files:** `src/proxy/agentProxy.ts`; `src/proxy/cliTransport.ts`; `src/cli/commands/run.ts`; Test `agentProxy.spec.ts`.
- [ ] Add `action` to Action union + CAPABILITY_REQUIRED (`actions`). `ACTION_OP_PATH`: `prepare→POST actions/prepare`, `list→GET actions/list`. **`fulfill`/`dismiss` NOT in the map** (operator-only; op:fulfill → 400 UNKNOWN_ACTION_OP, no upstream). forwardAction mirrors forwardReminder. **Capability `actions` in BOTH places — the PRODUCTION path is `run.ts`'s EXPLICIT list (it OVERRIDES the cliTransport default, which is only the fallback when capabilities is omitted; run.ts always supplies it):** edit `src/cli/commands/run.ts` ~line 193 `capabilities: ['send','read','tasks','reminders']` → add `'actions'`; AND `src/proxy/cliTransport.ts` ~line 224 default → add `'actions'`. Updating only the cliTransport default would still 403 in production. Also add `400 UNKNOWN_ACTION_OP` to the agentProxy module docstring error-code table. Tests: prepare/list → right path; op:fulfill → 400 UNKNOWN_ACTION_OP no-upstream; missing `actions` cap → 403; 409/400 relayed.

### Task E2: `mio action` CLI + systemPrompt
**Files:** `src/agentcli/index.ts` (+ callProxy action type adds `'action'`); `src/runtimes/systemPrompt.ts`; Tests.
- [ ] CLI `mio action prepare --target #ch --type channel:create --name "#foo" [--visibility public|private]` / `mio action prepare --target #ch --type channel:add_member --channel #frontend --member @Designer` / `mio action list` → proxy action op. (Params from flags; optionally accept stdin JSON for params.) Missing --target/--type/required-param → MISSING_ARG. NO fulfill/dismiss CLI (operator-only).
- [ ] systemPrompt `## Proposing privileged actions` section (after Reminders, before @Mentions): you CANNOT directly create channels or add members — use `mio action prepare` (the 2 types + params); a human reviews the card + approves; you'll see the ✅ result as a system message; do NOT propose creating new agents (pull in existing teammates via channel:add_member or let existing agents take over).
- [ ] Tests: each subcommand → right payload; missing args → MISSING_ARG; systemPrompt has the section + the 2 types + capability `actions`. `npm test` + tsc.

---

## Chunk F: acceptance + regression

### Task F1: extend mioServerSetup + slice4_2RoundTrip
**Files:** `src/simulation/mioServerSetup.ts` (register agentApiPreparedActions + preparedActionOperatorRoutes); Create `src/simulation/slice4_2RoundTrip.ts` (model on slice4_1RoundTrip — has the op-token humanOpSession + agent spine + recorders).
- [ ] Register both new route plugins in mioServerSetup.
- [ ] **Op-session command scope (else fulfill 403):** mioServerSetup's `humanOpSession` is currently minted with `allowedCommands: ['send_message']` ONLY. The fulfill route requires `create_channel` / `manage_members`. ADD both to the humanOpSession's `allowedCommands` (or mint a second operator session carrying them) — otherwise every acceptance `fulfill` 403s.
- [ ] **Cleanup (zero-footprint, FK-safe):** add `db.controlPreparedAction.deleteMany({ where: { workroomId: WORKROOM_ID } })` to mioServerSetup's `cleanup()` BEFORE the controlChannel + controlAgent deletions (the prepared-action rows reference channel_id + proposer_agent_id).
- [ ] Runner: boot sim MioServer + agent spine. Drive `mio action prepare` (channel:create) via the real agent path (proxy/CLI through the wrapper, or apiPreparedActionPrepare). Assert (HARD, real reads): the 🔧 card system message in the channel + the ControlPreparedAction persisted (proposed, cardMessageId set). Then simulate the human: an op-token `fulfill` call → assert a REAL channel was created (read via channels list/DB) with created_by=operator + status=fulfilled + ✅ message. Repeat channel:add_member → real member added (+ optionally a 2nd hosted agent goes live via slice-3.1). double-fulfill → 409. dismiss path (a 2nd prepared-action) → dismissed, no channel.
- [ ] Run stub: `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice4_2RoundTrip.ts` → exit 0. (test DB has the new table from Chunk B.) Track workDirs (zero-footprint). Attempt real-claude once (best-effort on the agent proposing; the fulfill mechanics stay hard).

### Task F2: regression
- [ ] mio-agent `npm test` + tsc. **Run each round-trip and use its PRINTED `PASS (n)` count as the baseline (do NOT trust hardcoded numbers — verify by running):** slice1, slice2, slice3, slice3.2, slice4_1 must each exit 0 with no NEW failures vs their last green run (the channel-aware/reminder changes are additive). MioServer `npm run test:integration -- sources/control/channels sources/control/actions sources/control/agentApi` + tsc — **the channels suite is the critical regression guard that the Chunk-A core extraction is behavior-preserving for the direct routes.**

---

## Chunk G: prod deploy (REQUIRES user authorization)
### Task G1: pre-deploy verification
- [ ] MioServer tsc + full reminders/actions/channels/agentApi integration; mio-agent npm test + tsc + all round-trips (1/2/3/3.2/4.1/4.2).
### Task G2: prod migrate-deploy + dogfood (106.54.19.137 — authorize first)
- [ ] Predeploy code tar + pg_dump → read-only preflight (health, prepared_actions table absent, migrate status) → rsync sources + the new migration dir → `prisma migrate deploy` (1 new) + generate → pm2 restart → smoke (/actions/prepare 401 mounted, /health 200, existing routes — tasks/reminders/channels — no regression, public TLS) → verify control_prepared_actions table + migration row → live dogfood (machine-token boundary same as slice2/3.1/4.1; the operator fulfill CAN be dogfooded via an op token + prod-mint-op.ts → propose via... agent-api needs machine token, so the prepare half is boundary-limited; document). (no git.)

---

## Reuse map
| Need | Reuse |
|---|---|
| execute under operator identity | NEW `createChannelCore`/`addMemberCore` (extracted from channelRoutes, Chunk A) — actorId=operator subject on fulfill |
| observable card + result | `insertSystemMessage` + `writeEventAndBroadcast` (card-first then row) |
| agent-api prepare/list auth+shape | `agentApiReminders`/`agentApiTasks` + `authorizeAgentApi` + `resolveAgentChannelTarget` |
| operator fulfill/dismiss auth | `authorizeChannelWrite('create_channel'|'manage_members', wid)` (op_sess_) |
| live add-member | slice-3.1 channel.member_added → membership invalidation |
| proxy action + cap (both places) + CLI + prompt | task/reminder action (slice 2/4.1) |
| acceptance harness + op token | slice4_1RoundTrip + mioServerSetup humanOpSession + mintOperatorSession/V1_OPERATOR_COMMANDS |
| migration (2 registrations, 1 DDL) | slice-4.1 ControlReminder migration + CONTROL_PLANE_MIGRATIONS |
| prod deploy discipline | slice 2/4.1 migrate deploy + predeploy backups |
