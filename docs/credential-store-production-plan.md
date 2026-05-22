# Production CredentialStore Adapter Plan (#69)

Status: **design spec** (strict-lane). Owner: @运维. Reviewers: @Research (product), @Aaron (impl feasibility).
Scope: take production `CredentialStore` from "unimplemented blocker" to an executable plan.
Non-goals: write the adapter code now; pick a final cloud vendor contract; build credential admin UI.

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
- **Audit**: emit an audit event on each resolve — `{ credentialId, orgId, storageRef (opaque), outcome, timestamp, adapter }` — **without the value**. Prefer the adapter's own audit (KMS/Vault/SSM access logs) PLUS a MioServer-side control-plane audit row so resolves are traceable to action/org even if the cloud audit is separate.
- **Failure → needs_human**: all 3 error reasons drive the action to `needs_human` (already wired), never a silent success (consistent with the exit-0-not-trust principle).

---

## 6. MVP recommendation (support the next real action, not all-at-once)

1. **MVP provider = Cloud Secrets Manager matching the deploy** (the box is Tencent Cloud → **Tencent SSM**), behind a thin `SsmCredentialStore implements CredentialStore`. Rationale: managed + audited + rotation + no KEK-on-box + no Vault to operate; smallest secure step to run one real credentialed action.
   - If multi-cloud/vendor-neutral is required later, the **KMS-envelope** adapter is the fallback (works with any KMS; we hold ciphertext).
2. **Keep `AesFileCredentialStore`** for owner-mac local dev (unchanged).
3. **Defer Vault** until dynamic/short-lived secrets or fine-grained per-action policy is actually needed (heavier ops; not justified for the first credentialed action).
4. **Factory + positive prod allow-list**: `NODE_ENV=production` must select a production provider or fail closed (extend `assertNotProduction`).

### Implementation slices (separate tasks)
1. `CredentialStore` factory + `CREDENTIAL_STORE_PROVIDER` env + prod allow-list (fail-closed).
2. `SsmCredentialStore` (Tencent SSM) — implements interface, maps errors to controlled reasons, no value logging.
3. MioServer-side resolve-audit row (credentialId/orgId/storageRef/outcome, no value).
4. Staging wiring + one end-to-end credentialed-action test (real adapter, no-leak assertion) before any prod credential.

---

## 7. Open questions for review
- @Research: env split (local-demo / remote-test / prod) — does staging need full Tencent SSM, or is a sealed file w/ Keychain-less KEK acceptable for staging only? (Current stance: staging = prod adapter, no env-KEK.)
- @Aaron: feasibility of Tencent SSM SDK in the Node/tsx runtime + instance-role auth on the box.
- Vendor lock: SSM-first vs KMS-envelope-first (vendor-neutral) — pick based on whether multi-cloud is a near-term need.
