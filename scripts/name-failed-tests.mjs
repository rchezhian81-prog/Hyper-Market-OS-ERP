#!/usr/bin/env node
// Name each failing test of a vitest JSON report as a GitHub Actions error annotation (P-08: a red job says WHY).
//
//   node scripts/name-failed-tests.mjs <vitest-json-report> <suite label>
// Prints one `::error title=<suite>::<test> — <first line of the failure>` per failed test; prints nothing when all
// passed; exits 0 either way (scripts/assert-suite-ran.mjs is the judge). Messages are cut short and carry no secret:
// a test's own assertion text, never an environment value.
import { readFileSync, existsSync } from 'node:fs';

const [file, label = 'suite'] = process.argv.slice(2);
if (!file || !existsSync(file)) { console.log(`::error title=${label}::no test report was written — the suite did not start`); process.exit(0); }
const report = JSON.parse(readFileSync(file, 'utf8'));
const clean = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim() !== '')?.trim().slice(0, 300) ?? '';
for (const fileResult of report.testResults ?? []) {
  if (fileResult.status === 'failed' && (fileResult.assertionResults ?? []).length === 0) {
    console.log(`::error title=${label}::the file failed before any test ran — ${clean(fileResult.message)}`);
  }
  for (const t of fileResult.assertionResults ?? []) {
    if (t.status !== 'failed') continue;
    console.log(`::error title=${label}::${String(t.fullName ?? t.title).slice(0, 200)} — ${clean((t.failureMessages ?? [])[0])}`);
  }
}
