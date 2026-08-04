import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The Definition of Done in `CLAUDE.md` requires a traceability row for every item. That makes
// `docs/traceability.md` load-bearing: it is what somebody reads to answer *"is this built, and
// where is the proof"*, and it is the document an auditor is handed at a quality gate.
//
// **A traceability document nobody checks is a document that drifts.** It drifts in one
// direction, quietly and always the same way: a file is renamed or a package is restructured,
// the row still says `packages/x/src/y.ts`, and the row now certifies something that does not
// exist. Nothing fails. The suite stays green. The claim stays in the document for a year, and
// the person who eventually checks it is an auditor.
//
// So the counting and the path-checking I had been doing by hand after every stage are a test
// instead. A ritual somebody performs is a ritual somebody eventually skips, on the stage where
// they are in a hurry — which is the stage where it matters.

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const TRACEABILITY = read('docs/traceability.md');
const BACKLOG = read('docs/backlog.md');

/** Every backtick-quoted path in a line that looks like a real repository file. */
const pathsIn = (line: string): readonly string[] =>
  [...line.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|sql|md|mjs|json))`/g)].map((m) => m[1]!);

interface Row {
  readonly id: string;
  readonly module: string;
  readonly line: string;
  readonly state: 'built' | 'partial' | 'not_started';
}

function requirementRows(): readonly Row[] {
  const rows: Row[] = [];
  for (const line of TRACEABILITY.split('\n')) {
    const m = /^\|\s*(M\d\d)-FR-(\d\d)\s*\|/.exec(line);
    if (m === null) continue;
    // The STATE column, not a substring of the whole row: M22-FR-02's prose contains the words
    // "a partial delivery bills partially", and a naive search reads that as a partial row.
    const columns = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const status = (columns[columns.length - 1] ?? '').toLowerCase();
    const state: Row['state'] = status.startsWith('partial') ? 'partial'
      : status.startsWith('not started') ? 'not_started' : 'built';
    rows.push({ id: `${m[1]}-FR-${m[2]}`, module: m[1]!, line, state });
  }
  return rows;
}

const ROWS = requirementRows();

describe('the traceability document does not certify files that do not exist', () => {
  it('every path it names is a real file in this repository', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const line of TRACEABILITY.split('\n')) {
      for (const path of pathsIn(line)) {
        checked += 1;
        if (!existsSync(join(ROOT, path))) missing.push(path);
      }
    }
    // A guard on the guard: if the regex ever stops matching, this test would pass by checking
    // nothing at all — the same failure mode as a detector that never fires.
    expect(checked).toBeGreaterThan(300);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('every requirement row names both an implementation and a test', () => {
    const bare: string[] = [];
    for (const row of ROWS) {
      if (row.state === 'not_started') continue;
      const paths = pathsIn(row.line);
      // A row may name a directory (`packages/calendar/src/`) rather than a file — legitimate
      // where a requirement spans a whole package, so directories are matched separately.
      const dirs = [...row.line.matchAll(/`((?:packages|apps|db|edge|services|tests)\/[A-Za-z0-9_./-]*\/)`/g)].map((m) => m[1]!);
      const all = [...paths, ...dirs];
      const hasImpl = all.some((p) => /^(packages|apps|db|edge|services)\//.test(p));
      const hasTest = all.some((p) => p.startsWith('tests/'));
      if (!hasImpl || !hasTest) bare.push(`${row.id}: impl=${hasImpl} test=${hasTest}`);
    }
    // Definition of Done: "Automated tests written and passing" and "Requirement ID referenced".
    // A row claiming built with no test named is a claim with nothing behind it.
    expect(bare).toEqual([]);
  });
});

describe('the counts in the backlog match the rows in traceability', () => {
  it('agrees per module, so a drift is located and not merely detected', () => {
    const perModule = new Map<string, { built: number; partial: number; notStarted: number }>();
    for (const row of ROWS) {
      const acc = perModule.get(row.module) ?? { built: 0, partial: 0, notStarted: 0 };
      if (row.state === 'built') acc.built += 1;
      else if (row.state === 'partial') acc.partial += 1;
      else acc.notStarted += 1;
      perModule.set(row.module, acc);
    }

    const mismatches: string[] = [];
    let modulesChecked = 0;
    for (const line of BACKLOG.split('\n')) {
      const m = /^\|\s*(M\d\d)[^|]*\|[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/.exec(line);
      if (m === null) continue;
      modulesChecked += 1;
      const actual = perModule.get(m[1]!) ?? { built: 0, partial: 0, notStarted: 0 };
      const claimed = { built: Number(m[2]), partial: Number(m[3]), notStarted: Number(m[4]) };
      if (actual.built !== claimed.built || actual.partial !== claimed.partial || actual.notStarted !== claimed.notStarted) {
        mismatches.push(`${m[1]}: traceability ${JSON.stringify(actual)} vs backlog ${JSON.stringify(claimed)}`);
      }
    }
    expect(modulesChecked).toBeGreaterThanOrEqual(30);
    expect(mismatches).toEqual([]);
  });

  it('agrees with the headline the owner actually reads', () => {
    const headline = /\*\*(\d+) individual requirement rows: (\d+) built · (\d+) partial · (\d+) not started/.exec(BACKLOG);
    expect(headline, 'the headline count is missing from docs/backlog.md').not.toBeNull();

    const [total, built, partial, notStarted] = headline!.slice(1, 5).map(Number) as [number, number, number, number];
    expect(ROWS).toHaveLength(total);
    expect(ROWS.filter((r) => r.state === 'built')).toHaveLength(built);
    expect(ROWS.filter((r) => r.state === 'partial')).toHaveLength(partial);
    expect(ROWS.filter((r) => r.state === 'not_started')).toHaveLength(notStarted);
  });

  it('has no duplicate requirement ids — two rows for one id is two different answers', () => {
    const seen = new Map<string, number>();
    for (const row of ROWS) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
  });
});

describe('every gate that claims to have passed has its evidence on disk', () => {
  it('names an evidence file that exists for each passed gate in the backlog', () => {
    // Per SECTION, not per line: a stage heading says "GATE PASSED" and its evidence is named a
    // few rows down in the stage's own table. Matching line-by-line would report every heading
    // as evidence-less, which is a test that fails for a reason nobody can act on.
    const sections = BACKLOG.split(/^## /m).filter((s) => s.includes('PASSED'));
    const missing: string[] = [];

    for (const section of sections) {
      const title = section.split('\n')[0]!.slice(0, 60);
      const evidence = [...new Set(
        section.split('\n').flatMap(pathsIn).filter((p) => p.startsWith('docs/evidence/')),
      )];
      if (evidence.length === 0) {
        missing.push(`"${title}" claims PASSED and names no evidence file`);
        continue;
      }
      for (const path of evidence) {
        if (!existsSync(join(ROOT, path))) missing.push(`"${title}" names a missing file: ${path}`);
      }
    }
    expect(sections.length).toBeGreaterThanOrEqual(10);
    expect(missing).toEqual([]);
  });

  it('every evidence file records a verdict, not just a narrative', () => {
    const dir = join(ROOT, 'docs/evidence');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(10);

    const silent: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      // A gate document that never says whether it passed is a document that will be read as a
      // pass by whoever needs it to be one.
      if (!/\bpass(ed|es)?\b|\bfail(ed|s)?\b|verdict/i.test(text)) silent.push(file);
    }
    expect(silent).toEqual([]);
  });
});

describe('and every check above FIRES on a document that is actually broken', () => {
  // The lesson this repository keeps relearning: a check nobody has seen fail is a check nobody
  // should trust. The first assertion in this file caught a real stale reference the day it was
  // written (`scripts/build-pos.mjs`, renamed to `build-app.mjs` and never updated) — so that one
  // has proven itself. The rest had not, and a counting test that silently counts nothing passes
  // just as green as one that works.

  const rowsFrom = (text: string): readonly Row[] => {
    const rows: Row[] = [];
    for (const line of text.split('\n')) {
      const m = /^\|\s*(M\d\d)-FR-(\d\d)\s*\|/.exec(line);
      if (m === null) continue;
      const columns = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const status = (columns[columns.length - 1] ?? '').toLowerCase();
      const state: Row['state'] = status.startsWith('partial') ? 'partial'
        : status.startsWith('not started') ? 'not_started' : 'built';
      rows.push({ id: `${m[1]}-FR-${m[2]}`, module: m[1]!, line, state });
    }
    return rows;
  };

  it('catches a path that names a file which does not exist', () => {
    const broken = '| M99-FR-01 | 2 | `docs/x.md` | `packages/ghost/src/nothing.ts` | `tests/unit/ghost.test.ts` | R1 | Foundation built |';
    const missing = pathsIn(broken).filter((path) => !existsSync(join(ROOT, path)));
    expect(missing.length).toBeGreaterThan(0);
  });

  it('catches a row that claims built while naming no test', () => {
    const broken = '| M99-FR-02 | 2 | `docs/x.md` | `packages/sale/src/sale.ts` | — | R1 | Foundation built |';
    const row = rowsFrom(broken)[0]!;
    expect(row.state).toBe('built');
    expect(pathsIn(row.line).some((p) => p.startsWith('tests/'))).toBe(false);
  });

  it('reads the STATE column and not the prose — the M22-FR-02 trap', () => {
    // "a partial delivery bills partially" appears in a row that is fully built. A substring
    // search over the whole line reads that as a partial row, and the counts then disagree with
    // the backlog for a reason nobody can find.
    const tricky = '| M99-FR-03 | 2 | `d.md` | `p.ts` | `t.ts` | R6 | Foundation built (a partial delivery bills partially) |';
    expect(rowsFrom(tricky)[0]!.state).toBe('built');

    const genuinelyPartial = '| M99-FR-04 | 2 | `d.md` | `p.ts` | `t.ts` | R1 | Partial — credential storage belongs to the identity provider |';
    expect(rowsFrom(genuinelyPartial)[0]!.state).toBe('partial');
  });

  it('catches a duplicated requirement id', () => {
    const duplicated = rowsFrom([
      '| M99-FR-05 | 2 | `d.md` | `p.ts` | `t.ts` | R1 | Foundation built |',
      '| M99-FR-05 | 2 | `d.md` | `q.ts` | `u.ts` | R1 | Foundation built |',
    ].join('\n'));
    const seen = new Map<string, number>();
    for (const r of duplicated) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
    expect([...seen.values()].filter((n) => n > 1)).toHaveLength(1);
  });

  it('catches a headline that disagrees with the rows beneath it', () => {
    const rows = rowsFrom([
      '| M99-FR-06 | 2 | `d.md` | `p.ts` | `t.ts` | R1 | Foundation built |',
      '| M99-FR-07 | 2 | `d.md` | `p.ts` | `t.ts` | R1 | Partial — something |',
    ].join('\n'));
    const claimedTotal = 5;
    expect(rows).not.toHaveLength(claimedTotal);
    expect(rows.filter((r) => r.state === 'built')).toHaveLength(1);
    expect(rows.filter((r) => r.state === 'partial')).toHaveLength(1);
  });

  it('catches a gate claiming PASSED with no evidence file anywhere in its section', () => {
    const section = '## Stage 99 — something — GATE PASSED\n\n| 99.1 | work | REQ | done |\n';
    const evidence = section.split('\n').flatMap(pathsIn).filter((path) => path.startsWith('docs/evidence/'));
    expect(section).toContain('PASSED');
    expect(evidence).toHaveLength(0);
  });

  it('catches an evidence document that never says whether it passed', () => {
    const narrative = 'We ran the tests and looked at the results. Everything went as expected.';
    expect(/\bpass(ed|es)?\b|\bfail(ed|s)?\b|verdict/i.test(narrative)).toBe(false);
  });
});
