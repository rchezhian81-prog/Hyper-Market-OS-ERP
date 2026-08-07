import { describe, it, expect } from 'vitest';
import {
  reconcile,
  CardDataError,
  type PosTender,
  type SettlementLine,
} from '../../packages/reconciliation/src/index';

// Reconciliation matches tenders to settlements by token/ref and amount, flags
// every mismatch as a valued exception, and never touches a card PAN (M23-FR-03).

function tender(id: string, ref: string, amountMinor: number): PosTender {
  return { id, ref, amountMinor };
}
function settle(id: string, ref: string, amountMinor: number): SettlementLine {
  return { id, ref, amountMinor };
}

describe('reconcile', () => {
  it('matches tenders to settlements on ref and amount', () => {
    const result = reconcile(
      [tender('t1', 'TXN-1', 100_00), tender('t2', 'TXN-2', 50_00)],
      [settle('s1', 'TXN-1', 100_00), settle('s2', 'TXN-2', 50_00)],
    );
    expect(result.matchedCount).toBe(2);
    expect(result.exceptionCount).toBe(0);
  });

  it('flags a tender that never settled', () => {
    const result = reconcile([tender('t1', 'TXN-1', 100_00)], []);
    expect(result.matchedCount).toBe(0);
    expect(result.exceptions).toEqual([
      { kind: 'unsettled_tender', ref: 'TXN-1', tenderId: 't1' },
    ]);
  });

  it('flags a settlement with no POS tender', () => {
    const result = reconcile([], [settle('s1', 'TXN-9', 100_00)]);
    expect(result.exceptions).toEqual([
      { kind: 'unknown_settlement', ref: 'TXN-9', settlementId: 's1' },
    ]);
  });

  it('flags an amount mismatch with the variance', () => {
    const result = reconcile(
      [tender('t1', 'TXN-1', 100_00)],
      [settle('s1', 'TXN-1', 97_00)], // settled ₹3 short
    );
    expect(result.matchedCount).toBe(0);
    expect(result.exceptions[0]).toMatchObject({
      kind: 'amount_mismatch',
      ref: 'TXN-1',
      expectedMinor: 100_00,
      actualMinor: 97_00,
      varianceMinor: -3_00,
    });
  });

  it('flags an ambiguous duplicate reference', () => {
    const result = reconcile(
      [tender('t1', 'DUP', 100_00), tender('t2', 'DUP', 100_00)],
      [settle('s1', 'DUP', 100_00)],
    );
    expect(result.exceptions.some((e) => e.kind === 'duplicate_ref' && e.ref === 'DUP')).toBe(true);
    expect(result.matchedCount).toBe(0);
  });

  it('refuses a reference that looks like a card number (hard rule #3)', () => {
    expect(() => reconcile([tender('t1', '4111111111111111', 100_00)], [])).toThrow(CardDataError);
    // also with spaces/dashes
    expect(() => reconcile([], [settle('s1', '4111-1111-1111-1111', 100_00)])).toThrow(CardDataError);
  });

  it('produces deterministic, tenders-first exception ordering', () => {
    const result = reconcile(
      [tender('t2', 'A', 10_00), tender('t1', 'B', 20_00)], // both unsettled
      [settle('s1', 'C', 30_00)], // unknown
    );
    expect(result.exceptions.map((e) => e.kind)).toEqual([
      'unsettled_tender', // t1 (sorted by id)
      'unsettled_tender', // t2
      'unknown_settlement', // s1
    ]);
  });
});
