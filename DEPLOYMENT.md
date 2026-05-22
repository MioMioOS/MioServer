# MioServer Deployment Guide

## Migration Strategy

MioServer uses Prisma Migrate for schema management. The migration chain starts
at `00000000000000_init` (base tables) and is applied incrementally via
`prisma migrate deploy`.

### Fresh database (new deployment)

```bash
DATABASE_URL="postgresql://..." npx prisma migrate deploy
```

Prisma runs all migrations from `00000000000000_init` onward. No extra steps.

### Existing database previously created with `prisma db push`

> ⚠️ **Do NOT use `migrate resolve --applied init` + `migrate deploy` on a
> db-push database.** The incremental migrations use `ALTER TABLE ... ADD COLUMN`
> statements. Because `db push` already created every column, the ALTER
> statements will fail with "column already exists".

The correct procedure is **drop, recreate, and fresh deploy**:

```bash
# 1. Drop the existing database (all data is lost — only do this on a dev/test DB)
psql -U <user> -c "DROP DATABASE mioserver;"
psql -U <user> -c "CREATE DATABASE mioserver;"

# 2. Run all migrations from scratch
DATABASE_URL="postgresql://..." npx prisma migrate deploy
```

This is what was done for the `mioserver` DB on `106.54.19.137` during the
initial production deployment (2026-05-21).

---

## Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3005` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address. Set `HOST=127.0.0.1` behind nginx for defense-in-depth |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `MASTER_SECRET` | — | JWT signing secret (required) |
| `TOKEN_EXPIRY_DAYS` | `30` | JWT validity window |
| `ENFORCE_SUBSCRIPTION` | `true` | Set `false` to skip subscription checks in dev |
| `CREDENTIAL_STORE_PROVIDER` | _(unset)_ | CredentialStore selector: `fixture` \| `aesfile` \| `ssm` \| `kms` \| `vault`. **Unset = no store → credentialed actions fail-safe to `needs_human`.** ⚠️ See pre-deploy check below — a wrong value crashes startup (fail-closed). |
| `CREDENTIAL_STORE_AESFILE_PATH` | `~/.mio/credentials.enc` | aesfile only: encrypted store path (non-secret). |
| `CREDENTIAL_STORE_KEK_KEYCHAIN_SERVICE` | `mio-credential-kek` | aesfile only: macOS Keychain item **name** (non-secret) holding the KEK. |
| `CREDENTIAL_STORE_KEK_KEYCHAIN_ACCOUNT` | `mio` | aesfile only: macOS Keychain account **name** (non-secret). |

> 🔑 **The AesFile KEK value is NEVER an environment variable** (invariant: it must not share the
> `.env`/DB dump surface). It is read from the macOS Keychain at bootstrap. Only the non-secret
> *names* that locate the Keychain item live in env. On Linux (staging/prod) `aesfile` is refused —
> use a managed-secret provider (`ssm`/`kms`/`vault`).

### Production nginx setup (mio.wdao.chat)

The app is bound to `127.0.0.1:4000` (`HOST=127.0.0.1`, `PORT=4000`) and
served through nginx over TLS. Direct port access is blocked by cloud security
group (only 80/443/22 open).

```
.env (server):
  PORT=4000
  HOST=127.0.0.1
  DATABASE_URL=postgresql://...
```

---

## PM2 (process manager)

```bash
# Start
pm2 start dist/index.js --name mioserver

# Restart after config change
pm2 restart mioserver

# Logs
pm2 logs mioserver
```

---

## ⚠️ CredentialStore wiring — mandatory pre-deploy check (#75/#77)

Since #75, the server provisions a `CredentialStore` at bootstrap via
`provisionCredentialStore()` (`sources/control/credentials/provisionCredentialStore.ts`).
This is **fail-closed**: a misconfigured provider makes the server **refuse to start**, and under
pm2 the new process will **crash-loop while the old one is already stopped → service outage.**

**Before deploying any build that contains the CredentialStore wiring, check the provider on the box:**

```bash
# On the prod box (and in the pm2 env, since pm2 may cache env from when it was started):
echo "shell: ${CREDENTIAL_STORE_PROVIDER:-<unset>}"
pm2 env mioserver | grep -i CREDENTIAL_STORE_PROVIDER || echo "pm2: <unset>"
```

Decision table:

| `CREDENTIAL_STORE_PROVIDER` | Effect on startup | Safe to deploy? |
|---|---|---|
| **unset / empty** | No store provisioned → credentialed actions fail-safe to `needs_human`. **Behavior identical to pre-#75.** | ✅ Yes — zero behavior change |
| `ssm` / `kms` / `vault` **before #73 + adapter exist** | Bootstrap throws `not_implemented` → process exits → **pm2 crash-loop → outage** | ❌ No — do NOT deploy until the adapter is built (#73) |
| `fixture` / `aesfile` **in production** | Prod allow-list refuses (dev/test stores forbidden in prod) → startup fails | ❌ No |
| `aesfile` (dev-mac only) without a Keychain KEK | Bootstrap throws (no fabricated KEK) | ❌ No (provision the Keychain KEK first) |
| a valid, implemented prod provider (future) | Store provisioned, server starts | ✅ Yes |

> **Current prod box state (mio.wdao.chat, 2026-05-22): `CREDENTIAL_STORE_PROVIDER` is unset** →
> the #75 wiring is safe to deploy with no behavior change. Do not set it to `ssm/kms/vault` until
> the adapter lands (#73). If a deploy ever does change it, roll back by unsetting the var and
> `pm2 restart mioserver` (returns to the safe `needs_human` fail-safe).

**Rollback:** if a CredentialStore misconfig takes the service down, `unset CREDENTIAL_STORE_PROVIDER`
(remove it from `.env` / pm2 env) and `pm2 restart mioserver` — startup then provisions no store and
the server comes back up in the `needs_human` fail-safe state.
