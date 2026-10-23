#!/usr/bin/env node
// OB-331: send every findings report in a folder to head office's findings register (the CI "security-scans" job's last
// step). Usage: node scripts/push-findings.mjs <folder of *.findings.json>
//
// Reads FINDINGS_PUSH_TOKEN (the GitHub Actions secret) and FINDINGS_REGISTER_URL from the environment only. With no key
// set it prints "findings not sent: no key set" and exits 0 — the build is never failed by the push (the scan verdict is
// the gate). The token is never printed. scripts/lib/push-findings.mjs holds the tested logic.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pushFindings } from './lib/push-findings.mjs';

const dir = process.argv[2] ?? 'scan-reports';
let files = [];
try {
  files = (await readdir(dir)).filter((f) => f.endsWith('.findings.json')).sort().map((f) => join(dir, f));
} catch {
  console.log(`::warning title=Security findings not sent::findings not sent: no reports in ${dir}`);
}
const out = await pushFindings({
  env: process.env, reports: files, read: (f) => readFile(f, 'utf8'), fetch: globalThis.fetch, say: (line) => { console.log(line); },
});
console.log(`findings push: ${out.sent} of ${files.length} report(s) on the register${out.why === null ? '' : ` (${out.why})`}`);
process.exit(0);
