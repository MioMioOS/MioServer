/**
 * Integration test setup — REAL Postgres test database.
 *
 * Integration specs perform real INSERT/DELETE against the database in DATABASE_URL.
 * To make sure a dev/prod database is NEVER touched, this guard:
 *   1. Defaults DATABASE_URL to a local test DB if unset.
 *   2. HARD-FAILS (throws before any test) unless the target database name contains
 *      "test" — so pointing at `codelight` (dev) or any prod DB aborts immediately.
 *
 * Default (local dev): postgresql://postgres:postgres@127.0.0.1:5432/codelight_test
 * Override by exporting DATABASE_URL before `npm run test:integration`.
 *
 * Provision the test DB first:  npm run test:db:setup
 *
 * NOTE: this file must set DATABASE_URL before any test imports `@/storage/db`,
 * which is why it is registered as a setupFile (runs before the test module graph).
 */

const DEFAULT_TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/codelight_test';

if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = DEFAULT_TEST_DB_URL;
}

const url = process.env.DATABASE_URL;

function dbNameFromUrl(u: string): string {
    try {
        const parsed = new URL(u);
        return parsed.pathname.replace(/^\//, '').split('?')[0];
    } catch {
        return '';
    }
}

const dbName = dbNameFromUrl(url);

if (!/test/i.test(dbName)) {
    throw new Error(
        `[integration setup] Refusing to run integration tests.\n` +
            `  DATABASE_URL database name = "${dbName}"\n` +
            `  It must contain "test" so a dev/prod database is never modified.\n` +
            `  Set DATABASE_URL to a dedicated test database, e.g.\n` +
            `    postgresql://postgres:postgres@127.0.0.1:5432/codelight_test\n` +
            `  Provision it with:  npm run test:db:setup`,
    );
}
