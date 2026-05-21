import { defineConfig, configDefaults } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        globals: true,
        // Integration specs (*.integration.spec.ts) hit a REAL Postgres test DB and are
        // run separately via `npm run test:integration` (vitest.config.integration.ts).
        // Exclude them here so the default `npm test` needs no database.
        exclude: [...configDefaults.exclude, '**/*.integration.spec.ts'],
    },
});
