import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** scripts/assert-suite-ran.mjs refuses a quiet green (GT-01): the CI browser and performance jobs end with it. */
const files = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tests/e2e/file-${i}.e2e.ts`, status: 'passed' }));
// vitest's report: one testResults entry per FILE; numTotalTestSuites counts describe blocks (more than the files)
const GOOD = { success: true, numTotalTestSuites: 126, numPassedTestSuites: 126, numFailedTestSuites: 0, numPendingTestSuites: 0, numTotalTests: 211, numPassedTests: 211, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: files(62) };

function run(report: Record<string, unknown>, args: string[] = []): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'suite-ran-'));
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report));
  try {
    const out = execFileSync(process.execPath, ['scripts/assert-suite-ran.mjs', file, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stderr: string; stdout: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe('assert-suite-ran refuses a quiet green', () => {
  it('passes a full run in which every test ran and passed', () => {
    const r = run(GOOD, ['--min-files', '60', '--min-tests', '200']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('211 tests in 62 files ran and passed; nothing skipped');
  });

  it('refuses a run with skipped tests — the browser suites skipping themselves is exactly this', () => {
    const r = run({ ...GOOD, numPendingTests: 211, numPassedTests: 0, numPendingTestSuites: 62, numPassedTestSuites: 0 }, ['--min-files', '60', '--min-tests', '200']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('were skipped — a skipped suite is not proof');
  });

  it('refuses a run with too few files or tests, by the numbers', () => {
    expect(run({ ...GOOD, testResults: files(3) }, ['--min-files', '60']).out).toContain('only 3 test file(s) ran; at least 60 expected');
    expect(run({ ...GOOD, numTotalTests: 12, numPassedTests: 12 }, ['--min-tests', '200']).out).toContain('only 12 test(s) ran; at least 200 expected');
  });

  it('refuses a failed run and a run that did not report success', () => {
    expect(run({ ...GOOD, numFailedTests: 1, numPassedTests: 210, success: false }).out).toMatch(/1 test\(s\) failed.*did not report success/);
  });
});
