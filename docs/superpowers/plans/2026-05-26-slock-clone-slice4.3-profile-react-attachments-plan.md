# Slock Clone — Slice 4.3: react + attachments + profile — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three agent-facing features — message reactions (toggle, prefer 👀), attachments (base64 transport + durable bytea storage), and profile show/update with a deterministic identicon avatar.

**Architecture:** Three independent features on the proven agent-api + proxy + CLI + systemPrompt spine. react = new ControlMessageReaction table + reaction.* events. attachments = base64-in-JSON over the JSON proxy (raised per-action/per-route body caps) into durable `ControlAttachment.data` bytea (NOT the ephemeral blobStore). profile = read/update existing ControlAgent fields + a zero-storage generated identicon. One migration covers both DDL changes.

**Tech Stack:** Fastify + Prisma + Postgres (MioServer); Node + tsx (mio-agent); vitest; node:crypto (identicon, sha256).

**Spec:** `MioServer/docs/superpowers/specs/2026-05-26-slock-clone-slice4.3-profile-react-attachments-design.md`

**Hard constraints:**
- Repos NOT git-tracked → SKIP commits. NEVER `prisma migrate dev` (test DB via setup-test-db.sh CONTROL_PLANE_MIGRATIONS; prod via migrate deploy).
- MioServer: `npm run test:integration -- <paths>` / `npx vitest run <paths>` / `npx tsc --noEmit`. mio-agent: `npm test` + `npx tsc --noEmit`.
- Capabilities go in BOTH `run.ts` prepareCliTransport explicit list (~line 196) AND `cliTransport.ts` default (~line 225) — the slice-3.2/4.1/4.2 lesson (one place only → 403).
- Do NOT reuse `blobStore` (ephemeral). Attachments are durable bytea.
- Chunk order: A react → B attachments → C profile → D acceptance → E deploy.

---

## File Structure
**MioServer:** `prisma/schema.prisma` (ControlMessageReaction + ControlAttachment.data) ; `prisma/migrations/20260528000000_s4_3/migration.sql` + setup-test-db.sh ; `sources/control/reactions/writeReactionEventAndBroadcast.ts` + `agentApiReactions.ts` ; `sources/control/attachments/agentApiAttachments.ts` ; `sources/control/profile/agentApiProfile.ts` + `identicon.ts` ; `sources/control/messages/sendMessageTransaction.ts` (+attachment_ids) + `agentApiRoutes.ts` (send passes attachment_ids) ; register all in `sources/api.ts`.
**mio-agent:** `src/proxy/agentProxy.ts` (react/attachment/profile actions + per-action body cap) ; `src/proxy/cliTransport.ts` + `src/cli/commands/run.ts` (capabilities) ; `src/agentcli/index.ts` (CLI) ; `src/runtimes/systemPrompt.ts` (3 sections) ; `src/gateway/restClient.ts` (api helpers) ; `src/simulation/{mioServerSetup,slice4_3RoundTrip}.ts`.

---

## Chunk A: react

