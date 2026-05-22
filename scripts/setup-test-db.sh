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
#   We apply the CONTROL-PLANE migration SQL directly (psql -f), NOT `prisma db push`.
#   Reason: the Prisma schema declares ids as `String`, which `db push` materializes as
#   Postgres `text` columns. The production migrations declare them as native `UUID`.
#   Raw queries in the codebase cast parameters to ::uuid (e.g. publishControlEvent's
#   FOR UPDATE on control_workrooms), which require real `uuid` columns — a `text`
#   column makes `text = uuid` fail. Applying the migration SQL reproduces the real
#   uuid column types so integration tests exercise the production schema faithfully.
#   We apply only the self-contained control-plane migrations (they have no FK to the
#   app's Device/user tables), avoiding the app migration chain that is not cleanly
#   replayable on a fresh DB.

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

# Apply the control-plane migrations in order (real UUID column types).
CONTROL_PLANE_MIGRATIONS=(
  "prisma/migrations/20260521000000_add_control_plane/migration.sql"
  "prisma/migrations/20260521100000_add_control_action_tokens/migration.sql"
  "prisma/migrations/20260521200000_add_control_action_reconciliations/migration.sql"
  "prisma/migrations/20260521300000_5d_credential_scope/migration.sql"
  "prisma/migrations/20260521400000_add_control_dev_tokens/migration.sql"
  "prisma/migrations/20260522000000_add_reconciliation_runtime_warnings/migration.sql"
  "prisma/migrations/20260522100000_add_control_action_updated_at/migration.sql"
  "prisma/migrations/20260522110000_add_control_operator_sessions/migration.sql"
  "prisma/migrations/20260522120000_add_operator_audit_log/migration.sql"
  "prisma/migrations/20260522130000_add_reconciliation_output_log/migration.sql"
  "prisma/migrations/20260523001000_add_control_operator_pairings/migration.sql"
)
for migration in "${CONTROL_PLANE_MIGRATIONS[@]}"; do
  echo "==> Applying ${migration}"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$TEST_DB" -v ON_ERROR_STOP=1 -f "$migration"
done

echo "==> Test DB ready."
echo "    DATABASE_URL=${DATABASE_URL}"
echo "    Run integration tests with:  npm run test:integration"
