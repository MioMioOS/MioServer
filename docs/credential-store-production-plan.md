# Production CredentialStore Adapter Plan (#69)

> ## ⛔ SUPERSEDED — OUT OF SCOPE (2026-05-22, Laurent + PM, #95)
> **The product is LOCAL-AUTH-ONLY: it orchestrates the user's own local Claude Code / Codex, which
> authenticate with the user's local login. The server holds NO secrets and resolves NO credentials.**
> If the user's local Claude/Codex isn't logged in, the product shows "needs login/config" and does
> not execute — there is nothing for the server to resolve.
>
> Therefore this entire production-CredentialStore line is **not pursued**: no SSM, no cloud secret
> manager, no server-hosted secret, no production provider adapter. **#73 closed; #87/#88 (operator
> write signing) stopped** as far-future off-scope complexity.
>
> What remains in code is HARMLESS and DORMANT: the `CredentialStore` interface + factory + fail-closed
> guard stay as a safety net (production `CREDENTIAL_STORE_PROVIDER` is unset → any hypothetical
> credentialed action fail-closes to `needs_human`). No provider is ever configured. Ripping the
> dormant code out is an optional later cleanup, not required (it cannot run a secret path).
>
> The rest of this doc is retained as HISTORICAL design record only.

Status: ~~design spec (strict-lane)~~ **SUPERSEDED — see banner above.** Owner: @运维.
**2026-05-22 pivot (#95, see §6):** VENDOR-NEUTRAL — NOT bound to Tencent SSM (or any cloud). Provider
chosen per deployment when a real action needs it; until then production stays fail-closed (`needs_human`).
Scope: keep production `CredentialStore` vendor-neutral + fail-closed, with a pluggable provider abstraction.
Non-goals: commit to any cloud vendor now; build a cloud adapter before a real action needs it; credential admin UI.

---

## 1. Where we are

`sources/control/credentials/credentialStore.ts` already defines:
- **`CredentialStore` interface**: `resolve(storageRef, { credentialId, orgId }) → plaintext` (in-memory only).
- **Invariants (must hold for every adapter)**:
  1. plaintext only in memory — never logs / DB / EventLog;
  2. errors never contain secret values (even partial);
  3. `CredentialStoreError.reason` is a controlled enum (`store_unavailable` | `credential_not_found` | `credential_config_invalid`) — not the upstream vault/KMS error text;
  4. dev/test stores are **forbidden in production** (`assertNotProduction` fail-closed);
  5. any KEK must NOT come from `.env` (same dump surface as the DB).
- **Adapters that exist**: `FixtureCredentialStore` (CI/test), `AesFileCredentialStore` (dev-local, AES-256-GCM, KEK from OS Keychain/secrets-mgr).

**The gap (#69):** there is **no production adapter**. In prod, both existing stores throw at construction, so the control-plane fails closed — correct, but it means no real credentialed action can run until a production adapter exists.

---

## 2. Deployment environment → adapter mapping

| Env | Host | Adapter | KEK / auth source |
|---|---|---|---|
| CI / unit test | any | `FixtureCredentialStore` | none (in-memory test values) |
| local dev (owner mac) | macOS | `AesFileCredentialStore` | OS Keychain (KEK), NOT `.env` |
| **remote test / staging** (e.g. mio.wdao.chat dev) | **Linux** | **production adapter** (see §3) | KMS/secrets-mgr — **NOT** Keychain (Linux has none) and **NOT** env-KEK |
| **production** | Linux/cloud | **production adapter** (see §3) | KMS / Vault / cloud Secrets Manager |

Key constraint: the Linux box (Tencent Cloud) has **no OS Keychain**, and env-KEK is forbidden (invariant 5). So both staging and prod need a real managed-secret adapter — `AesFileCredentialStore` is dev-mac-only.

---

## 3. Candidate production adapters

| Adapter | `storageRef` is | `resolve()` does | Pros | Cons |
|---|---|---|---|---|
| **Cloud Secrets Manager** (Tencent SSM / AWS Secrets Mgr / GCP Secret Mgr) | secret name/ARN + version | API `getSecretValue` with an instance role / scoped credential | managed, rotation, per-access audit, no KEK on box | cloud dependency, per-call latency |
| **Cloud KMS + envelope encryption** | ciphertext blob ref (DEK-encrypted) | KMS `decrypt` the DEK → AES-decrypt the value locally | only ciphertext at rest, KMS-audited, cheap storage | we manage the ciphertext store; 2-step |
| **HashiCorp Vault** | vault path | `vault read` with AppRole/scoped token | dynamic secrets, fine-grained policy, strong audit | run+maintain Vault; heavier ops |
| **OS Keychain** | keychain item id | keychain query | simple on mac | **mac-only** — not for Linux prod |

Selection lives in a **factory** keyed by env (`CREDENTIAL_STORE_PROVIDER` = `fixture|aesfile|ssm|kms|vault`), with `NODE_ENV=production` requiring one of the production providers (extend the existing `assertNotProduction` to a positive allow-list).

---

## 4. secret_bundle unpacking boundary (must stay daemon/runtime secret-blind)

This is unchanged by adapter choice and must be preserved:

- `resolve()` runs **server-side** in MioServer at **consume time** (`POST /actions/:id/token/consume`, action_token bearer).
- The resolved plaintext goes **only** into the `secret_bundle` returned to the **runtime subprocess** in the consume response — used immediately, scrubbed after.
- The **daemon never sees plaintext**: it relays a 0600 action_token file, not the secret; it does not call resolve and never holds a CredentialStore.
- The **runtime** is the only place plaintext lands, transiently. (Confirmed by the 5D / mio-agent design: daemon secret-blind, runtime uses+scrubs.)

So a production adapter only changes **where MioServer fetches plaintext**; it must NOT widen who sees it. The adapter is constructed and used **only** inside the consume path, never exposed to routes that echo data.

---

## 5. No-leak + audit requirements (per adapter)

- **No-leak**: `resolve()` returns plaintext only in memory; never log the value; map ALL upstream errors (KMS/Vault/SSM) to the 3 controlled `CredentialStoreError` reasons — never surface the vendor error string (it can contain ref/policy detail). `storage_ref`, credential alias, token, file path must never appear in responses/logs (already enforced; CodeLight redactor + #59 cover the read surface).
- **Audit**: emit an audit event on each resolve — `{ credentialId, orgId, storageRef (opaque), outcome, timestamp, adapter }` — **without the value**. The `storageRef` (even opaque) belongs **only in the restricted resolve-audit table / internal audit fields — never in EventLog, UI, or general application logs** (consistent with "storage_ref must not appear in responses/logs"). Prefer the adapter's own audit (KMS/Vault/SSM access logs) PLUS this MioServer-side audit row so resolves are traceable to action/org even if the cloud audit is separate.
- **Failure mapping** (do NOT collapse two distinct outcomes):
  - **Adapter resolve errors** (infra-level: `store_unavailable` / `credential_not_found` / `credential_config_invalid` — store unreachable, ref missing, ref malformed) → action → `needs_human` (already wired), never a silent success (exit-0-not-trust).
  - **Credential auth/policy denial** (the credential exists but the resolve is *denied* by the adapter's policy/IAM) → keep the 5D decision: action → **`failed + credential_denied`**, NOT `needs_human`. A denial is an authorization failure, not a recoverable infra blip; the adapter must surface denial as a distinct controlled signal so the route maps it to `credential_denied`, not `store_unavailable`.

---

## 6. Recommendation — VENDOR-NEUTRAL, pick the provider when a real action needs it (#95 pivot)

> **2026-05-22 decision (Laurent + PM, task #95, #73 closed):** do NOT bind the production
> CredentialStore to any cloud vendor (no Tencent SSM commitment). Keep the provider abstraction;
> choose a backend only when a real credentialed action actually needs one, matching whatever
> deployment we're on then. Until then, **production `CREDENTIAL_STORE_PROVIDER` stays unset =
> fail-closed → credentialed actions go to `needs_human`** (safe, no fake success).

1. **No cloud commitment now.** The `CredentialStore` interface + factory (#72) are already
   vendor-neutral: a backend is one `CREDENTIAL_STORE_PROVIDER` switch. Switching/adding a vendor
   later changes only a factory branch — interface, no-leak, audit, and fail-closed guard are stable.
2. **Near-term demo route = `AesFileCredentialStore` (ALREADY BUILT).** If a demo needs a real
   credential on the owner Mac, use the existing AES-256-GCM sealed-file store with the **KEK from the
   macOS Keychain** (never `.env`). This is vendor-neutral, fail-closed, no-leak — and the factory
   (#72) + bootstrap wiring (#75) + deploy preflight (#77) already support it (`aesfile` provider).
3. **Future production providers are pluggable, choose on need:** AWS Secrets Manager / GCP Secret
   Manager / HashiCorp Vault / KMS-envelope / Tencent SSM — ANY can be added as a provider when the
   actual deployment is known. None is privileged; none is required now.
4. **Factory + positive prod allow-list (DONE, #72):** `NODE_ENV=production` only permits a vetted
   production provider; fixture/aesfile/unknown/empty fail closed at startup.

### Implementation status / remaining slices
1. ✅ `CredentialStore` factory + `CREDENTIAL_STORE_PROVIDER` env + prod allow-list (fail-closed) — DONE (#72).
2. ✅ Bootstrap wiring (provisionCredentialStore) + deploy preflight — DONE (#75/#77); aesfile KEK from Keychain.
3. ✅ resolve-audit substantially covered by existing `ControlCredentialAccessLog` (credentialId/actionId/machineId/success/reasonCode); optional enrich (adapter name/orgId/opaque storageRef) deferred.
4. ⏳ A real cloud/Vault provider adapter — **deferred until a real credentialed action needs it**, then implement the one matching the deployment (no Tencent SSM prerequisite; #73 closed).

---

## 7. Open questions for review
- When a real credentialed action is first needed: which environment is it deployed on, and what is
  the simplest vendor-neutral KEK/secret source there? (On Linux/cloud there is no OS Keychain, so a
  managed-secret backend or KMS-envelope is chosen then — decided per deployment, not pre-committed.)
- ~~Tencent SSM SDK feasibility / instance-role auth~~ — dropped (#73 closed; no Tencent SSM).
- ~~SSM-first vs KMS-envelope-first~~ — moot; provider chosen on need, all pluggable.
