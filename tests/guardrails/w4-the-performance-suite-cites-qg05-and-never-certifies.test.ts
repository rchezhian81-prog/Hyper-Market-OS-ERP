import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { againstBudget, certifiedHardwareGate } from '../performance/harness';
import { gateEvidenceBlockers, GATE_EVIDENCE_SPECS } from '../../packages/compliance/src/index';

/**
 * W4 · QG-05 (roadmap §22 "Scan-to-line p95 ≤300 ms on certified pilot hardware; audited targets for other journeys"; §32).
 * The performance suite cites QG-05 wherever it measures, and keeps saying what it is: a CI ratio of SHAPE, never the gate's
 * proof. The proof — the p95 on the certified pilot hardware (EX-09) — stays EXTERNAL, recorded on the gate-evidence
 * register, and QG-05 holds until it is there. This fails if a measuring file stops citing QG-05, if a budget report ever
 * claims to certify the target, or if the gate stops needing the certified-hardware figures.
 */

const DIR = 'tests/performance';
const files = readdirSync(DIR).filter((f) => f.endsWith('.test.ts')).map((f) => ({ f, src: readFileSync(join(DIR, f), 'utf8') }));
const measuring = files.filter(({ src }) => /\b(measure|measureComplexity|againstBudget)\(/.test(src));

describe('QG-05 · the performance suite cites the gate where it measures, and never certifies it', () => {
  it('every performance file that measures names QG-05', () => {
    expect(measuring.length).toBeGreaterThanOrEqual(4);
    for (const { f, src } of measuring) expect(src, `${f} measures but does not cite QG-05`).toMatch(/\bQG-05\b/);
    expect(readFileSync(join(DIR, 'harness.ts'), 'utf8')).toMatch(/QG-05[\s\S]*certified pilot hardware \(EX-09\)/);
  });

  it('every file that compares to a §32 budget holds the report to "does not certify the target"', () => {
    for (const { f, src } of files.filter(({ src: s }) => /againstBudget\(/.test(s))) {
      expect(src, `${f} must assert the budget report is not a certification`).toMatch(/certifiesTheTarget\)\.toBe\(false\)|: false = \w+\.certifiesTheTarget/);
    }
  });

  it('a budget report, inside or outside its headroom, says it is a QG-05 CI ratio and NOT a certification', () => {
    const sample = (p95Ms: number) => ({ p95Ms, p50Ms: p95Ms, p99Ms: p95Ms, maxMs: p95Ms, samples: 1 }) as unknown as Parameters<typeof againstBudget>[0]['sample'];
    for (const p95 of [0.01, 299]) {
      const r = againstBudget({ label: 'scan-to-line', targetMs: 300, sample: sample(p95) });
      expect(r.certifiesTheTarget).toBe(false);
      expect(r.detail).toMatch(/QG-05 CI ratio — NOT a certification/);
    }
  });

  it('the certified-hardware proof stays EXTERNAL: the gate needs both p95 figures from the certified till, and nothing on file holds QG-05', () => {
    expect(certifiedHardwareGate().map((g) => g.what)).toEqual(expect.arrayContaining(['POS scan-to-line p95 ≤ 300 ms on the certified till', 'POS total/tender p95 ≤ 500 ms with a real card terminal attached']));
    const qg05 = GATE_EVIDENCE_SPECS.filter((s) => s.gate === 'QG-05');
    expect(qg05.map((s) => [s.kind, s.maxMs])).toEqual([['scan_to_line_p95', 300], ['total_tender_p95', 500]]);
    expect(qg05[0]!.roadmap).toContain('certified pilot hardware');
    expect(gateEvidenceBlockers([]).filter((b) => b.gate === 'QG-05').map((b) => b.ref)).toEqual(['evidence:scan_to_line_p95', 'evidence:total_tender_p95']);
  });
});
