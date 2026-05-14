import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/endorse.test.ts',
      'test/query-min-trust-alias.test.ts',
    ],
    testTimeout: 60_000,
    maxWorkers: 1,
  },
});
