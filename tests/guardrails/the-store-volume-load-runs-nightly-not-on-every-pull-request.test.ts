// Round 3 (combined fix list, 31 Oct 2026: "the store-volume load test is never run in CI"). GT-05's opening load at a real
// store's volume takes 25+ minutes, so it runs NIGHTLY on main and on demand — its own workflow — and never on the
// pull-request build, which stays as fast as it was. A run that skipped itself is refused, not counted green.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const WF = readFileSync('.github/workflows/store-volume.yml', 'utf8');
const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const TEST = 'tests/integration/opening-load-at-store-volume.test.ts';

describe('the store-volume opening load runs in CI — nightly and on demand, never on every pull request', () => {
  it('its own workflow runs on a nightly schedule and by hand, and on nothing else', () => {
    const on = /^on:\n([\s\S]*?)\n\S/m.exec(WF)?.[1] ?? '';
    expect(on).toMatch(/^ {2}schedule:\n(?: {4}#[^\n]*\n)* {4}- cron: '\d+ \d+ \* \* \*'/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/pull_request|push:/);
  });
  it('it runs THE test with the store volume set, on a real PostgreSQL, and refuses a quiet skip', () => {
    expect(WF).toContain(`pnpm exec vitest run ${TEST}`);
    expect(WF).toMatch(/GT05_STORE_VOLUME: \$\{\{ github\.event\.inputs\.products \|\| '15000' \}\}/);
    expect(WF).toMatch(/DATABASE_URL: postgres:\/\/sre@localhost:5432\/sre_core/);
    expect(WF).toMatch(/image: postgres:16/);
    expect(WF).toMatch(/node scripts\/assert-suite-ran\.mjs \/tmp\/gt05\.json --min-files 1 --min-tests 1/);
    expect(WF).not.toMatch(/secrets\./); // synthetic data, a throwaway database: no secret
  });
  it('the pull-request build never sets the store volume, so the everyday run keeps skipping it (fast)', () => {
    expect(CI).not.toMatch(/GT05_STORE_VOLUME/);
    for (const f of readdirSync('.github/workflows').filter((x) => /\.ya?ml$/.test(x) && x !== 'store-volume.yml')) {
      expect(readFileSync(`.github/workflows/${f}`, 'utf8'), f).not.toMatch(/GT05_STORE_VOLUME/);
    }
    expect(readFileSync(TEST, 'utf8')).toMatch(/describe\.skipIf\(N <= 0 \|\| DATABASE_URL === undefined\)/);
  });
});
