import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // First run downloads the pinned MongoDB test binary (~800 MB zip) -> generous hook timeout.
    hookTimeout: 600_000,
    testTimeout: 30_000,
    pool: 'forks',
  },
});
