import { defineConfig } from 'vitest/config';

// The performance suite, alone.
//
// Split out of `vitest.config.ts` because it measures wall-clock ratios: run alongside two
// hundred other test files it measures how busy the machine is, not how the code scales. It
// failed three times in one session that way and passed every time on its own.
//
// Kept as a separate config rather than a looser threshold. A performance test that cannot fail
// is not a performance test, and one file everybody knows is flaky is how a real regression gets
// waved through.
export default defineConfig({
  test: {
    include: ['tests/performance/**/*.test.ts'],
    reporters: 'default',
    passWithNoTests: false,
    // One file at a time, one process. Nothing else competing for the CPU being measured.
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
