import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Integration test config — REAL Postgres test database.
 *
 * Runs ONLY *.integration.spec.ts. These perform real INSERT/DELETE against the
 * database in DATABASE_URL, so they are NOT part of the default `npm test`.
 *
 * Run with:  npm run test:integration
 * Provision the test DB first:  npm run test:db:setup
 *
 * Safety guard (vitest.integration.setup.ts) refuses to run unless DATABASE_URL's
 * database name contains "test", so dev/prod databases can never be touched.
 */
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        globals: true,
        include: ['**/*.integration.spec.ts'],
        setupFiles: ['./vitest.integration.setup.ts'],
        // Real DB rows are shared across files; run serially to avoid contention.
        fileParallelism: false,
        hookTimeout: 30_000,
        testTimeout: 30_000,
    },
});
