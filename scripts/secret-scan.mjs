#!/usr/bin/env node
// Zero-dependency secret scanner for SRE Retail OS.
//
// Enforces hard rule #4 from CLAUDE.md: "No secrets in code, config, images or
// logs." Used in two places:
//   1. The pre-commit hook (.githooks/pre-commit) with --staged, so a secret is
//      blocked before it is ever committed.
//   2. Continuous integration (.github/workflows/ci.yml) across the whole tree,
//      so a secret can never reach main through a pull request.
//
// It looks for credential *values*, not the word "password" in prose. Exit code
// is 0 when clean and 1 when anything is found, with file:line reported.
//
// Run:  node scripts/secret-scan.mjs            (scan the working tree)
//       node scripts/secret-scan.mjs --staged   (scan only staged files)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const STAGED = process.argv.includes('--staged');

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.pnpm-store',
]);
// Placeholder / example files are allowed to contain sample values.
const SKIP_FILES = new Set(['.env.example']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar',
  '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mov', '.docx', '.xlsx', '.pptx',
]);
const MAX_BYTES = 1_000_000;

// Values that are obviously not real secrets.
const PLACEHOLDER = /(example|changeme|change_me|your[-_ ]|placeholder|redacted|dummy|sample|xxxx|<[^>]+>|\$\{|process\.env\.)/i;

const RULES = [
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'Credential in URL', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s/:@'"]+:[^\s/:@'"]+@/ },
  {
    name: 'Hard-coded credential assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"]([^'"]{6,})['"]/i,
    // Only a finding if the captured value is not a placeholder.
    valueGroup: 1,
  },
];

function stagedFiles() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
  return out.split('\n').map((f) => f.trim()).filter(Boolean).map((f) => join(ROOT, f));
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, acc);
    } else if (st.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

function scanFile(file) {
  const rel = relative(ROOT, file);
  const base = rel.split('/').pop();
  if (SKIP_FILES.has(base)) return [];
  if (BINARY_EXT.has(extname(file).toLowerCase())) return [];
  let st;
  try { st = statSync(file); } catch { return []; }
  if (!st.isFile() || st.size > MAX_BYTES) return [];

  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  if (text.includes('\0')) return []; // binary

  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      const m = rule.re.exec(lines[i]);
      if (!m) continue;
      if (rule.valueGroup && PLACEHOLDER.test(m[rule.valueGroup] ?? '')) continue;
      findings.push({ file: rel, line: i + 1, rule: rule.name });
    }
  }
  return findings;
}

const files = STAGED ? stagedFiles() : walk(ROOT, []);
const findings = files.flatMap(scanFile);

if (findings.length > 0) {
  console.error('\n❌  Secret scan FAILED — possible secret(s) found:\n');
  for (const f of findings) {
    console.error(`   ${f.file}:${f.line}  [${f.rule}]`);
  }
  console.error(
    '\nRemove the secret, rotate it if it was ever real, and use an environment\n' +
    'variable or secret store instead. Nothing in this list may be committed.\n',
  );
  process.exit(1);
}

console.log(`✅  Secret scan clean (${files.length} file(s) checked).`);
