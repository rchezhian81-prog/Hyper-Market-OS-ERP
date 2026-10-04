import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * **GT-01 (independent audit, 4 Oct 2026): the automatic build runs the browser and performance suites as required,
 * non-skipping jobs on the merge commit — and a release waits for them.**
 *
 * Before this, `.github/workflows/ci.yml` ran `pnpm run test` (unit + guardrails) and `pnpm run test:db`; the
 * sixty-two browser files and the three performance files ran only in the build session's own gate. Every browser
 * file skips itself without a Chromium, so a job could have run them all, skipped them all, and gone green. This
 * pins what makes the new jobs proof rather than a claim:
 *
 *   1. a `browser` job installs the exact Chromium this playwright-core expects, carries a real database for the one
 *      connected browser suite, sets BROWSER_TESTS_REQUIRED and DB_TESTS_REQUIRED, runs the suite with a JSON report
 *      and ends with scripts/assert-suite-ran.mjs at a floor of files and tests;
 *   2. a `performance` job does the same for the performance suite;
 *   3. the release job needs both (the merged-releases guardrail pins the exact list);
 *   4. the guard on the guard exists in the suite itself (tests/e2e/browser-required-in-ci.e2e.ts) and fails by name;
 *   5. the no-skip script refuses pending, todo, failed and too-few runs;
 *   6. every browser suite tears its client down before its server and closes lingering sockets — the one hook
 *      timeout that used to make a full run flaky (the customer app's suite) can not come back;
 *   7. the branch-protection runbook names all five checks.
 */

const CI = readFileSync('.github/workflows/ci.yml', 'utf8');
const job = (name: string): string => {
  const start = CI.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} exists`).toBeGreaterThan(0);
  const rest = CI.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};
const browser = job('browser');
const performance = job('performance');
const E2E = readdirSync('tests/e2e').filter((f) => f.endsWith('.e2e.ts')).sort();

describe('the browser job', () => {
  it('is required, never skips: the exact Chromium, a real database, both REQUIRED flags, the JSON report and the no-skip floor', () => {
    expect(browser).toMatch(/name: Browser suites \(real Chromium\) — required, never skip/);
    expect(browser).toMatch(/pnpm exec playwright-core install --with-deps chromium/);
    expect(browser).toMatch(/image: postgres:16/);
    expect(browser).toMatch(/pnpm db:migrate/);
    expect(browser).toMatch(/BROWSER_TESTS_REQUIRED: '1'/);
    expect(browser).toMatch(/DB_TESTS_REQUIRED: '1'/);
    expect(browser).toMatch(/DATABASE_URL: postgres:\/\/sre@localhost:5432\/sre_core/);
    expect(browser).toMatch(/PLAYWRIGHT_CHROMIUM_EXECUTABLE="\$\(node -e "console\.log\(require\('playwright-core'\)\.chromium\.executablePath\(\)\)"\)"/);
    expect(browser).toMatch(/test -x "\$PLAYWRIGHT_CHROMIUM_EXECUTABLE"/);
    expect(browser).toMatch(/pnpm run test:e2e --reporter=default --reporter=json --outputFile=\/tmp\/e2e\.json/);
    const floor = /node scripts\/assert-suite-ran\.mjs \/tmp\/e2e\.json --min-files (\d+) --min-tests (\d+)/.exec(browser);
    expect(floor, 'the no-skip floor').not.toBeNull();
    expect(Number(floor![1])).toBeGreaterThanOrEqual(60);
    expect(Number(floor![2])).toBeGreaterThanOrEqual(200);
    // the floor never exceeds what the repository holds — a floor above the count would fail an honest run
    expect(Number(floor![1])).toBeLessThanOrEqual(E2E.length);
  });

  it('the suite carries the guard on the guard, which fails by name when the flag is set and the browser is missing', () => {
    expect(E2E).toContain('browser-required-in-ci.e2e.ts');
    const guard = readFileSync('tests/e2e/browser-required-in-ci.e2e.ts', 'utf8');
    expect(guard).toMatch(/process\.env\['BROWSER_TESTS_REQUIRED'\] === '1'/);
    expect(guard).toMatch(/chromium\.launch\(\{ headless: true, executablePath: CHROMIUM \}\)/);
    expect(guard).toMatch(/every browser suite would skip/);
    expect(guard).toMatch(/process\.env\['DATABASE_URL'\]/);
  });
});

describe('the performance job', () => {
  it('is required, never skips, with the same no-skip floor', () => {
    expect(performance).toMatch(/name: Performance suites — required, never skip/);
    expect(performance).toMatch(/pnpm run test:perf --reporter=default --reporter=json --outputFile=\/tmp\/perf\.json/);
    const floor = /node scripts\/assert-suite-ran\.mjs \/tmp\/perf\.json --min-files (\d+) --min-tests (\d+)/.exec(performance);
    expect(floor).not.toBeNull();
    const files = readdirSync('tests/performance').filter((f) => f.endsWith('.test.ts')).length;
    expect(Number(floor![1])).toBe(files);
    expect(Number(floor![2])).toBeGreaterThanOrEqual(30);
  });
});

describe('the no-skip script', () => {
  it('refuses pending, todo, failed and too-few runs, and demands the success flag', () => {
    const script = readFileSync('scripts/assert-suite-ran.mjs', 'utf8');
    expect(script).toMatch(/numPendingTests/);
    expect(script).toMatch(/numTodoTests/);
    expect(script).toMatch(/numPendingTestSuites/);
    expect(script).toMatch(/numFailedTests/);
    expect(script).toMatch(/report\.testResults\.length : 0;\n {2}if \(ranFiles < files\)/);
    expect(script).toMatch(/numTotalTests \?\? 0\) < tests/);
    expect(script).toMatch(/report\.success !== true/);
    expect(script).toMatch(/process\.exit\(1\)/);
  });
});

describe('the release waits for them', () => {
  it('needs the browser and performance jobs', () => {
    const release = job('release');
    expect(release).toMatch(/needs: \[verify, integration, deploy, browser, performance\]/);
  });

  it('the branch-protection runbook names all five checks', () => {
    const runbook = readFileSync('docs/runbooks/branch-protection.md', 'utf8');
    for (const check of ['Type check, lint, tests, secret & dependency scan', 'Stage gate suites (real PostgreSQL)', 'The container builds, starts, and refuses a bad configuration', 'Browser suites (real Chromium) — required, never skip', 'Performance suites — required, never skip']) {
      expect(runbook, check).toContain(check);
    }
  });
});

describe('every browser suite tears down the client before the server, and closes lingering sockets', () => {
  it('no suite closes a server without closing its connections, and none tears down in insertion order', () => {
    const offenders: string[] = [];
    for (const f of E2E) {
      const src = readFileSync(`tests/e2e/${f}`, 'utf8');
      if (/server\.close\(\(\) => \{ done\(\); \}\); \}\)/.test(src)) offenders.push(`${f}: server.close without closeAllConnections`);
      if (/stops\.splice\(0\)\) await stop\(\)/.test(src)) offenders.push(`${f}: tears down in insertion order (server before client)`);
    }
    expect(offenders).toEqual([]);
  });
});
