import { defineConfig } from 'vitest/config';
import { contentionBudgetMs } from './test/support/contention.js';

export default defineConfig({
  test: {
    // Real-Git acceptance cases can exceed Vitest's five-second default under
    // shared-host contention, turning ambient load into phantom candidate
    // failures. Budgets scale with measured load (clamped to [1,4]): exact
    // base on a quiet machine, bounded growth when oversubscribed.
    testTimeout: contentionBudgetMs(30_000),
    hookTimeout: contentionBudgetMs(30_000),
    // Bound intra-suite self-load: several repositories are created at once.
    maxWorkers: 2,
    minWorkers: 1,
    // This lane is a merge-queue admission lane: refuse network sockets so
    // registry/API latency can never become candidate evidence.
    setupFiles: ['./test/support/hermetic-network-guard.ts'],
  },
});
