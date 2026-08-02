// Shared scanning helpers for the SRE Retail OS guardrails.
//
// A guardrail is a *tripwire*, not a proof. Each one scans the source code for a
// pattern that must never appear, and fails the test suite if it finds one.
// These are deliberately conservative heuristics: they exist so that a hard rule
// from roadmap sections 18 and 20 cannot be broken *silently*. As real code
// lands, the patterns here are tightened alongside it.
//
// Every guardrail test does two things:
//   1. Confirms the real codebase is clean (no violations today).
//   2. Confirms the detector actually fires on a known-bad sample, so a green
//      result means "the tripwire works and found nothing", not "the tripwire
//      is broken".

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

export interface Entry {
  file: string;
  content: string;
}

export interface Finding {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

export interface Rule {
  rule: string;
  re: RegExp;
}

const ROOT = process.cwd();

/** Directories that hold shippable code — the surface the guardrails police. */
export const CODE_DIRS = ['apps', 'services', 'packages', 'edge', 'db', 'infra'];

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.git',
]);

/** Only source / config files are scanned. Docs (.md) are excluded on purpose. */
const SCAN_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sql', '.prisma', '.json', '.yml', '.yaml', '.env',
]);

function walk(dir: string, acc: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, acc);
    } else if (st.isFile() && SCAN_EXT.has(extname(name).toLowerCase())) {
      acc.push(full);
    }
  }
  return acc;
}

/** Load every scannable source file under the code directories. */
export function loadCodeEntries(dirs: string[] = CODE_DIRS): Entry[] {
  const files: string[] = [];
  for (const d of dirs) walk(join(ROOT, d), files);
  return files.map((f) => ({
    file: relative(ROOT, f),
    content: safeRead(f),
  }));
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Run a set of line-oriented rules over the given entries. An optional filter
 * restricts which files a rule set applies to (e.g. only the POS app).
 */
export function scan(
  entries: Entry[],
  rules: Rule[],
  fileFilter?: (file: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of entries) {
    if (fileFilter && !fileFilter(entry.file)) continue;
    const lines = entry.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      for (const { rule, re } of rules) {
        if (re.test(line)) {
          findings.push({ file: entry.file, line: i + 1, rule, snippet: line.trim().slice(0, 200) });
        }
      }
    }
  }
  return findings;
}

/** Build an in-memory entry, used by the "the tripwire fires" half of each test. */
export function sample(file: string, content: string): Entry {
  return { file, content };
}