### Task A1: schema + migration (ControlMessageReaction + ControlAttachment.data — one migration for both)
**Files:** `prisma/schema.prisma`; `prisma/migrations/20260528000000_s4_3/migration.sql`; `scripts/setup-test-db.sh`.
- [ ] Schema: `ControlMessageReaction` (mirror prior models): `id @id @default(uuid()) @db.Uuid`, `messageId @map("message_id") @db.Uuid`, `workroomId @map("workroom_id") @db.Uuid`, `reactorKind @map("reactor_kind")` (user|agent), `reactorId @map("reactor_id") @db.Uuid`, `emoji String`, `createdAt @default(now()) @map("created_at")`, `@@unique([messageId, reactorId, emoji])`, `@@index([messageId])`, `@@map("control_message_reactions")`, plain FK cols. ALSO on `ControlAttachment` (used by Chunk B; same migration): add `data Bytes? @map("data")` AND `channelId String? @map("channel_id") @db.Uuid` (the channel the attachment is scoped to — anchors the view membership check; `ControlAttachment` has no channel today and `workroomId` alone is not membership-checkable since there's no workroom-member table).
- [ ] migration.sql `20260528000000_s4_3` (ts after 20260527000000): `CREATE TABLE "control_message_reactions"` (UUID PK gen_random_uuid, TIMESTAMPTZ, inline REFERENCES message_id→control_messages / workroom_id→control_workrooms; the reactor_id has NO FK — it can be a user OR agent id, soft ref), the unique index `(message_id, reactor_id, emoji)` + the `(message_id)` index; AND `ALTER TABLE "control_attachments" ADD COLUMN "data" BYTEA;` AND `ALTER TABLE "control_attachments" ADD COLUMN "channel_id" UUID;` (nullable; no FK needed — soft ref, consistent with the table's existing soft refs). Mirror s4_reminders/s4_2 SQL style.
- [ ] Add the migration path to CONTROL_PLANE_MIGRATIONS in setup-test-db.sh. `npm run test:db:setup` → all 3 DDL apply. `psql … \d control_message_reactions` + `\d control_attachments` (data bytea + channel_id uuid) verify. `npx prisma generate` + `npx tsc --noEmit`.

### Task A2: writeReactionEventAndBroadcast + agentApiReactions
**Files:** Create `sources/control/reactions/writeReactionEventAndBroadcast.ts` + `sources/control/reactions/agentApiReactions.ts`; Modify `sources/api.ts`; Test `agentApiReactions.integration.spec.ts`.
- [ ] `writeReactionEventAndBroadcast({workroomId, topic:'reaction.added'|'reaction.removed', payload})` — mirror `sources/control/reminders/writeReminderEventAndBroadcast.ts` EXACTLY (publishControlEvent obj-form + workroomBroadcaster.broadcast 6-field + `if(!event.idempotent)` guard).
- [ ] `agentApiReactions`: `POST /internal/agent-api/messages/react` `{target, message_id, emoji, op:'add'|'remove'}` (authorizeAgentApi) → `resolveAgentChannelTarget(target, agent.id)` → verify the message belongs to that channel (load message, check channelId; else 404) → add: `controlMessageReaction.create({messageId, workroomId, reactorKind:'agent', reactorId:agent.id, emoji})` catch P2002 → idempotent ok; remove: `deleteMany({messageId, reactorId:agent.id, emoji})` → emit `reaction.added`/`reaction.removed` via the helper. Return `{ok:true}`. Register in api.ts.
- [ ] Failing integration test (mirror agentApiReminders.integration.spec.ts): add → reaction row + reaction.added event; duplicate add → idempotent (still 1 row, ok); remove → row gone + reaction.removed event; remove non-existent → ok no-op; react to a message not in the target channel → 404; non-member target → 404; cross-machine agent → 403. Run fail → implement → pass + `npm run test:integration -- sources/control/reactions sources/control/agentApi` + tsc.

### Task A3: mio-agent react proxy op + capability + CLI + prompt
**Files:** `src/proxy/agentProxy.ts`, `src/proxy/cliTransport.ts`, `src/cli/commands/run.ts`, `src/agentcli/index.ts`, `src/runtimes/systemPrompt.ts`; Tests.
- [ ] agentProxy: add `react` to Action union + CAPABILITY_REQUIRED(`reactions`) + a `react` op → `POST /internal/agent-api/messages/react` (mirror forwardReminder; single op, no op-map needed, or a REACT path). capability `reactions` in BOTH run.ts:196 + cliTransport:225.
- [ ] CLI: `mio message react <msgId> --target #ch --emoji 👀 [--remove]` → `{op flagged add/remove}`. MISSING_ARG on missing msgId/target/emoji. NOTE routing: `react` is a SUB-command of the `message` group (`group='message', sub='react'` in `runMessageCommand`) but maps to the TOP-LEVEL proxy action `'react'` (not a `message` op) — `runMessageCommand`'s `case 'react'` calls `callProxy(..., 'react', ...)`. Also extend `callProxy`'s action-type union in `agentcli/index.ts` to add `| 'react' | 'attachment' | 'profile'` (covers all three new Chunk A/B/C actions — do it once here) or tsc will fail.
- [ ] systemPrompt `## Reactions` (after Profile/before @Mentions, or near messaging): react sparingly, prefer 👀 to acknowledge "seen/on it" without a full message; `mio message react`. capability `reactions` in the wrapper.
- [ ] Tests: proxy react add/remove → right path + body; missing cap → 403; CLI payloads + MISSING_ARG; systemPrompt has the section. `npm test` + tsc.

---

## Chunk B: attachments (base64 + bytea)

### Task B1: agent-api attachments upload/view + send attachment_ids
**Files:** Create `sources/control/attachments/agentApiAttachments.ts`; Modify `sources/control/messages/sendMessageTransaction.ts` (+attachmentIds) + `sources/control/agentApi/agentApiRoutes.ts` (send passes attachment_ids) + `sources/api.ts`; Test `agentApiAttachments.integration.spec.ts`.
- [ ] `POST /internal/agent-api/attachments` `{filename, mime_type, data_base64, target}` (authorizeAgentApi, **per-route `bodyLimit: 12*1024*1024`** — NOTE: this route is JSON, handled by the custom `jsonBodyParser.ts` parser which is registered with `parseAs:'string'` and NO own `bodyLimit`, so it honors the route-level `bodyLimit` (override of the api.ts global 10 MiB); this is NOT the blobRoutes raw-buffer path). **`target` is REQUIRED** (a `#channel` or `@dm` the agent belongs to) — `ControlAgent` has NO `workroomId` and spans multiple channels/workrooms, so there is no derivable "agent's workroom"; the channel anchors both `workroomId` and the membership scope. → `resolveAgentChannelTarget(target, agent.id)` for `{channelId, workroomId}` (404 non-member, as elsewhere) → validate mime ∈ image allowlist (415, **reuse blobRoutes.ts `ALLOWED_MIME` set** — jpeg/png/heic/webp/gif — do not invent a new one) → `Buffer.from(data_base64,'base64')`, enforce decoded ≤ 8MB (413) → `controlAttachment.create({ workroomId, channelId, uploaderKind:'agent', uploaderId:agent.id, filename, mimeType, sizeBytes:BigInt(buf.length), data:buf })` (permissionScope/sensitivity/policyResult default; NOTE `sizeBytes` is a Prisma `BigInt` field — pass `BigInt(buf.length)`, and any test asserting it must compare against a BigInt) → `{attachment_id}`.
- [ ] `GET /internal/agent-api/attachments/:id` (authorizeAgentApi) → load ControlAttachment — the `select`/`findUnique` MUST include `data, channelId, filename, mimeType, sizeBytes` (a Prisma `Bytes` field returns a Node `Buffer`; if `data` isn't selected it comes back undefined) → resolve its `channelId` (every attachment now has one, since upload requires `target`; for a message-linked attachment, `message.channelId` agrees) → `controlChannelMember.findUnique({where:{channelId_memberId:{channelId, memberId:agent.id}}})` (403 if absent) → return `{filename, mime_type, size_bytes, data_base64: buf.toString('base64')}`. 404/403. (No standalone/no-channel branch — `target` is required, so membership is always a channel check.)
- [ ] send +attachment_ids: **NOTE — this is NOT a free "mirror of mentions": the agent-api send route (`agentApiRoutes.ts` send handler, ~lines 60-130) does NOT currently wire `mentions` from the body either**, so there is no in-route precedent to copy. Do BOTH: (1) `sendMessageTransaction` — add optional `attachmentIds?: string[]` to its input type and set it on `controlMessage.create({data:{..., attachmentIds}})` (the `ControlMessage.attachmentIds[]` column exists). NOTE its `create` uses an explicit `select` that does NOT return `attachmentIds`, so the transaction result will not include it. (2) `agentApiRoutes` send route — explicitly parse `attachment_ids` from the body (validate: array of strings) and pass it into `sendMessageTransaction`.
- [ ] Failing integration test: upload (valid image base64 + member target → row with data + channelId + sizeBytes; mime not allowed → 415; decoded > 8MB → 413; non-member target → 404; missing target → 400/validation); view (member → correct bytes round-trip; non-member of the attachment's channel → 403; not found → 404); send with attachment_ids → **re-query the message row** and assert `attachmentIds` set (the sendMessageTransaction result `select` omits it). Run fail → implement + register → pass + `npm run test:integration -- sources/control/attachments sources/control/messages sources/control/agentApi` + tsc.

### Task B2: mio-agent attachment proxy op (per-action body cap) + CLI + prompt
**Files:** `src/proxy/agentProxy.ts` (per-action body cap), `src/proxy/cliTransport.ts`/`run.ts` (cap), `src/agentcli/index.ts`, `src/runtimes/systemPrompt.ts`; Tests.
- [ ] agentProxy: add `attachment` action + CAPABILITY_REQUIRED(`attachments`) + ops upload(POST attachments)/view(GET attachments/:id). **Per-action body cap — IMPLEMENTATION NOTE (do NOT make `readBody` itself action-aware):** the 1MiB cap currently fires DURING the read (inside `readBody`, before `JSON.parse`), but the action (`body.action`) is only known AFTER parse — chicken-and-egg, an "action-aware readBody" is impossible. Correct mechanism: (1) read with a RAISED UNIFORM cap of 12MiB (`readBody(req, 12*1024*1024)`) so accumulation still has a hard OOM ceiling; (2) AFTER `JSON.parse` + reading `action`, ENFORCE the per-action limit: if `action !== 'attachment'` and the raw body length > 1MiB → return 413 `BODY_TOO_LARGE`. Net: attachment gets 12MiB, every other action is still effectively capped at 1MiB, trust boundary unchanged (machine token stays proxy-closure-only, capability gating still post-parse). capability `attachments` BOTH places.
- [ ] CLI: `mio attachment upload <localfile>` (read file → base64 + detect mime from extension → proxy attachment upload → print attachment_id) / `mio attachment view <id> [--out <path>]` (→ decode base64 → write to --out or stdout-info). `mio message send --target … --attachment <id>` (repeatable → attachment_ids[]).
- [ ] systemPrompt `## Attachments`: upload a local file → get an id → reference it in `mio message send --attachment <id>`; view by id. capability in wrapper.
- [ ] Tests: proxy attachment upload/view → right path; the per-action higher body cap (an >1MiB attachment body passes for the attachment action but a >1MiB OTHER action still 413s); missing cap → 403; CLI upload reads file→base64, view decodes, send --attachment; systemPrompt section. `npm test` + tsc.

---

## Chunk C: profile (+ identicon)

### Task C1: identicon generator (pure, pinned)
**Files:** Create `sources/control/profile/identicon.ts`; Test `identicon.spec.ts`.
- [ ] `generateIdenticon(seed: string): string` (returns a `data:image/svg+xml;base64,…` data-uri). Algorithm (PINNED): `const h = createHash('sha256').update(seed).digest()`; 5×5 grid, columns 0..2 from `h[0..14]` (`cell(col,row) on iff h[row*3+col] & 1`), mirror col 3←col 1, col 4←col 0; `hue = Math.floor(h[15]/255*360)`, color `hsl(${hue},55%,55%)`, empty `#f0f0f0`; build SVG `viewBox="0 0 5 5"` with `<rect>` per filled cell; `data:image/svg+xml;base64,` + base64(svg).
- [ ] Tests: deterministic (same seed → identical output); different seeds → different; output is a valid `data:image/svg+xml;base64,` data-uri (base64-decodes to well-formed SVG with the `viewBox="0 0 5 5"`); left-right symmetric — to assert symmetry, base64-decode the data-uri payload and parse the `<rect>` x-positions (or check the generator's intermediate grid is exported/testable), verifying col 3's filled cells mirror col 1 and col 4 mirror col 0. (Pure unit spec, no DB.)

### Task C2: agent-api profile show/update
**Files:** Create `sources/control/profile/agentApiProfile.ts`; Modify `sources/api.ts`; Test `agentApiProfile.integration.spec.ts`.
- [ ] `GET /internal/agent-api/profile?handle=` (authorizeAgentApi) → if no handle → self (auth.agent); else strip leading @ + `controlAgent.findMany({where:{orgId:auth.agent.orgId, name:<handle>}})` → 0→404 HANDLE_NOT_FOUND, >1→409 AMBIGUOUS_HANDLE, 1→that agent. Return `{handle:'@'+name, display_name, description, role, avatar: generateIdenticon(name)}`.
- [ ] `PATCH /internal/agent-api/profile` `{display_name?, description?}` (authorizeAgentApi) → update ONLY auth.agent's own ControlAgent row (the named fields). Return the updated profile (incl identicon). Register in api.ts.
- [ ] Failing integration test: show self → fields + avatar present (deterministic); show @handle → other agent; unknown handle → 404; ambiguous (2 same-name in org) → 409; update own display_name/description → persists + returned; update cannot touch another agent (the route only writes auth.agent — assert a second agent's row unchanged). Run fail → implement + register → pass + `npm run test:integration -- sources/control/profile sources/control/agentApi` + tsc.

### Task C3: mio-agent profile proxy op + capability + CLI + prompt
**Files:** `src/proxy/agentProxy.ts`, `cliTransport.ts`/`run.ts`, `src/agentcli/index.ts`, `src/runtimes/systemPrompt.ts`; Tests.
- [ ] agentProxy: `profile` action + CAPABILITY_REQUIRED(`profile`) + ops show(GET profile)/update(PATCH profile). capability `profile` BOTH places.
- [ ] CLI: `mio profile show [@handle]` (render handle/display_name/role/description; note avatar is a data-uri) / `mio profile update [--display-name "…"] [--description "…"]` (≥1 flag else MISSING_ARG).
- [ ] systemPrompt `## Profile`: show your or a teammate's profile; update your display name/description; your avatar is auto-generated. capability in wrapper.
- [ ] Tests: proxy show/update → right path+method; missing cap → 403; CLI payloads + MISSING_ARG; systemPrompt section. `npm test` + tsc.

---

## Chunk D: acceptance + regression

### Task D1: extend mioServerSetup + slice4_3RoundTrip
**Files:** `src/simulation/mioServerSetup.ts` (register agentApiReactions + agentApiAttachments + agentApiProfile; cleanup new rows FK-safe: controlMessageReaction + controlAttachment by workroom BEFORE messages/channels); Create `src/simulation/slice4_3RoundTrip.ts` (model on slice4_1/4_2RoundTrip).
- [ ] Register the 3 route plugins. Add FK-safe cleanup: insert `db.controlMessageReaction.deleteMany({where:{workroomId:WORKROOM_ID}})` and `db.controlAttachment.deleteMany({where:{workroomId:WORKROOM_ID}})` into the existing cleanup chain BEFORE `db.controlMessage.deleteMany` (both reference messages — reactions via message_id FK, attachments via message_id FK — so they must be deleted first), after `db.controlPreparedAction.deleteMany`.
- [ ] Add named REST helpers to `src/gateway/restClient.ts` (analogous to the existing `apiReminderSchedule`/`apiPreparedActionPrepare` helpers — none exist yet for these): `apiReact`, `apiAttachmentUpload`, `apiAttachmentView`, `apiProfileShow`, `apiProfileUpdate` (each: machineToken + X-Mio-Agent-Id → the agent-api route).
- [ ] Runner (stub hard gate; real reads): **react** — agent reacts to a seeded message via the real path → the harness has NO direct DB access and 4.3 ships NO reactions-read endpoint, so the assertion is the **`reaction.added` WS event** observed in the gateway event buffer (subscribe the workroom like slice4_2RoundTrip via `gateway.subscribeRaw(workroomId)`); then remove → assert `reaction.removed` event. **attachment** — `apiAttachmentUpload`/`mio attachment upload` a small test image (base64) → id → `apiAttachmentView`/`mio attachment view <id>` round-trips the bytes (assert equality) → `mio message send --attachment <id>` → re-query the sent message and assert `attachmentIds` includes it (NOT from the send result — `sendMessageTransaction`'s `select` omits `attachmentIds`). **profile** — `mio profile show` self → display_name + avatar (data-uri) present + deterministic; `mio profile update --description "…"` → persisted (re-show). Stub hard; real-claude best-effort on autonomous use.
- [ ] Run stub `MIOSERVER_DIR=../MioServer npx tsx src/simulation/slice4_3RoundTrip.ts` → exit 0 (test DB has the new table/column from Chunk A; `npm run test:db:setup` if needed). workDirs zero-footprint. Attempt real-claude once.

### Task D2: regression
- [ ] mio-agent `npm test` + tsc; run slices 1/2/3/3.2/4.1/4.2 round-trips (printed PASS counts, each exit 0). MioServer `npm run test:integration -- sources/control/reactions sources/control/attachments sources/control/profile sources/control/messages sources/control/agentApi sources/control/channels` + tsc.

---

## Chunk E: prod deploy (REQUIRES user authorization)
### Task E1: pre-deploy verification (both repos full suites + all round-trips).
### Task E2: prod migrate-deploy + dogfood (106.54.19.137 — authorize first)
- [ ] Predeploy code tar + pg_dump → preflight (health, control_message_reactions absent + control_attachments.data AND .channel_id columns absent, migrate status) → rsync sources+migration `20260528000000_s4_3` → `prisma migrate deploy` (1 new migration, 3 DDL statements in the file: CREATE control_message_reactions + ALTER add data BYTEA + ALTER add channel_id UUID — Postgres runs the file's statements sequentially; independent, no ordering conflict) + generate → pm2 restart → smoke (/messages/react + /attachments + /profile 401 mounted, /health 200, existing routes — tasks/reminders/actions/channels — no regression, public TLS) → verify table + both new columns + migration row. dogfood: machine-token boundary (agent-api) same as prior — NOTE profile/react/attachment are all `authorizeAgentApi` (machineToken + X-Mio-Agent-Id) ONLY; they are NOT reachable via op-token (`op_sess_`) or dev-token (`dev_ctl_`), so dogfood them via a real machine token (document this; no op-token smoke for profile). (no git.)

---

## Reuse map
| Need | Reuse |
|---|---|
| seq'd + catch-up WS events | `writeReminderEventAndBroadcast` template → new `writeReactionEventAndBroadcast`; `publishControlEvent`+`workroomBroadcaster` |
| agent-api route + auth + channel resolve | `agentApiReminders`/`agentApiTasks` + `authorizeAgentApi` + `resolveAgentChannelTarget` |
| members permission check | `controlChannelMember.findUnique({where:{channelId_memberId}})` (as sendMessageTransaction does) |
| send extra fields (attachment_ids) | how `mentions` flows into `sendMessageTransaction` |
| durable attachment storage | `ControlAttachment.data` bytea (NEW column) — NOT blobStore (ephemeral) |
| per-route bodyLimit | blobRoutes.ts precedent (per-route bodyLimit override) |
| proxy action + cap (both places) + CLI + prompt | task/reminder/action action (slice 2/4.1/4.2) |
| identicon | new pure `node:crypto` sha256 generator (no dep) |
| acceptance harness + op token + zero-footprint cleanup | slice4_1/4_2RoundTrip + mioServerSetup |
| migration (2 registrations, 1 DDL; CREATE + ALTER in one) | slice-4.1/4.2 migration + CONTROL_PLANE_MIGRATIONS |
