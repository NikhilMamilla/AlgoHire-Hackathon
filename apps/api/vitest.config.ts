import { defineConfig } from 'vitest/config';

const testDb =
  process.env.TEST_DATABASE_URL ?? 'postgresql://certiflow:certiflow@localhost:5432/certiflow_test';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    env: { DATABASE_URL: testDb, NODE_ENV: 'test' },
    fileParallelism: false,
    // github-actions reporter turns failures into PR/commit annotations.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
  },
});
