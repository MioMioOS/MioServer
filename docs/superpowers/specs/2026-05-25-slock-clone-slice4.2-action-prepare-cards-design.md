# Slock Clone — Slice 4.2: Action-Prepare Cards (agent proposes / human approves) — Design

**Date:** 2026-05-25
**Status:** Design (approved by user — lightweight prepared-action mechanism; types `channel:create` + `channel:add_member`; NO `agent:create`; pending spec review)
**Repos:** MioServer (schema + agent-api prepare/list + operator fulfill/dismiss + observable card) + mio-agent (proxy `action` + `mio action` CLI + systemPrompt). Schema-touching → migration + prod deploy.
**Builds on:** Slices 1–4.1 (multi-agent spine, tasks, PM, reminders — shipped; reminders 4.1 deployed to prod). Reuses: `insertSystemMessage` + `writeEventAndBroadcast` (observable card), `authorizeAgentApi` + agent-api route shape + `resolveAgentChannelTarget`, the existing operator channel routes (`create_channel` / `manage_members` via `authorizeChannelWrite`/op_sess_), agentProxy action dispatch, agentcli, systemPrompt, slice acceptance harness.

---

## 1. Context & the reconciliation (why a NEW lightweight mechanism, not ControlAction)

Per the source model (orchestration doc §6 + real Slock daemon): an agent **cannot directly** perform privileged structural operations. It runs `slock action prepare` + a JSON proposal → posts an **action card** to a channel → a **human clicks → the operation executes under the HUMAN's identity**. This is the "agent proposes / human submits" separation.

**Reconciliation finding (verified against the codebase):** MioServer has a heavy existing `ControlAction` system (kinds deploy|upload|db_migrate|env_change; status proposed→approved→fired→reconciling→succeeded; ActionGate; JIT secret injection; reconciliation). That is the **WRONG model** for action-prepare: it is "agent proposes a risky action → human approves → the **AGENT executes** it (ActionGate subprocess + injected creds)". §6 is the opposite — "**the HUMAN executes** a structural op the agent can't do". ControlAction's reversibility/riskLevel/credentialAliasRef/reconciliation fields are irrelevant to "a human creates a channel". It is also legacy CodeLight infra **not wired** to the slice-1+ agent (the agent's action surface is the mio CLI: message/task/reminder — no `action`). So Slice 4.2 builds a NEW lightweight prepared-action card mechanism and does NOT touch ControlAction.

**The privileged operator routes already exist** (verified): `POST /api/v1/workrooms/:wid/channels` (`authorizeChannelWrite('create_channel', wid)`, op_sess_ OR machine) and `POST /api/v1/workrooms/:wid/channels/:cid/members` (`authorizeChannelWrite('manage_members', wid)` → publishes `channel.member_added`). So "the human executes" = invoking these under operator authority; 4.2 adds the agent-facing PROPOSAL + the CARD + the FULFILL linkage to them.

