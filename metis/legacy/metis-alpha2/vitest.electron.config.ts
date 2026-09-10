import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/engine/CurrentAffairsSourceReview.test.ts'],
    pool: 'threads',
    isolate: false,
    fileParallelism: false,
    execArgv: [],
  },
});
