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
  },
});
