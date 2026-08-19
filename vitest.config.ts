import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real-Git acceptance cases are deterministic but can exceed Vitest's
    // five-second default when several repositories are created at once.
    testTimeout: 15_000,
    maxWorkers: 2,
    minWorkers: 1,
  },
});
