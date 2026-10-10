import { defineConfig } from 'vitest/config';

/**
 * MANUAL, KEY-GATED SUITES ONLY. Never part of `npm test`, `npm run verify` or CI: these call a real
 * provider with a real key and cost money. See `scripts/auto-split-live.live-suite.ts`.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['scripts/**/*.live-suite.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
  },
});
