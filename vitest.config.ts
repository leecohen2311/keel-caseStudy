import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Tests share one Postgres and spawn consumer workers that drain the
    // shared queue; files run sequentially so they cannot steal each
    // other's pending rows mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
