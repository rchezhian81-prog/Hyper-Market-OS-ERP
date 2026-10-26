import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * §26 WORKFLOW RULE guardrail (OB-288 gates lane): "Each workflow requires separate happy-path, alternate, cancellation,
 * permission-denied, offline, timeout, duplicate, recovery and audit scenarios … A workflow is incomplete until its
 * financial and stock effects reconcile."
 *
 * Every scenario list in docs/requirements/workflows/WF-NN.md must name all nine scenarios plus the reconcile row, each
 * COVERED / PARTIAL with the test that proves it — a real file holding a test with that title — or MISSING with the
 * reason. A list that points at a test that was renamed or deleted fails here, so the list cannot quietly go stale.
 *
 * FG-3 (26 Oct 2026, re-audits 2/3/4): the lists for WF-06 to WF-20 are all required, and the labels are kept honest in
 * the other direction too — a list that is stale in the PESSIMISTIC direction (code ahead of the paperwork) fails here:
 *   • a MISSING row names the test that WILL prove it (`Planned test: \`tests/…\``), and once that file exists the row
 *     must be brought up to COVERED or PARTIAL — a MISSING label next to a test that exists is refused;
 *   • a PARTIAL row says, in words, what is still not proved;
 *   • the closing words below the table may not call a scenario open that the table marks COVERED.
 */

const DIR = 'docs/requirements/workflows';
const SCENARIOS = ['happy-path', 'alternate', 'cancellation', 'permission-denied', 'offline', 'timeout', 'duplicate', 'recovery', 'audit', 'stock and money reconcile'];
const STATUSES = ['COVERED', 'PARTIAL', 'MISSING'];
/** The workflows this list must cover: WF-06 to WF-20 (audit-2 P6; re-audits 2/3/4, FG-3). */
const REQUIRED = Array.from({ length: 15 }, (_, i) => `WF-${String(i + 6).padStart(2, '0')}`);

interface Row { readonly scenario: string; readonly status: string; readonly proof: string; readonly why: string }

function rowsOf(text: string): Row[] {
  return text.split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Scenario') && !l.startsWith('| ---'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([scenario = '', status = '', proof = '', why = '']) => ({ scenario, status, proof, why }));
}

const refsOf = (proof: string): { file: string; title: string }[] =>
  [...proof.matchAll(/`([^`]+\.(?:test|e2e)\.ts)` › "([^"]+)"/g)].map((m) => ({ file: m[1]!, title: m[2]! }));

/** The test a MISSING row says will prove it: `Planned test: \`tests/….test.ts\``. */
const plannedOf = (why: string): string | undefined => /Planned test:\s*`([^`]+\.(?:test|e2e)\.ts)`/.exec(why)?.[1];

const docs = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^WF-\d{2}\.md$/.test(f)).sort() : [];

describe('every workflow scenario list names its nine scenarios, each pointing at a real test or honestly MISSING (§26)', () => {
  it('the lists for WF-06 to WF-20 exist', () => {
    expect(docs.map((d) => d.replace('.md', ''))).toEqual(expect.arrayContaining(REQUIRED));
  });

  for (const doc of docs) {
    describe(doc, () => {
      const text = readFileSync(join(DIR, doc), 'utf8');
      const rows = rowsOf(text);

      it('quotes the §26 workflow rule and names exactly the nine scenarios plus the reconcile row, in order', () => {
        expect(text).toContain('WORKFLOW RULE');
        expect(rows.map((r) => r.scenario)).toEqual(SCENARIOS);
      });

      it('every row is COVERED, PARTIAL or MISSING; a MISSING row says why and points at nothing', () => {
        for (const r of rows) {
          expect(STATUSES, `${doc} ${r.scenario}`).toContain(r.status);
          if (r.status === 'MISSING') {
            expect(r.proof, `${doc} ${r.scenario}: a missing scenario names no test`).toBe('—');
            expect(r.why.length, `${doc} ${r.scenario}: say why it is missing`).toBeGreaterThan(20);
            expect(plannedOf(r.why), `${doc} ${r.scenario}: a MISSING row names its planned test — Planned test: \`tests/…\``).toBeDefined();
          } else {
            if (r.status === 'PARTIAL') expect(r.why.length, `${doc} ${r.scenario}: a PARTIAL row says what is still not proved`).toBeGreaterThan(40);
            expect(refsOf(r.proof).length, `${doc} ${r.scenario}: name the test that proves it`).toBeGreaterThan(0);
          }
        }
      });

      it('every test it names exists, with that title', () => {
        for (const r of rows) {
          for (const { file, title } of refsOf(r.proof)) {
            expect(existsSync(file), `${doc} ${r.scenario}: ${file} exists`).toBe(true);
            const titled = readFileSync(file, 'utf8').split('\n').some((l) => /\b(it|test|describe)(\.each\([^)]*\))?(\.skipIf\([^)]*\))?\(/.test(l) && l.includes(title));
            expect(titled, `${doc} ${r.scenario}: ${file} has a test titled "${title}…"`).toBe(true);
          }
        }
      });

      it('the open scenarios are said in words below the table when any is MISSING', () => {
        const missing = rows.filter((r) => r.status === 'MISSING').length;
        if (missing > 0) expect(text).toMatch(/\*\*Open:\*\*/);
      });

      it('keeps its labels honest: no MISSING row whose planned test now exists; no "open" word for a COVERED scenario', () => {
        for (const r of rows.filter((x) => x.status === 'MISSING')) {
          const planned = plannedOf(r.why);
          if (planned !== undefined) expect(existsSync(planned), `${doc} ${r.scenario}: ${planned} exists — the row is stale; point it at the test and mark it COVERED or PARTIAL`).toBe(false);
        }
        const open = (text.match(/\*\*Open:\*\*([^\n]*(?:\n(?!\n)[^\n]*)*)/)?.[1] ?? '').toLowerCase();
        for (const r of rows.filter((x) => x.status === 'COVERED')) {
          expect(open.includes(` ${r.scenario}`) || open.startsWith(r.scenario), `${doc}: the Open line still calls "${r.scenario}" open, but the table marks it COVERED`).toBe(false);
        }
      });
    });
  }

  it('tripwire — a MISSING row whose planned test exists is caught as stale', () => {
    const [row] = rowsOf('| timeout | MISSING | — | Not proved yet. Planned test: `tests/integration/recall.test.ts` |');
    expect(plannedOf(row!.why)).toBe('tests/integration/recall.test.ts');
    expect(existsSync(plannedOf(row!.why)!)).toBe(true); // → the honest-labels check above would refuse this row
    expect(plannedOf('Not built. No test planned.')).toBeUndefined();
  });

  it('tripwire — a renamed test is caught', () => {
    const rows = rowsOf('| happy-path | COVERED | `tests/integration/recall.test.ts` › "a title nobody ever wrote" | x |');
    const { file, title } = refsOf(rows[0]!.proof)[0]!;
    expect(readFileSync(file, 'utf8').includes(title)).toBe(false);
  });
});
