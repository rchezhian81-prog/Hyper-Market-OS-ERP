// The CI security-scan judge (QG-03 · QG-06 · roadmap §22, §35; OB-288 gates lane).
//
//   node --experimental-strip-types scripts/scan-findings.mts --format <semgrep|trivy-image|trivy-config|zap|pnpm-audit> \
//        --in <the tool's JSON> [--in <another>] --out <findings report> [--run-id <id>] [--commit <sha>]
//
// Every scanner in .github/workflows/ci.yml writes its own JSON and exits 0 on findings; THIS is the one judge. It
// reads the tool's report with the tested parsers in packages/compliance/src/findings.ts, writes the normalised
// ScanReport (what POST /v1/compliance/finding-scans records on the findings register), prints every critical and
// high finding by name, and exits:
//
//   0  nothing critical or high;
//   1  at least one critical or high finding — the build fails (§22 QG-06 "zero open critical/high findings");
//   2  the tool's report is missing or unreadable — never read as "nothing found" (P-08: a scan that did not run is
//      not a clean scan).
//
// Medium, low and info findings never fail the build, but they are never dropped either: they are in the report
// file, and they become recorded findings when the report is imported.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import {
  parseSemgrepJson, parseTrivyJson, parseZapJson, parsePnpmAuditJson, blockingObservations,
  type FindingObservation, type ScanReport, type FindingSource,
} from '../packages/compliance/src/findings.ts';

type Format = 'semgrep' | 'trivy-image' | 'trivy-config' | 'zap' | 'pnpm-audit';
const FORMATS: Record<Format, { tool: string; source: FindingSource }> = {
  semgrep: { tool: 'semgrep', source: 'sast' },
  'trivy-image': { tool: 'trivy-image', source: 'container' },
  'trivy-config': { tool: 'trivy-config', source: 'iac' },
  zap: { tool: 'zap', source: 'dast' },
  'pnpm-audit': { tool: 'pnpm-audit', source: 'dependency' },
};

function args(argv: readonly string[]): { format: Format; inputs: string[]; out: string; runId: string; commit?: string } {
  const inputs: string[] = [];
  let format: string | undefined; let out: string | undefined; let runId: string | undefined; let commit: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const v = argv[i + 1];
    if (a === '--format') { format = v; i += 1; } else if (a === '--in') { if (v !== undefined) inputs.push(v); i += 1; }
    else if (a === '--out') { out = v; i += 1; } else if (a === '--run-id') { runId = v; i += 1; } else if (a === '--commit') { commit = v; i += 1; }
  }
  if (format === undefined || !(format in FORMATS) || inputs.length === 0 || out === undefined) {
    console.error('usage: scan-findings.mts --format <semgrep|trivy-image|trivy-config|zap|pnpm-audit> --in <file> [--in <file>] --out <file> [--run-id <id>] [--commit <sha>]');
    process.exit(2);
  }
  const ghRun = process.env['GITHUB_RUN_ID'] === undefined ? undefined : `gh-${process.env['GITHUB_RUN_ID']}-${process.env['GITHUB_RUN_ATTEMPT'] ?? '1'}`;
  const sha = commit ?? process.env['GITHUB_SHA'];
  return { format: format as Format, inputs, out, runId: runId ?? ghRun ?? `local-${new Date().toISOString()}`, ...(sha === undefined ? {} : { commit: sha }) };
}

function unreadable(why: string): never {
  console.error(`::error title=Security scan report unreadable::${why} — a scan that did not produce its report is not a clean scan (P-08)`);
  process.exit(2);
}

const opts = args(process.argv.slice(2));
const { tool, source } = FORMATS[opts.format];
const observations: FindingObservation[] = [];
const incompleteBecause: string[] = [];
for (const path of opts.inputs) {
  if (!existsSync(path)) unreadable(`${path} does not exist`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { unreadable(`${path} is not JSON (${(e as Error).message})`); }
  try {
    if (opts.format === 'semgrep') {
      const r = parseSemgrepJson(raw);
      observations.push(...r.observations); incompleteBecause.push(...r.incompleteBecause);
    } else if (opts.format === 'trivy-image') observations.push(...parseTrivyJson(raw, 'container'));
    else if (opts.format === 'trivy-config') observations.push(...parseTrivyJson(raw, 'iac'));
    else if (opts.format === 'zap') observations.push(...parseZapJson(raw));
    else observations.push(...parsePnpmAuditJson(raw));
  } catch (e) { unreadable(`${path}: ${(e as Error).message}`); }
}

const report: ScanReport = {
  tool, source, runId: opts.runId, scannedAt: new Date().toISOString(), ...(opts.commit === undefined ? {} : { commit: opts.commit }),
  complete: incompleteBecause.length === 0, ...(incompleteBecause.length === 0 ? {} : { incompleteBecause }), observations,
};
writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);

const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
for (const o of observations) counts[o.severity] = (counts[o.severity] ?? 0) + 1;
const blocking = blockingObservations(report);
const line = `${tool}: ${observations.length} finding(s) — critical ${counts['critical']}, high ${counts['high']}, medium ${counts['medium']}, low ${counts['low']}, info ${counts['info']}${report.complete ? '' : ' (INCOMPLETE run)'}`;
console.log(line);
for (const why of incompleteBecause) console.log(`::warning title=${tool} did not scan everything::${why}`);
for (const o of observations.filter((x) => !blocking.includes(x))) console.log(`  ${o.severity.padEnd(6)} ${o.ruleId}  ${o.location}  ${o.title}`);
for (const o of blocking) {
  const m = /^(.+?):(\d+)$/.exec(o.location);
  const where = m === null ? '' : ` file=${m[1]},line=${m[2]}`;
  console.log(`::error${where},title=${tool} ${o.severity}: ${o.ruleId}::${o.title} — ${o.location}`);
}
const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
if (summaryFile !== undefined && summaryFile !== '') {
  appendFileSync(summaryFile, `### ${tool} (${source})\n\n${line}\n\n${blocking.map((o) => `- **${o.severity}** \`${o.ruleId}\` ${o.title} — ${o.location}`).join('\n')}\n\n`);
}
console.log(`report written to ${opts.out} (import it with POST /v1/compliance/finding-scans to record the findings)`);
process.exit(blocking.length > 0 ? 1 : 0);
