import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The completion report is computed by a reproducible script; this guardrail proves the ledger is
// well-formed and the script's arithmetic is exact, so the owner-facing completion % can be trusted.
import { computeReport, WEIGHTS, LADDER } from '../../scripts/completion-report.mjs';

const ledger = JSON.parse(readFileSync(join(process.cwd(), 'docs', 'completion-status.json'), 'utf8'));

// The fixed controlling-requirement set the denominator is built from (roadmap v2.0/v2.1).
const EXPECTED_IDS: string[] = [
  ...Array.from({ length: 36 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 14 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 10 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 20 }, (_, i) => `WF-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `QG-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `MG-${String(i + 1).padStart(2, '0')}`),
];

describe('completion model integrity', () => {
  it('the ledger enumerates exactly the fixed controlling-requirement set (no drift)', () => {
    const ids = ledger.items.map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(ledger.items.length).toBe(EXPECTED_IDS.length); // 104
    expect(ledger.baseline.denominator).toBe(EXPECTED_IDS.length);
  });

  it('every item carries a valid, weight-bearing maturity label', () => {
    for (const item of ledger.items) {
      expect(Object.keys(WEIGHTS)).toContain(item.label);
      expect(LADDER).toContain(item.label);
    }
  });

  it('the weights match the owner-mandated fixed scale exactly', () => {
    expect(WEIGHTS).toEqual({
      NOT_STARTED: 0, ENGINE_ONLY: 20, PARTIALLY_WIRED: 40, WIRED: 60,
      INTEGRATION_TESTED: 75, E2E_VERIFIED: 85, UAT_VERIFIED: 95, PRODUCTION_VERIFIED: 100,
    });
  });

  it('the report arithmetic is exact and reproducible', () => {
    const report = computeReport(ledger);
    // Numerator is the literal sum of item weights.
    const expectedPoints = ledger.items.reduce((s: number, it: { label: keyof typeof WEIGHTS }) => s + WEIGHTS[it.label], 0);
    expect(report.weightedPoints).toBe(expectedPoints);
    expect(report.maxPoints).toBe(ledger.items.length * 100);
    // Product completion % = Σweights ÷ (denominator × 100) × 100, to one decimal.
    expect(report.productCompletionPct).toBe(Math.round((expectedPoints / (ledger.items.length * 100)) * 1000) / 10);
    // Counts sum back to the denominator.
    const countSum = Object.values(report.counts).reduce((a, b) => (a as number) + (b as number), 0);
    expect(countSum).toBe(ledger.items.length);
    // The six scores are all within 0..100.
    for (const v of Object.values(report.scores)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  });

  it('externally-blocked items retain an achieved technical label (blocker shown, score not zeroed)', () => {
    for (const item of ledger.items) {
      if (typeof item.externalBlocker === 'string' && item.externalBlocker.trim() !== '') {
        expect(WEIGHTS[item.label as keyof typeof WEIGHTS]).toBeGreaterThan(0); // retained, not zeroed
      }
    }
  });
});
