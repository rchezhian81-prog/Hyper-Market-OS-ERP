import { describe, it, expect } from 'vitest';
import { closeShift, MissingVarianceReasonError } from '../../packages/till/src/index';
import { money } from '../../packages/contracts/src/money';
import { SyncOutbox } from '../../packages/sync/src/index';

// The cashier shift close is a blind count: expected cash is computed here (never
// shown at count time), the over/short is derived, and a material variance becomes
// a valued reconciliation exception (M14-FR-02). Fully offline.

const AT = '2026-08-02T21:00:00Z';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shift-1',
    tillId: 'till-1',
    laneId: 'lane-1',
    cashierId: 'clerk-1',
    tradingDay: '2026-08-02',
    closedAt: AT,
    openingFloat: money(2_000_00, 'INR'),
    cashSales: money(10_000_00, 'INR'),
    pickups: money(3_000_00, 'INR'),
    cashRefunds: money(500_00, 'INR'),
    // expected = 2000 + 10000 − 3000 − 500 = ₹8,500
    countedCash: money(8_500_00, 'INR'),
    toleranceMinor: 100_00, // ₹100 tolerance
    ...overrides,
  };
}

describe('closeShift', () => {
  it('computes expected cash and balances when the count matches', () => {
    const outbox = new SyncOutbox();
    const result = closeShift(baseInput(), outbox);

    expect(result.expectedCash).toEqual(money(8_500_00, 'INR'));
    expect(result.variance).toEqual(money(0, 'INR'));
    expect(result.isOver).toBe(false);
    expect(result.isShort).toBe(false);
    expect(result.withinTolerance).toBe(true);
    expect(result.exceptionRaised).toBe(false);
    // one TillClosed event queued, no exception
    expect(outbox.unsentCount()).toBe(1);
    expect(outbox.pending()[0]?.event.type).toBe('TillClosed');
  });

  it('reports a small short within tolerance without raising an exception', () => {
    const outbox = new SyncOutbox();
    const result = closeShift(baseInput({ countedCash: money(8_450_00, 'INR') }), outbox);
    expect(result.variance).toEqual(money(-50_00, 'INR')); // ₹50 short
    expect(result.isShort).toBe(true);
    expect(result.withinTolerance).toBe(true);
    expect(result.exceptionRaised).toBe(false);
    expect(outbox.unsentCount()).toBe(1);
  });

  it('raises a reconciliation exception for a material short (with a reason)', () => {
    const outbox = new SyncOutbox();
    const result = closeShift(
      baseInput({ countedCash: money(8_000_00, 'INR'), reasonCode: 'till_shortfall' }),
      outbox,
    );
    expect(result.variance).toEqual(money(-500_00, 'INR')); // ₹500 short
    expect(result.isShort).toBe(true);
    expect(result.exceptionRaised).toBe(true);
    expect(result.reasonCode).toBe('till_shortfall');
    // TillClosed + ReconciliationExceptionRaised
    expect(outbox.unsentCount()).toBe(2);
    const types = outbox.pending().map((i) => i.event.type);
    expect(types).toContain('TillClosed');
    expect(types).toContain('ReconciliationExceptionRaised');
  });

  it('raises a reconciliation exception for a material over', () => {
    const outbox = new SyncOutbox();
    const result = closeShift(
      baseInput({ countedCash: money(9_000_00, 'INR'), reasonCode: 'till_overage' }),
      outbox,
    );
    expect(result.variance).toEqual(money(500_00, 'INR')); // ₹500 over
    expect(result.isOver).toBe(true);
    expect(result.exceptionRaised).toBe(true);
  });

  it('requires a reason code for a material variance (M14-FR-02)', () => {
    const outbox = new SyncOutbox();
    expect(() => closeShift(baseInput({ countedCash: money(8_000_00, 'INR') }), outbox)).toThrow(
      MissingVarianceReasonError,
    );
    expect(outbox.unsentCount()).toBe(0);
  });

  it('is idempotent on the shift id', () => {
    const outbox = new SyncOutbox();
    const input = baseInput({ countedCash: money(8_000_00, 'INR'), reasonCode: 'till_shortfall' });
    closeShift(input, outbox);
    closeShift(input, outbox);
    expect(outbox.unsentCount()).toBe(2); // still one TillClosed + one exception
  });
});
