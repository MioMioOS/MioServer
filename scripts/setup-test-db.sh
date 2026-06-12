#!/usr/bin/env bash
#
# setup-test-db.sh — provision the local Postgres test database for integration tests.
#
# Creates a dedicated `codelight_test` database (dropping any existing one) and syncs
# the current Prisma schema into it via `prisma db push`. Integration tests
# (*.integration.spec.ts) run against this DB; the default `npm test` does NOT need it.
#
# Usage:
#   npm run test:db:setup            # uses defaults below
#   PGHOST=... PGPORT=... PGUSER=... PGPASSWORD=... TEST_DB=... npm run test:db:setup
#
# Requirements: a running local Postgres and the `psql` + `prisma` CLIs.
#
# NOTE on schema source (important for fidelity):
#   We apply the FULL prisma migration chain (`prisma migrate deploy`), NOT `prisma
#   db push`. Reason: `db push` materializes Prisma `String` ids as `text`, while the
#   production migrations declare native `UUID` — raw ::uuid casts in the codebase
#   (e.g. publishControlEvent's FOR UPDATE) then fail. Deploying the migration SQL
#   verbatim reproduces production column types faithfully.
#
#   HISTORY: this script used to apply a hand-maintained CONTROL-PLANE-ONLY subset,
#   because the full chain was "not cleanly replayable on a fresh DB". Both halves of
#   that rationale died on 2026-06-12: (a) the replay blocker (Device.userId applied
#   to prod out-of-band) is fixed by migration 20260612000000_device_user_id_baseline,
#   and (b) the control plane now QUERIES legacy tables (the enrollment approve's
#   Device bridge, machineEnrollmentRoutes.ts) — a Device-less test DB made every
#   approve throw and turned the enrollment integration suite red. Full chain = the
#   real schema, no subset drift, no manual array to forget migrations in.

set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
PGPASSWORD="${PGPASSWORD:-postgres}"
TEST_DB="${TEST_DB:-codelight_test}"
export PGPASSWORD

# Guard: the test DB name must contain "test" so we never drop a dev/prod DB.
if [[ "$TEST_DB" != *test* ]]; then
  echo "ERROR: TEST_DB='$TEST_DB' must contain 'test' (refusing to drop a non-test database)." >&2
  exit 1
fi

DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${TEST_DB}"

echo "==> Dropping and recreating database '${TEST_DB}' on ${PGHOST}:${PGPORT}"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -c "DROP DATABASE IF EXISTS \"${TEST_DB}\";"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -c "CREATE DATABASE \"${TEST_DB}\";"

# Apply the full migration chain (real UUID column types, legacy + control plane).
echo "==> Applying full prisma migration chain"
DATABASE_URL="$DATABASE_URL" ./node_modules/.bin/prisma migrate deploy

echo "==> Test DB ready."
echo "    DATABASE_URL=${DATABASE_URL}"
echo "    Run integration tests with:  npm run test:integration"
