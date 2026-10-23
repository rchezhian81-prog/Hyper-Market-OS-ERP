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
 */

const DIR = 'docs/requirements/workflows';
const SCENARIOS = ['happy-path', 'alternate', 'cancellation', 'permission-denied', 'offline', 'timeout', 'duplicate', 'recovery', 'audit', 'stock and money reconcile'];
const STATUSES = ['COVERED', 'PARTIAL', 'MISSING'];
/** The workflows this list must cover (audit-2 P6: WF-06 to WF-10). Others are checked the same way when written. */
const REQUIRED = ['WF-06', 'WF-07', 'WF-08', 'WF-09', 'WF-10'];

interface Row { readonly scenario: string; readonly status: string; readonly proof: string; readonly why: string }

function rowsOf(text: string): Row[] {
  return text.split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Scenario') && !l.startsWith('| ---'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([scenario = '', status = '', proof = '', why = '']) => ({ scenario, status, proof, why }));
}

const refsOf = (proof: string): { file: string; title: string }[] =>
  [...proof.matchAll(/`([^`]+\.(?:test|e2e)\.ts)` › "([^"]+)"/g)].map((m) => ({ file: m[1]!, title: m[2]! }));

const docs = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^WF-\d{2}\.md$/.test(f)).sort() : [];

describe('every workflow scenario list names its nine scenarios, each pointing at a real test or honestly MISSING (§26)', () => {
  it('the lists for WF-06 to WF-10 exist', () => {
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
          } else {
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
    });
  }

  it('tripwire — a renamed test is caught', () => {
    const rows = rowsOf('| happy-path | COVERED | `tests/integration/recall.test.ts` › "a title nobody ever wrote" | x |');
    const { file, title } = refsOf(rows[0]!.proof)[0]!;
    expect(readFileSync(file, 'utf8').includes(title)).toBe(false);
  });
});
