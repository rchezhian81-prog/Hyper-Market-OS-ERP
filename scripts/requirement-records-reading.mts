// W7 · QG-01 — read every module requirement record with the CI guardrail's own check and write it as a findings report for
// head office's register (the push step that follows sends every *.findings.json in the folder, OB-331).
//
//   node --experimental-strip-types scripts/requirement-records-reading.mts --out scan-reports/requirement-records.findings.json
//
// The check is packages/compliance/src/requirement-records.ts — the same functions
// tests/guardrails/every-requirement-record-has-actors-rules-errors-permissions-and-acceptance.test.ts runs — so the
// Quality gates page shows exactly what the build checks. A record missing a field is a high finding that holds QG-01 by
// name; a reading that could not read every record is incomplete and holds QG-01 as NOT KNOWN. A clean reading never
// passes the gate: the owner decides QG-01 with his signed review (QG-12).
//
// Exit 0 whatever the reading found — the guardrail is what fails a pull request; this step reports. Exit 2 only when the
// requirement files cannot be read or the report cannot be written.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRequirementRecords, requirementRecordsReport } from '../packages/compliance/src/requirement-records.ts';

const arg = (flag: string): string | undefined => { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; };
const out = arg('--out') ?? 'scan-reports/requirement-records.findings.json';
const dir = arg('--dir') ?? 'docs/requirements';

let files: { name: string; text: string }[];
try {
  files = readdirSync(dir).filter((n) => /^M\d\d\.md$/.test(n)).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
} catch (e) { console.error(`::error::the requirement records in ${dir} could not be read: ${(e as Error).message}`); process.exit(2); }

const reading = readRequirementRecords(files);
const runId = process.env['GITHUB_RUN_ID'] === undefined ? `local-${new Date().toISOString()}` : `gh-${process.env['GITHUB_RUN_ID']}-${process.env['GITHUB_RUN_ATTEMPT'] ?? '1'}`;
const report = requirementRecordsReport(reading, { runId, scannedAt: new Date().toISOString(), ...(process.env['GITHUB_SHA'] === undefined ? {} : { commit: process.env['GITHUB_SHA'] }) });
try {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
} catch (e) { console.error(`::error::the requirement-records reading could not be written to ${out}: ${(e as Error).message}`); process.exit(2); }

console.log(`QG-01 requirement-records reading: ${reading.detail}`);
if (!reading.readAll || reading.incomplete.length > 0) console.log(`::warning title=QG-01 holds — requirement records ${reading.readAll ? 'incomplete' : 'not known'}::${reading.detail}`);
