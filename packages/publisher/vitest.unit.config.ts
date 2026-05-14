import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/trust-metadata.test.ts',
      'test/verification-metadata.test.ts',
      'test/verify-collector.test.ts',
      'test/verify-proposal-handler.test.ts',
      'test/views-min-trust-extra.test.ts',
    ],
    testTimeout: 60_000,
    maxWorkers: 1,
  },
});
