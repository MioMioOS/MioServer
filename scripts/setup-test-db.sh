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
# NOTE: db push is used (not `migrate deploy`) because the app's migration history
# is not cleanly applicable to a fresh DB; db push syncs the full schema in one shot,
# which is the appropriate tool for an ephemeral test database.

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

echo "==> Syncing Prisma schema into '${TEST_DB}' (prisma db push)"
DATABASE_URL="$DATABASE_URL" npx prisma db push --skip-generate --accept-data-loss

echo "==> Test DB ready."
echo "    DATABASE_URL=${DATABASE_URL}"
echo "    Run integration tests with:  npm run test:integration"
