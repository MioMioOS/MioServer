# Slock Clone — Slice 4.3: react + attachments + profile — Design

**Date:** 2026-05-26
**Status:** Design (approved by user — react + attachments[base64+bytea] + profile[identicon]; pending spec review)
**Repos:** MioServer (schema + agent-api routes) + mio-agent (proxy ops + CLI + prompt). Schema-touching → migration + prod deploy.
**Builds on:** Slices 1–4.2 (multi-agent spine, tasks, PM, reminders, action-cards — all shipped to prod). Reuses: `insertSystemMessage`/`writeEventAndBroadcast`/`publishControlEvent`+`workroomBroadcaster` (observable events + catch-up), `authorizeAgentApi` + agentApi route shape + `resolveAgentChannelTarget`, agentProxy action dispatch (task/reminder/action pattern), agentcli, systemPrompt, capability-in-both-places (run.ts + cliTransport), slice acceptance harness, migration discipline (prisma migration + CONTROL_PLANE_MIGRATIONS, NEVER prisma migrate dev).

---

## 1. Context & reconciliation (what exists)

Source §2 agent CLI gaps: `message react` (sparingly, prefer 👀); `attachment upload/view`; `profile show/update`. Reconciliation against the codebase:
- **react:** GREENFIELD — no reaction table/route/CLI/prompt anywhere.
- **attachments:** `ControlAttachment` table EXISTS (filename, mimeType, sizeBytes, storageKey, sensitivity, policyResult, permissionScope, uploaderKind/Id, messageId) but is UNWIRED (no upload/view routes). `ControlMessage.attachmentIds[]` exists. **`blobStore` (`/v1/blobs`) is NOT reusable for attachments** — it is an EPHEMERAL transit buffer (in-memory metadata Map, 10-min TTL sweep, purge-on-startup, consumed-on-delivery) for phone→MioIsland image transit, device-auth'd. Attachments must PERSIST (a message's attachment is opened days later), so they need DURABLE storage.
- **profile:** `ControlAgent` has `name`/`displayName`/`description`/`role` (no avatar). `/members` returns these. So profile show is mostly a read; update mutates displayName/description; avatar is NEW.

## 2. Goal
An agent can: react to a message (`mio message react`, toggle, prefer 👀); upload + view attachments (`mio attachment upload/view`, base64 transport, durable bytea storage) and reference them in `mio message send`; show + update its profile (`mio profile show/update`) with a deterministic identicon avatar.

