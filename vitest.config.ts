import { defineConfig } from 'vitest/config';

// A single command — `pnpm test` — runs every test in the project and prints a
// clear pass/fail summary. Test folders map to the roadmap's test types:
// unit, integration, e2e, contract, performance, migration, security, guardrails.
export default defineConfig({
  test: {
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

    /**
     * The guardrails get their own time limit: 60 s per test instead of the default 5 s.
     *
     * A guardrail proves what the code SAYS — no secret, no UTC "today", no binary byte, every menu item answered —
     * by reading the whole tree or driving hundreds of real till sessions. Several take 1–6 s on a quiet machine, so
     * on a busy one (a full local run beside the browser suite rebuilding the shells) they ran out of 5 s and failed
     * with "Test timed out" while their checks were sound: box-menu, no-shop-date and plain-text first, then others
     * (reproduced 31 Oct 2026: 2 of 3 contended runs). Speed is not what a guardrail asserts, so its limit only has to
     * catch a real hang. Every other folder keeps the default. The file lists live in the two projects (not above):
     * a project that extends this one ADDS to an inherited list, so a shared `include` would run each file twice.
     */
    projects: [
      { extends: true, test: { name: 'guardrails', include: ['tests/guardrails/**/*.test.ts'], testTimeout: 60_000 } },
      { extends: true, test: { name: 'tests', include: ['tests/**/*.test.ts'], exclude: ['tests/guardrails/**'] } },
    ],
  },
});
