import { defineConfig } from 'vitest/config';

// Standalone vitest config (keeps vite.config.ts — and its dev-server-only
// Postgres bridge plugin — out of the test runner).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
