import { describe, it, expect } from 'vitest';
import { reviewSettlement } from '../../packages/settlement/src/settlement';
import type { SettlementLine, SettlementLineType } from '../../packages/reconciliation/src/reconciliation';

// C13 (v2.1 addendum · M23/M14 · P-08) — the NEVER claim: a line on the aggregator's settlement file never disappears
// from the review. Every capture, refund and chargeback is either matched or an exception; a chargeback is always an
// exception; a till refund the file does not show is always surfaced (information while not yet due, a problem after).

const TYPES: readonly SettlementLineType[] = ['capture', 'refund', 'chargeback'];
const tenders = [{ id: 't1', ref: 'CAP-1', amountMinor: 10_000, capturedOn: '2026-10-15' }];

describe('guardrail: a settlement reversal never passes silently (C13)', () => {
  it('for every line type, a line nothing on the till accounts for is an exception that needs a person', () => {
    for (const type of TYPES) {
      const line: SettlementLine = { id: `L-${type}`, ref: `X-${type}`, amountMinor: 500, type, ...(type === 'capture' ? {} : { originalRef: 'NOT-A-SALE' }) };
      const r = reviewSettlement({ tenders: [], credits: [line], refunds: [], settlementCycleDays: 1, asOf: '2026-10-16' });
      expect(r.exceptions.filter((e) => e.settlementId === line.id && e.needsInvestigation), type).toHaveLength(1);
    }
  });

  it('a chargeback is an exception even when its sale settled in full', () => {
    const r = reviewSettlement({
      tenders, refunds: [], settlementCycleDays: 1, asOf: '2026-10-16',
      credits: [{ id: 'L1', ref: 'CAP-1', amountMinor: 10_000 }, { id: 'L2', ref: 'CB-1', type: 'chargeback', originalRef: 'CAP-1', amountMinor: 10_000 }],
    });
    expect(r.matchedCount).toBe(1);
    expect(r.exceptions.map((e) => [e.finding, e.needsInvestigation])).toEqual([['chargeback', true]]);
  });

  it('every line is accounted for: matched, or named in an exception', () => {
    const credits: SettlementLine[] = [
      { id: 'A', ref: 'CAP-1', amountMinor: 10_000 },
      { id: 'B', ref: 'R-1', type: 'refund', originalRef: 'CAP-1', amountMinor: 1_000 },
      { id: 'C', ref: 'R-2', type: 'refund', originalRef: 'CAP-1', amountMinor: 2_000 },
      { id: 'D', ref: 'CB', type: 'chargeback', originalRef: 'CAP-1', amountMinor: 10_000 },
      { id: 'E', ref: 'UNKNOWN', amountMinor: 700 },
    ];
    const r = reviewSettlement({ tenders, credits, refunds: [{ id: 'r1', originalRef: 'CAP-1', amountMinor: 1_000, refundedOn: '2026-10-15' }], settlementCycleDays: 1, asOf: '2026-10-16' });
    const named = new Set(r.exceptions.map((e) => e.settlementId).filter((x): x is string => x !== undefined));
    const matchedLines = r.matchedCount + r.matchedRefundCount; // A, and B against the till refund
    expect(matchedLines + named.size).toBe(credits.length);
    expect([...named].sort()).toEqual(['C', 'D', 'E']);
  });
});