**`agent:create` is explicitly OUT (user decision):** the team roster is human-managed; a missing role is handled by existing agents self-governing/taking over (slice 3.2) or a human pulling an existing agent into the channel (`channel:add_member` + slice-3.1's live membership invalidation) — NOT by agents spawning new agents (avoids deadlock + uncontrolled compute/complexity).

---

## 2. Goal

An agent proposes a privileged structural change (`channel:create` or `channel:add_member`) via `mio action prepare` → the server persists a prepared-action + posts an observable card to the channel → a human (operator) fulfills it → the op executes under the operator's identity via the existing channel routes → the card updates to fulfilled. (The clickable human UI is Slice 5; 4.2 delivers the card + persistence + the operator fulfill/dismiss path.)

---

## 3. Action types (this slice)
- **`channel:create`** params: `{ name, visibility? }` → fulfill invokes the existing create-channel logic.
- **`channel:add_member`** params: `{ channel: '#target', member_id | member_handle }` → fulfill invokes the existing add-member logic → `channel.member_added` → slice-3.1 makes a newly-added agent live without restart.
- NO `agent:create`.

---

## 4. Components

### 4.1 MioServer — schema (migration)
- **`ControlPreparedAction`**: `id`, `workroomId`, `channelId` (the surface the card is posted to), `proposerAgentId` (FK→ControlAgent), `type` (`channel:create` | `channel:add_member`), `params` (Json), `status` (`proposed` | `fulfilled` | `dismissed`), `cardMessageId?` (the system message id of the card, for updating it), `fulfilledByOperator?` (operator session/identity ref), `fulfilledResultId?` (the created channel id / nothing for add_member), `createdAt`, `updatedAt`. `@@index([workroomId, status])`, `@@index([proposerAgentId])`. Plain FK columns (no relation fields), inline-REFERENCES FK in the migration (mirror slice-4.1's ControlReminder migration). Two artifacts, one DDL (prisma migration + `CONTROL_PLANE_MIGRATIONS` in setup-test-db.sh) — NEVER `prisma migrate dev`.

### 4.2 MioServer — agent-api (agent proposes; behind `authorizeAgentApi`)
- `POST /internal/agent-api/actions/prepare` `{target, type, params}` → `resolveAgentChannelTarget(target, auth.agent.id)` for the card's channelId/workroomId + membership; **validate type ∈ {channel:create, channel:add_member} + validate params per type** (channel:create needs a non-empty name; add_member needs a resolvable channel + member). post the observable card FIRST via `insertSystemMessage` + `writeEventAndBroadcast` (e.g. `🔧 @<agent> proposes: create channel "#foo"` / `🔧 @<agent> proposes: add @Designer to #frontend`), THEN create the ControlPreparedAction(status='proposed', proposerAgentId=auth.agent.id, cardMessageId=<the card msg id>) — this ordering (Flag C) guarantees `cardMessageId` is never null for a posted card. (The card-insert and the row-create are NOT in one transaction — same as the slice-4.1 reminder fire path; acceptable: a row without a card can't happen since the card is first, and a card without a row would just be an orphan ack, harmless.) Return the prepared-action.
- `GET /internal/agent-api/actions/list?status=&channel=` → prepared actions (author-anchored OR channel-anchored — pick author-anchored like reminders list, optionally channel filter). Return `{actions:[...]}`.

### 4.3 MioServer — operator (human approves/dismisses; behind op_sess_ / `authorizeChannelWrite`)
- `POST /api/v1/workrooms/:wid/actions/:id/fulfill` (op_sess_; the operator must have the underlying command authority — `create_channel` for channel:create, `manage_members` for channel:add_member) → load the prepared-action (must be status='proposed'); EXECUTE the stored op UNDER THE OPERATOR'S AUTHORITY via the shared core (see the REQUIRED REFACTOR below); on success: status='fulfilled', set `fulfilledByOperator` + `fulfilledResultId`; post a result system message (`✅ @<operator> approved: created #foo` / update the card); return. Version/idempotency: a CAS on status `proposed`→`fulfilled` (a second fulfill → 409 ACTION_ALREADY_RESOLVED). **A failed underlying op (e.g. duplicate channel name) leaves status='proposed'** (NO new `failed` enum — keep the status model minimal: proposed|fulfilled|dismissed) and returns the core op's error to the operator.

**REQUIRED REFACTOR (Flag A — the create/add logic is currently INLINE in the channelRoutes handler closures, NOT shareable):** before fulfill can reuse it, extract the create-channel body and the add-member body from `channelRoutes.ts` into EXPORTED pure functions — e.g. `createChannelCore({ workroomId, actorId, name, visibility?, ... })` and `addMemberCore({ workroomId, channelId, memberId, actorId })` — each doing the DB writes + `writeChannelEventAndBroadcast` (which is currently module-private and must be exported/moved alongside). Then BOTH the existing direct routes (POST /channels, POST /channels/:cid/members) AND `fulfill` call these shared cores — eliminating duplication/divergence (note: `agentRoutes.ts` already re-implements `authorizeChannelWrite` ordering as a divergence-precedent to avoid repeating). **The core takes `actorId` as an explicit parameter (Flag B):** the direct routes pass the caller's id; `fulfill` passes the OPERATOR's subject id — so the channel/member is genuinely created `created_by`/`added_by` the operator (= "under the human's identity"). This refactor is its own plan chunk/task BEFORE fulfill; the direct routes' existing tests must stay green (proving the extraction is behavior-preserving).
- `POST /api/v1/workrooms/:wid/actions/:id/dismiss` (op_sess_) → status='dismissed' + a dismiss system message. CAS proposed→dismissed.
- (These are operator routes — the agent NEVER fulfills its own proposal; only a human/operator can. That's the whole point of the separation.)

### 4.4 mio-agent — proxy + CLI + prompt
- `agentProxy` `action` action (capability `actions`) → forwards `op ∈ {prepare, list}` to `/internal/agent-api/actions/<op>` (mirror the task/reminder action). **`fulfill`/`dismiss` are NOT agent ops** (operator-only — the agent can't approve its own proposal). `cliTransport` + `run.ts` capabilities → add `actions` (BOTH places, the slice-3.2/4.1 lesson).
- `mio action prepare --target #ch --type channel:create` (params from flags or stdin JSON, e.g. `--name "#foo"` or stdin `{"name":"#foo"}`) / `mio action prepare --target #ch --type channel:add_member --channel #frontend --member @Designer` / `mio action list`. Canonical text out / stderr-JSON on error.
- `systemPrompt` `## Proposing privileged actions` section: you CANNOT directly create channels or add members — those are privileged. To request one, use `mio action prepare` (the 2 types + their params); a human reviews the card and approves; you'll see the result as a system message. (Reinforce: don't try to do these directly; don't propose creating new agents — pull in existing teammates via channel:add_member or let existing agents take over.)

### 4.5 Reuse map
| Need | Reuse |
|---|---|
| observable card + result message | `insertSystemMessage` + `writeEventAndBroadcast` (slice 2/4.1) |
| agent-api route + auth + register | `agentApiTasks`/`agentApiReminders` + `authorizeAgentApi` + api.ts |
| card surface resolve | `resolveAgentChannelTarget(target, agent.id)` |
| operator fulfill auth | `authorizeChannelWrite('create_channel'|'manage_members', wid)` (op_sess_) |
| execute under human identity | EXTRACT createChannelCore/addMemberCore (+ export writeChannelEventAndBroadcast) from channelRoutes' inline handlers (REQUIRED refactor — currently NOT shareable; its own plan task) → both direct routes + fulfill call them, actorId param = operator subject id on fulfill |
| live add-member | slice-3.1 `channel.member_added` → membership cache invalidation |
| proxy action + cap + CLI + prompt | task/reminder action (slice 2/4.1) + cliTransport caps + agentcli + systemPrompt |
| acceptance harness | slice4_1RoundTrip / mioServerSetup |
| migration (2 registrations, 1 DDL) | slice-4.1 ControlReminder migration + CONTROL_PLANE_MIGRATIONS entry |

---

## 5. Data flow

```
PM agent: mio action prepare --target #general --type channel:add_member --channel #frontend --member @Designer
  → proxy action(prepare) → agent-api → ControlPreparedAction{proposed} + 🔧 card system message in #general
  ... a human sees the card (Slice 5 UI; in 4.2 acceptance: an op-token client) ...
  human: POST /workrooms/:wid/actions/:id/fulfill (op_sess_, manage_members)
    → server executes add-member UNDER THE OPERATOR'S identity (shared core) → channel.member_added
    → ControlPreparedAction{fulfilled} + ✅ result system message
    → slice-3.1: @Designer's daemon invalidates membership → @Designer live in #frontend (no restart)
```

## 6. Error handling
- Agent proposes an invalid type/params → 400 (validation at prepare). Agent tries `fulfill`/`dismiss` → not exposed via the agent action (operator-only routes; the proxy action map has no such op).
- Double fulfill / fulfill-after-dismiss → 409 ACTION_ALREADY_RESOLVED (CAS on status).
- Fulfill where the underlying op fails (e.g. duplicate channel name) → the prepared-action stays `proposed` (NO `failed` enum — status model is only proposed|fulfilled|dismissed) + the core op's error is returned to the operator (who can retry or dismiss); the core op's own validation applies.
- add_member with an unresolvable member/channel → validated at prepare where possible, re-checked at fulfill.

## 7. Testing
- **MioServer integration:** prepare (both types → prepared-action row + 🔧 card message + validation 400s); list (author-anchored); fulfill (channel:create → a real channel created under the operator + status=fulfilled + ✅ message; channel:add_member → real member added + channel.member_added + fulfilled; double-fulfill → 409; non-operator/agent token → 403); dismiss (→ dismissed, no execution). The fulfill uses the SAME core as the direct create/add routes (assert the created channel/member is real, not a stub).
- **mio-agent unit:** proxy action (prepare/list → right path; fulfill/dismiss NOT routable → 400; missing `actions` cap → 403); CLI subcommands (right payloads; validation); systemPrompt has the section + capability `actions`.
- **Acceptance `slice4_2RoundTrip.ts`** (model on slice4_1): an agent `mio action prepare` (channel:create) → assert the 🔧 card system message in the channel + the prepared-action persisted (proposed); then simulate the human via an op-token `fulfill` → assert a REAL channel was created + status=fulfilled + ✅ message. Repeat for channel:add_member → real member added + (optionally) a second hosted agent goes live via slice-3.1 invalidation. Stub hard gate + real-claude best-effort on the agent proposing.
- **Regression:** slices 1/2/3/3.2/4.1 runners + npm test + tsc (both repos).

## 8. Deploy
Schema-touching. Prod (after user authorization): predeploy code tar + pg_dump → rsync sources + the new migration → `prisma migrate deploy` (ControlPreparedAction) + generate → pm2 restart → smoke (/actions/prepare 401 mounted, /health 200, existing routes no regression). Live dogfood limited by the machine-token boundary (agent-api) — same as slice 2/3.1/4.1.

## 9. Out of scope (explicit)
- `agent:create` (user decision — no agent self-spawning).
- The clickable human approval UI (Slice 5 — iOS renders the card + the approve/dismiss buttons; 4.2 delivers the card + the operator fulfill/dismiss endpoints the UI will call).
- ControlAction reuse/changes (the wrong model; untouched).
- Other privileged ops (channel:archive, member:remove-as-card, etc.) — could be added as new types later; 4.2 ships the 2 core types.
- 4.3 profile/react/attachments.
