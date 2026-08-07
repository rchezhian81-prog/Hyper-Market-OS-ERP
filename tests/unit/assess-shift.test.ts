import { describe, it, expect } from 'vitest';
import { assessShiftClose, type ShiftCloseInput } from '../../packages/till/src/index';

// The cloud-side shift-close guard (M14-FR-02). Pure: the cash figures in, expected/variance and
// whether it is material out. expected = float + cash sales − pickups − cash refunds.

const input = (over: Partial<ShiftCloseInput> = {}): ShiftCloseInput => ({
  openingFloatMinor: 50_000, cashSalesMinor: 100_000, pickupsMinor: 30_000, cashRefundsMinor: 5_000,
  countedCashMinor: 115_000, toleranceMinor: 500, ...over,
}); // expected = 115000

describe('assessShiftClose computes the blind over/short', () => {
  it('balances when counted equals expected', () => {
    expect(assessShiftClose(input())).toMatchObject({ ok: true, expectedMinor: 115_000, varianceMinor: 0, exceptionRaised: false });
  });

  it('is within tolerance for a small variance and needs no reason', () => {
    expect(assessShiftClose(input({ countedCashMinor: 115_300 }))).toMatchObject({ ok: true, varianceMinor: 300, isOver: true, exceptionRaised: false });
  });

  it('refuses a material variance with no reason', () => {
    const r = assessShiftClose(input({ countedCashMinor: 114_000 }));
    expect(r).toMatchObject({ ok: false, refusedBecause: 'material_variance_needs_a_reason', varianceMinor: -1_000, isShort: true });
  });

  it('accepts a material variance once a reason is given, and flags it for reconciliation', () => {
    const r = assessShiftClose(input({ countedCashMinor: 114_000, reasonCode: 'gave wrong change' }));
    expect(r).toMatchObject({ ok: true, exceptionRaised: true, reasonCode: 'gave wrong change' });
  });
});
