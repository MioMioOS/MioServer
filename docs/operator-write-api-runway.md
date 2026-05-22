# Operator Write API — Implementation Runway (#91)

Status: living runway doc (API/auth/audit/deploy lane, owner @运维)
Purpose: sequence the operator-write capability + `operator_session` server work across slices so the
lane keeps moving without tripping a deploy gate or a hard security prerequisite. This is the API
counterpart to the UI lane; integration points are gates, not blockers.

Source contracts:
- `CodeLight/docs/productization/operator-write-capability-contract-v1.md` (#80, hardened)
- `CodeLight/docs/productization/operator-session-issuance-decision-v1.md` (#85, hardened)

---

## Slice status + order

| Slice | Task | What | Depends on | State |
|---|---|---|---|---|
| 1 | #82 | Shared capability model types (TS + Swift), `capability_version` + `action_version` (two markers) | — | ✅ done |
| 2 | #83 | GET action emits `read_only_demo` capabilities (dev_ctl_ session); added real `ControlAction.updatedAt` | #82 | ✅ done (in_review) |
| 3 | #84 | CodeLight renders Operator Actions from server capabilities (no POST) | #83 | ⏳ Aaron |
| 5 | #86 | `operator_session` schema + root/owner-only CLI mint/revoke (`op_sess_` class) | #82 contract | 🟦 mine, in_progress |
| 6 | #87 | Request signing verifier (nonce/timestamp/body-hash + key material) | **#86 + key-material decision** | 🔒 gated |
| 7 | #88 | Operator write audit transaction model (audit + mutation same DB tx) | #86 | ⏳ queued |
| — | write endpoints (`acknowledge`/`mark-reviewed`) | first real writes | #86 + #87 + #88 | ⏳ later |

Order: **#86 → (#87 ‖ #88) → write endpoints**. #84 (UI) runs in parallel and only consumes #83.

---

## Hard security prerequisites (do NOT skip — from #80/#85 review)

1. **`dev_ctl_` hard-reject on every write endpoint.** Two token classes stay distinct:
   `dev_ctl_` = read-only allowlist; `op_sess_` = scoped writes. A dev token on any POST → 401/403.
2. **`op_sess_` is a separate token class** (not a reused dev token). Root/owner-only CLI mint, raw
   token printed once, only hash stored. Default commands: `acknowledge_needs_human` + `mark_reviewed`
   only (NOT approve/retry).
3. **Anti-replay ≠ idempotency.** Writes require nonce + timestamp + method/path/body-hash + signature.
   - 🔴 **#87 key-material decision (blocks #87):** `sha256(raw_token)` (bearer-auth lookup) CANNOT verify
     an HMAC signed with the raw token. Choose ONE before implementing the verifier:
     (a) store an encrypted, server-verifiable symmetric MAC key (separate from the bearer hash); or
     (b) asymmetric signing — client holds private key, server stores public key.
   - 🔴 **Nonce store durability (#87):** must survive restarts for ≥ the timestamp skew window
     (Postgres or cache-with-DB-fallback). In-memory-only is replay-vulnerable after restart and is
     only acceptable for an explicit local-only demo.
4. **Audit + mutation atomic.** Every write commits its audit row in the SAME DB transaction as the
   action mutation (no orphan audit, no unaudited mutation). `operator_subject_id` opaque to clients,
   resolvable only in restricted server-side forensics.
5. **Stale-write CAS.** Writes echo `capability_version` + `action_version`; server rejects 409 if the
   action was mutated since. `action_version` is backed by the real `ControlAction.updatedAt` (#83).
6. **No-leak.** Capabilities + audit + error responses carry no token / credential alias / storage_ref /
   secret path / vendor error. Errors use controlled copy (no expired-vs-revoked-vs-scope distinction).

---

## Deploy gates (ops lane — @运维)

- 🔴 **#83 capabilities + migration co-deploy:** `prisma/migrations/20260522100000_add_control_action_updated_at`
  MUST be applied to `mio.wdao.chat` in the SAME deploy as the capabilities code. If the code ships
  without the column, dev-session GET `/actions/:id` errors on the missing `updated_at`. (Not yet
  deployed to prod — mio.wdao.chat still runs the pre-#59 build.)
- **CredentialStore provider preflight (#77):** unrelated to writes, but every MioServer deploy must
  still pre-check `CREDENTIAL_STORE_PROVIDER` (unset = safe). See DEPLOYMENT.md.
- **`op_sess_` schema migration (#86):** new table + indexes — additive, deploy with the mint CLI.
- **Mint CLI is prod-safe by design:** no HTTP issuance; root/owner-only; same posture as the #32
  dev-token mint (no `POST /…/tokens` surface).

---

## Open decisions (raise before the dependent slice)

- #87 key-material model: encrypted symmetric MAC key vs asymmetric (decide before #87).
- #86 operator_subject source for V1: local owner id / server admin id / explicit CLI arg.
- #87 nonce history store: Postgres vs cache-with-DB-fallback.
- `mark_reviewed`: changes action status, or records a separate review marker? (affects #88 audit + CAS).
