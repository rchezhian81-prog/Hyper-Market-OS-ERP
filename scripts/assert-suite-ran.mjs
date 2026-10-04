#!/usr/bin/env node
// Refuse a quiet green (GT-01 · hard rule #9 · P-08).
//
// A test suite that skipped itself, or ran fewer files than it should have, proves nothing — and a required CI job
// that goes green on such a run is worse than no job, because it is believed. Vitest's JSON report says exactly what
// ran; this reads it and exits 1, by name, unless every test ran and passed and nothing was pending, skipped or todo.
//
//   node scripts/assert-suite-ran.mjs <vitest-json-report> [--min-files N] [--min-tests N]
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: assert-suite-ran.mjs <vitest-json-report> [--min-files N] [--min-tests N]'); process.exit(2); }
const option = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i === -1 ? fallback : Number(rest[i + 1]); };
const minFiles = option('min-files', 1);
const minTests = option('min-tests', 1);

export function judge(report, { minFiles: files = 1, minTests: tests = 1 } = {}) {
  const problems = [];
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  if ((report.numFailedTests ?? 0) > 0 || (report.numFailedTestSuites ?? 0) > 0) problems.push(`${report.numFailedTests ?? 0} test(s) failed`);
  if (skipped > 0 || (report.numPendingTestSuites ?? 0) > 0) problems.push(`${skipped} test(s) and ${report.numPendingTestSuites ?? 0} file(s) were skipped — a skipped suite is not proof`);
  // vitest's JSON report lists one testResults entry per FILE; numTotalTestSuites counts describe blocks, not files.
  const ranFiles = Array.isArray(report.testResults) ? report.testResults.length : 0;
  if (ranFiles < files) problems.push(`only ${ranFiles} test file(s) ran; at least ${files} expected`);
  if ((report.numTotalTests ?? 0) < tests) problems.push(`only ${report.numTotalTests ?? 0} test(s) ran; at least ${tests} expected`);
  if (report.success !== true) problems.push('the run did not report success');
  return problems;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const problems = judge(report, { minFiles, minTests });
  if (problems.length > 0) { console.error(`::error::${problems.join('; ')}`); process.exit(1); }
  console.log(`${report.numTotalTests} tests in ${report.testResults.length} files ran and passed; nothing skipped`);
}
