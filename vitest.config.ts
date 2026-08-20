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
  },
});
