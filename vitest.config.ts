import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e/ needs a real TestingBot account and runs via `npx mobilewright test`.
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