## 3. Decisions (approved)
- **Attachments: base64-in-JSON transport + bytea-in-DB storage.** Transport reuses the existing JSON proxy (no new proxy binary path; keeps the trust boundary uniform). Storage is durable bytea on `ControlAttachment.data` (transactional with the row, included in pg_dump, no separate file lifecycle). Do NOT reuse `blobStore` (ephemeral). **Cap reconciliation (the base64 cost — REQUIRED, else the cap is unreachable):** an 8 MB RAW attachment → base64 ≈ 10.67 MiB → exceeds BOTH the proxy's `MAX_BODY_BYTES` (currently 1 MiB, `agentProxy.ts`) AND the server's Fastify `bodyLimit` (currently 10 MiB, `api.ts`). So the attachment path MUST raise both: (i) a per-ACTION body cap on the proxy for the `attachment` op only (~12 MiB) — other ops keep their 1 MiB cap (don't widen the whole trust boundary); (ii) a per-ROUTE `bodyLimit` (~12 MiB) on `POST /internal/agent-api/attachments` (Fastify per-route bodyLimit). Documented attachment cap = 8 MB raw (validated on the DECODED size server-side); transport budget ≈ 12 MiB. (This memory/transport cost is the accepted price of base64 over the JSON proxy.)
- **Avatar: deterministic identicon generated from the agent's name/id** (GitHub/Slack-style), ZERO storage — generated on `profile show`, no upload, no avatar column (no file dependency, decoupled from attachments).
- **react: toggle (add/remove), free emoji** but prompt guides "sparingly, prefer 👀".

## 4. Components

### 4.1 MioServer — schema (migration `20260528000000_s4_3`)
- **`ControlMessageReaction`** (NEW): `id`, `messageId @db.Uuid` (FK→ControlMessage), `workroomId @db.Uuid`, `reactorKind` (user|agent), `reactorId @db.Uuid`, `emoji String`, `createdAt`. `@@unique([messageId, reactorId, emoji])` (one of each emoji per reactor per message — toggle), `@@index([messageId])`, `@@map("control_message_reactions")`. Plain FK + inline REFERENCES (mirror slice-4.1/4.2 migrations).
- **`ControlAttachment.data Bytes?`** (ADD a column): the durable attachment bytes (bytea). Nullable (existing rows have none). (ControlAttachment table already exists; this is an ALTER TABLE ADD COLUMN.)
- NO avatar column (identicon is generated).
- Two migration artifacts, one DDL: prisma migration `20260528000000_s4_3` (the CREATE TABLE + ALTER TABLE) + the path added to `CONTROL_PLANE_MIGRATIONS` in setup-test-db.sh. NEVER prisma migrate dev.

### 4.2 MioServer — react (agent-api, `authorizeAgentApi`)
- `POST /internal/agent-api/messages/react` `{target, message_id, emoji, op: 'add'|'remove'}` → `resolveAgentChannelTarget(target, agent.id)` (membership) + verify the message is in that channel; add → `controlMessageReaction.create` (P2002 on the unique → idempotent no-op) ; remove → `deleteMany({messageId, reactorId: agent.id, emoji})`. Emit `reaction.added`/`reaction.removed` via `publishControlEvent`+`workroomBroadcaster` (seq'd + catch-up, the writeEventAndBroadcast-style helper — reuse or a small `writeReactionEvent`). Return the reaction state. (Reactions are observable: the event + included when messages are read — extend the message read shape to include `reactions: [{emoji, count, reactors}]` OR a separate list; for the first increment, the WS event + a `GET /messages/:id/reactions` read suffices; including in the message-list read is a nice-to-have.)

### 4.3 MioServer — attachments (agent-api)
- `POST /internal/agent-api/attachments` `{filename, mime_type, data_base64, target?}` (authorizeAgentApi) → validate mime ∈ allowed images + decode base64 → enforce 8MB cap on the DECODED size → `controlAttachment.create({ workroomId, uploaderKind:'agent', uploaderId: agent.id, filename, mimeType, sizeBytes, data: <buffer>, permissionScope:'members', sensitivity:'normal', policyResult:'allowed' })` (defaults for the policy fields — no policy machinery) → return `{attachment_id}`. (storageKey unused for bytea; data column holds the bytes.)
- `GET /internal/agent-api/attachments/:id` (authorizeAgentApi) → load ControlAttachment; permissionScope='members' check via `controlChannelMember.findUnique({ where: { channelId_memberId: { channelId, memberId: auth.agent.id } } })` (the same guard `sendMessageTransaction` uses): if the attachment is message-linked, load the message's `channelId` first then check membership; if standalone (no messageId), check workroom membership. Return `{filename, mime_type, size_bytes, data_base64}` (base64-encode the bytea for the JSON response). 404 if not found, 403 if not a member. (Per-route bodyLimit also applies to the response size — within the 12 MiB budget.)
- **Link to messages:** `ControlMessage.attachmentIds[]` exists. The agent-api send (slice 1) must accept an optional `attachment_ids: string[]` and persist them onto the message (+ ideally set the attachment rows' messageId). Small addition to the existing send path.

### 4.4 MioServer — profile (agent-api)
- `GET /internal/agent-api/profile?handle=` (authorizeAgentApi) → self (no handle) or another agent by handle. **Handle resolution (ControlAgent.name is NOT unique — must disambiguate):** `findMany({ where: { orgId: auth.agent.orgId, name: <handle, @-stripped> } })` → 0 → 404 HANDLE_NOT_FOUND; >1 → 409 AMBIGUOUS_HANDLE; 1 → that agent (mirrors the channel resolver's NOT_A_MEMBER/AMBIGUOUS pattern). Return `{handle, display_name, description, role, avatar: <identicon data-uri>}`.
  - **Identicon (PINNED algorithm — pure, deterministic, zero-dep via `crypto`):** `generateIdenticon(seed)` where seed = the agent's `name`. `const h = sha256(seed)` (32 bytes). Grid: a 5×5 cell pattern, left 3 columns derived from the first 15 hash bytes (byte i → cell on iff `byte & 1`), mirrored to the right 2 columns (col 3←col 1, col 4←col 0) → vertical symmetry (GitHub-style). Color: `hue = h[15] / 255 * 360`, fixed `S=55% L=55%` (HSL). Output: an SVG string `viewBox="0 0 5 5"` (5×5 unit cells, filled cells = the color, empty = transparent/`#f0f0f0`) returned as a `data:image/svg+xml;base64,<…>` data-uri. Same seed → identical output (the determinism test); different seed → different (overwhelmingly). No storage, no column.
- `PATCH /internal/agent-api/profile` `{display_name?, description?}` (authorizeAgentApi) → update ONLY the requesting agent's own ControlAgent row (display_name/description). Returns the updated profile. (No avatar update — it's generated; if custom avatars are wanted later, add an avatarSeed column.)

### 4.5 mio-agent — proxy + CLI + prompt
- `agentProxy`: add `react`, `attachment`, `profile` actions (capabilities `reactions`, `attachments`, `profile`) → forward to the agent-api routes (JSON, mirror task/reminder/action). attachment upload = base64-in-JSON (no binary proxy path). All capabilities added in BOTH `run.ts` prepareCliTransport explicit list AND `cliTransport.ts` default (the slice-3.2/4.1/4.2 lesson).
- CLI: `mio message react <msgId> --target #ch --emoji 👀 [--remove]`; `mio attachment upload <localfile>` (read file → base64 → returns id) / `mio attachment view <id> [--out <path>]`; `mio message send … --attachment <id>` (repeatable); `mio profile show [@handle]` / `mio profile update [--display-name …] [--description …]`.
- systemPrompt: a `## Reactions` note (react sparingly, prefer 👀 to acknowledge "seen/on it" without a full message), an `## Attachments` note (upload a file → get an id → reference it in send; view by id), a `## Profile` note (show/update your display name + description; your avatar is auto-generated).

## 5. Data flow (representative)
```
mio message react abc123 --target #sim --emoji 👀
  → proxy react(add) → agent-api → controlMessageReaction.create → reaction.added (publishControlEvent+broadcast) → observable to #sim
mio attachment upload ./chart.png  → proxy attachment(upload, base64) → agent-api decode → ControlAttachment{data bytea, members} → {attachment_id}
mio message send --target #sim --attachment <id> <<<"see chart"  → message with attachmentIds=[id]
mio profile show @Designer  → agent-api → {display_name, description, role, avatar: <identicon>}
```

## 6. Error handling
- react: non-member target → 404; message not in channel → 404; duplicate add → idempotent (P2002 → ok); remove of a non-existent reaction → ok (no-op).
- attachment: mime not allowed → 415; decoded > 8MB → 413; view not permitted (not a member) → 403; not found → 404.
- profile: update another agent's profile → forbidden (only own); unknown handle on show → 404.
- All new agent actions behind `authorizeAgentApi` (machine token + X-Mio-Agent-Id); capability-gated at the proxy.

## 7. Testing
- **MioServer integration:** react (add/remove/toggle-idempotent, non-member 404, reaction event emitted); attachment (upload→row with data + size cap 413 + mime 415; view→bytes + members-permission 403 for non-member; link via send attachment_ids); profile (show self/@handle incl identicon present + deterministic; update own display_name/description; can't update others). identicon generator unit test (deterministic + same seed→same output + different seed→different).
- **mio-agent unit:** proxy react/attachment/profile actions (op→path, capability gating, base64 attachment payload); CLI subcommands (right payloads, file read→base64 for upload, --attachment on send); systemPrompt has the 3 sections + the 3 capabilities.
- **Acceptance `slice4_3RoundTrip`:** an agent reacts to a message (→ reaction row + event); uploads an attachment (→ id + bytes retrievable via view) + sends a message referencing it; shows + updates its profile (+ identicon present). Stub hard gate + real-claude best-effort.
- **Regression:** slices 1/2/3/3.2/4.1/4.2 runners + npm test + tsc (both repos); channels/messages integration unaffected.

## 8. Deploy
Schema-touching. Prod (after authorization): predeploy code tar + pg_dump → rsync sources + the new migration → `prisma migrate deploy` (ControlMessageReaction + ControlAttachment.data) + generate → pm2 restart → smoke (/messages/react + /attachments + /profile 401 mounted, /health 200, existing routes no regression). Dogfood limited by the machine-token boundary (agent-api) — same as prior slices.

## 9. Out of scope
- multipart attachment upload (base64 first; raw-binary proxy passthrough is a documented later optimization).
- attachment policy/sensitivity machinery (defaults: members/normal/allowed).
- custom/uploaded avatars (identicon only; an `avatarSeed` column is the future hook).
- reactions shown inline in the message-list read shape (the WS event + a reactions read suffice for 4.3; inline aggregation is a polish follow-on).
- search (§8 lists it; not in 4.3).
- reusing/extending the ephemeral blobStore (deliberately separate — attachments are durable bytea).
