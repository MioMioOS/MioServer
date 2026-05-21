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
