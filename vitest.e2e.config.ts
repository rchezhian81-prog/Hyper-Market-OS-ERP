import { defineConfig } from 'vitest/config';

// The browser end-to-end suite, alone (SYNC-06 / TEST-02).
//
// Split out of `vitest.config.ts` for two reasons. First, it drives a REAL headless Chromium via
// `playwright-core`, which the default unit/integration suite must not need — `pnpm test` stays fast
// and browserless, and the CI `verify` job (no browser on the runner) runs that, not this. Second,
// the browser makes each test slower and heavier, so it gets a longer timeout and runs on its own.
//
// The suite self-skips when no browser binary is present (see the test), so `pnpm test:e2e` in a
// browserless environment reports "skipped", never a spurious failure. Where a browser IS available
// (this dev environment; a future CI job that provisions one) it runs and proves the property that
// matters: every screen opens with the network cut.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    reporters: 'default',
    passWithNoTests: false,
    // A browser launch and a couple of reloads take longer than a pure-Node test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One browser at a time — nothing competing for it.
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
