# Operator Session Request Signing — Key Material Decision (#87)

> ## ⏸️ NOT CURRENT MAINLINE — FUTURE HARDENING ONLY (2026-05-22, Laurent + PM)
> **V1 operator write auth = a SIMPLE writable session token** (bearer; hash-only stored;
> workroom/command-scoped; short TTL; revocable; HTTPS; uniform 401/403; `dev_ctl_` stays read-only
> hard-reject). NO request signing, NO nonce, NO Ed25519. Rationale: the product is single-user
> controlling their OWN agents on their OWN device (phone → server → own daemon) — TLS + a scoped
> bearer token covers that threat model; Ed25519+nonce is for an UNTRUSTED/MULTI-OPERATOR/public-API
> scenario we don't have.
>
> This Ed25519 design is retained ONLY as a **future hardening** option, to be revisited if/when a
> multi-operator or untrusted-client scenario appears. It is NOT to be implemented now.
> The live V1 token is the existing `ControlOperatorSession` (#86) used as a plain bearer; the
> `signing_public_key` column + nonce table described below are NOT added in V1.

Status: ~~decision note~~ **FUTURE HARDENING — not current mainline (see banner).** (API/auth lane, owner @运维.)
Pairs with: `CodeLight/docs/productization/operator-session-issuance-decision-v1.md` (#85),
`docs/operator-write-api-runway.md` (#91). Hard prerequisite flagged in the #80/#85 reviews.

## The problem

`operator_session` write requests need a **request-bound anti-replay proof** (nonce + timestamp +
method + path + body-hash + signature) — idempotency keys are NOT anti-replay. The open question
(#80/#85): **what key material backs that signature?** A critical constraint surfaced in review:

> The bearer token is stored as `sha256(raw_token)` for auth lookup. You CANNOT verify an HMAC
> signed with the raw token from its hash — the raw key is not recoverable. So the signing key
> material must be a SEPARATE concern from the bearer-auth hash.

Two viable designs:

| | A. Encrypted symmetric MAC key | B. Asymmetric signing |
|---|---|---|
| Mint | generate random MAC key K; return K once | generate keypair; return private key once |
| Server stores | K **encrypted** (needs a server KEK) | **public key only** (non-secret) |
| Client signs | HMAC-SHA256(K, canonical-request) | Ed25519 sign(privKey, canonical-request) |
| Server verifies | decrypt K → recompute HMAC → compare | verify(pubKey, sig) — no secret needed |
| DB-dump blast radius | leaked ciphertext + KEK ⇒ forge | public key only ⇒ **cannot forge** |
| KEK dependency | yes (ties to CredentialStore KEK infra #69/#72) | none |

## Decision

**Use B — asymmetric signing (Ed25519).** The server stores ONLY the operator session's **public
key**; the private key is generated at mint, returned to the operator once, and never stored
server-side.

Rationale:
1. **Smaller blast radius.** A DB dump exposes only public keys — an attacker cannot forge a signed
   request. With the symmetric option, the (encrypted) MAC key sits in the DB and is forgeable if
   the server KEK also leaks (same dump surface concern that drove the CredentialStore design #69).
2. **No KEK coupling.** Verification needs no decryption and no server KEK — it is independent of the
   CredentialStore KEK infra (#69/#72). One less secret to manage on the box / in prod.
3. **Native + simple.** Node `crypto` supports Ed25519 (`generateKeyPairSync('ed25519')`,
   `sign`/`verify`) with no external dependency; small, fast, well-vetted.

Trade-off accepted: the operator client must hold a private key — but a client must hold *some*
signing material in either design; the win is entirely server-side (no decryptable secret at rest).

## Resulting design (for #87 implementation)

1. **Schema delta (#87, not #86):** add `signing_public_key TEXT` to `control_operator_sessions`
   (the #86 schema deliberately omitted any signing-key column — this is where it lands). Migration
   `2026XXXX_add_operator_session_signing_public_key`. Public key is non-secret → plain column OK.
2. **Mint change (extends #86 `mintOperatorSession`):** also `generateKeyPairSync('ed25519')`, store
   the public key (SPKI/raw), return the **private key (PKCS8/raw) once** alongside the bearer token.
   The private key is **as sensitive as the bearer token** (Research #87 constraint 3): returned to
   the operator ONCE via stdout only, never persisted server-side and never written to any log, DB
   column, audit row, EventLog payload, or UI surface.
3. **Canonical request string** (client + server must agree byte-for-byte):
   `v1\n<METHOD>\n<PATH>\n<sha256(body) hex>\n<unix-timestamp>\n<nonce>`
   - `<PATH>` = normalized path **including query string** (if a write endpoint ever takes query
     params), so the signature binds the full target. (Research #87 constraint 2.)
   - body hash is computed over the **raw request body bytes** (pre-parse), so client/server JSON
     re-serialization differences cannot break verification. (Research #87 constraint 2.)
4. **Verifier (`verifyOperatorSession`)** — STRICT ORDER (Research #87 constraint 1):
   - look up session by `sha256(bearer)`; reject if missing/expired/revoked;
   - check timestamp within skew window (proposed ±300s);
   - **verify the signature FIRST** (`crypto.verify(null, canonicalBytes, pubKey, sigBytes)`) — reject on failure;
   - **THEN consume the nonce** via a unique INSERT (only after timestamp + signature pass) — so an
     invalid-signature request can NEVER burn a legitimate nonce; concurrent replay of a valid
     request is rejected by the `UNIQUE(session_id, nonce)` constraint (P2002);
   - check command ∈ session.allowedCommands and workroom/org in scope;
   - all failures → uniform controlled error (no expired/revoked/scope distinction).
5. **Nonce store (durability, per #85):** table `control_operator_session_nonces`
   (`session_id`, `nonce`, `seen_at`, UNIQUE(`session_id`,`nonce`)). Insert-on-use; a duplicate
   insert (P2002) = replay → reject. Prune rows older than the skew window. **Postgres-backed so it
   survives restarts within the skew window** (in-memory-only is replay-vulnerable after restart —
   not acceptable outside a local-only demo).
6. **Audit (ties to #88):** the write audit row records nonce-hash/id + outcome in the SAME DB
   transaction as the action mutation.

## Open sub-questions (resolve during #87 impl)

- Exact key encodings (SPKI base64 for public, PKCS8 base64 for private) and whether the operator
  client lib generates the keypair locally (server stores submitted public key) vs server generates
  + returns private key. Default: **server generates at mint** (simplest, one CLI step).
- Skew window value (proposed ±300s) and nonce-prune cadence.
- Clock-skew handling for distributed operator clients (V1: single owner/operator → low risk).
