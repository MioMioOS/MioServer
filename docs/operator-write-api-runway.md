# Operator Write API — Implementation Runway (#91)

Status: living runway doc (API/auth/audit/deploy lane, owner @运维)
Purpose: sequence the operator-write capability + `operator_session` server work across slices so the
lane keeps moving without tripping a deploy gate or a hard security prerequisite. This is the API
counterpart to the UI lane; integration points are gates, not blockers.

Source contracts:
- `CodeLight/docs/productization/operator-write-capability-contract-v1.md` (#80, hardened)
- `CodeLight/docs/productization/operator-session-issuance-decision-v1.md` (#85, scope-reset to
  simple bearer token)

2026-05-22 scope reset:
- **No server-held secrets.** CredentialStore / SSM / cloud secret provider is out of the current
  product path.
- **Operator write stays in the mainline.** It closes the human-in-the-loop loop: phone CodeLight →
  MioServer control plane → local daemon → local Claude Code / Codex.
- **V1 auth is simple writable bearer session.** No Ed25519, no nonce request signing in the current
  mainline. Signing is future hardening for a broader threat model.

---

## Slice status + order

| Slice | Task | What | Depends on | State |
|---|---|---|---|---|
| 1 | #82 | Shared capability model types (TS + Swift), `capability_version` + `action_version` (two markers) | — | ✅ done |
| 2 | #83 | GET action emits `read_only_demo` capabilities (dev_ctl_ session); added real `ControlAction.updatedAt` | #82 | ✅ done (in_review) |
| 3 | #84 | CodeLight renders Operator Actions from server capabilities (no POST) | #83 | ✅ done |
| 5 | #86 | `operator_session` schema + root/owner-only CLI mint/revoke (`op_sess_` class) | #82 contract | ✅ done |
| 6 | #96 | Simple writable bearer verifier (hash lookup, TTL/revoke/scope/command, dev_ctl hard reject) | #86 | ⏳ next |
| 7 | #88 | Operator write audit transaction model (audit + mutation same DB tx) | #86 | ⏳ Aaron |
| 8 | #97 | Write endpoints (`acknowledge`/`mark-reviewed`/`approve`/`retry`) | #96 + #88 | ⏳ next |
| 9 | #98 | CodeLight connects confirmation sheet to POST endpoints | #97 | ⏳ later |
| H | #87 | Ed25519 request signing verifier | broader threat model | ⏸ future hardening |

Order: **#96 + #88 → #97 → #98**. #87 is not a current gate.

---

## Hard security prerequisites (do NOT skip — from #80/#85 review)

1. **`dev_ctl_` hard-reject on every write endpoint.** Two token classes stay distinct:
   `dev_ctl_` = read-only allowlist; `op_sess_` = scoped writes. A dev token on any POST → 401/403.
2. **`op_sess_` is a separate token class** (not a reused dev token). Root/owner-only CLI mint, raw
   token printed once, only hash stored. Commands are explicitly scoped per session.
3. **Simple bearer auth is V1.** Verify `sha256(raw_token)`, TTL, revocation, workroom scope, command
   scope, and HTTPS transport. Request signing / nonce replay protection is future hardening, not a
   blocker for the single-owner local daemon flow.
4. **Idempotency remains required.** It prevents duplicate effects, but do not call it anti-replay.
5. **Audit + mutation atomic.** Every write commits its audit row in the SAME DB transaction as the
   action mutation (no orphan audit, no unaudited mutation). `operator_subject_id` opaque to clients,
   resolvable only in restricted server-side forensics.
6. **Stale-write CAS.** Writes echo `capability_version` + `action_version`; server rejects 409 if the
   action was mutated since. `action_version` is backed by the real `ControlAction.updatedAt` (#83).
7. **No-leak.** Capabilities + audit + error responses carry no token, raw evidence, credential/secret
   metadata, path, or provider error. Errors use controlled copy (no expired-vs-revoked-vs-scope distinction).

---

## Deploy gates (ops lane — @运维)

- 🔴 **#83 capabilities + migration co-deploy:** `prisma/migrations/20260522100000_add_control_action_updated_at`
  MUST be applied to `mio.wdao.chat` in the SAME deploy as the capabilities code. If the code ships
  without the column, dev-session GET `/actions/:id` errors on the missing `updated_at`. (Not yet
  deployed to prod — mio.wdao.chat still runs the pre-#59 build.)
- **CredentialStore is out of current product scope:** leave `CREDENTIAL_STORE_PROVIDER` unset. Do not
  introduce SSM/cloud secret setup for operator writes.
- **`op_sess_` schema migration (#86):** new table + indexes — additive, deploy with the mint CLI.
- **Mint CLI is prod-safe by design:** no HTTP issuance; root/owner-only; same posture as the #32
  dev-token mint (no `POST /…/tokens` surface).

---

## Open decisions (raise before the dependent slice)

- #86 operator_subject source for V1: local owner id / server admin id / explicit CLI arg.
- `mark_reviewed`: changes action status, or records a separate review marker? (affects #88 audit + CAS).
