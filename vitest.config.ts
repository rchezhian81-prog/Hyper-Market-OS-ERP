import { defineConfig } from 'vitest/config';

// A single command — `pnpm test` — runs every test in the project and prints a
// clear pass/fail summary. Test folders map to the roadmap's test types:
// unit, integration, e2e, contract, performance, migration, security, guardrails.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
    // Fail loudly if the suite ever finds no tests — a green run must mean the
    // safety net actually ran, not that it quietly found nothing.
    passWithNoTests: false,

    /**
     * The performance suite is EXCLUDED here and run on its own by `pnpm test:perf`.
     *
     * It measures wall-clock ratios, and alongside two hundred other test files running in
     * parallel it measures the machine's contention rather than the code — which is how it failed
     * three times in one session while passing every time in isolation.
     *
     * The tempting repair was to widen its tolerances until the noise fitted inside them. That
     * would have been the wrong one: a performance test loose enough never to flake is a
     * performance test that cannot fail, and a suite with one known-flaky file is a suite where a
     * real regression gets waved through as "just that one again". Running it alone keeps the
     * thresholds tight and the signal worth having. `pnpm check` runs both.
     */
    exclude: ['**/node_modules/**', 'tests/performance/**'],
  },
});
