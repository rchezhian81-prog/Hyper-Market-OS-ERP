import { describe, it, expect } from 'vitest';
import {
  createTillSession, countTotalMinor, DENOMINATIONS, type TillConfig,
} from '../../apps/pos/src/till-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import { money } from '../../packages/contracts/src/money';

// M13 · M15 · §27 — the till itself, as opposed to the sale.

const CONFIG: TillConfig = {
  tillId: 'till-1', laneId: 'lane-1', cashierId: 'u-meena',
  tradingDay: '2026-08-05', varianceToleranceMinor: 10_000, // ₹100
};

const newTill = () => {
  const outbox = new SyncOutbox();
  const cash = new Ledger(new InMemoryLedgerStore());
  const stock = new Ledger(new InMemoryLedgerStore());
  return { till: createTillSession(CONFIG, cash, stock, outbox), outbox, cash };
};

const AT = '2026-08-05T19:00:00Z';

describe('counting the drawer', () => {
  it('adds up a denomination count exactly, in paise', () => {
    // Two ₹500 notes, three ₹100, one ₹20 → ₹1,320.00
    expect(countTotalMinor([
      { valueMinor: 50_000, count: 2 },
      { valueMinor: 10_000, count: 3 },
      { valueMinor: 2_000, count: 1 },
    ])).toBe(132_000);
  });

  it('lists real Indian denominations, largest first, each once', () => {
    expect(DENOMINATIONS[0]).toBe(50_000); // ₹500
    expect(DENOMINATIONS.at(-1)).toBe(100); // ₹1
    expect(new Set(DENOMINATIONS).size).toBe(DENOMINATIONS.length);
    expect([...DENOMINATIONS]).toEqual([...DENOMINATIONS].sort((a, b) => b - a));
  });

  it('is exact — no floats anywhere near the drawer', () => {
    // ₹0.10 counted seventy times is ₹7.00, not ₹6.999999999999999.
    expect(countTotalMinor(Array.from({ length: 70 }, () => ({ valueMinor: 10, count: 1 })))).toBe(700);
  });
});

describe('money in and out of the drawer', () => {
  it('records a pickup to the safe and lowers the drawer balance', () => {
    const { till } = newTill();
    till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT });
    const after = till.moveCash({ kind: 'pickup', amountMinor: 50_000, at: '2026-08-05T19:01:00Z' });
    expect(after.tillBalance).toEqual(money(150_000, 'INR'));
    expect(till.drawerBalanceMinor()).toBe(150_000);
  });

  it('queues every movement for the cloud — cash is never a local-only fact', () => {
    const { till, outbox } = newTill();
    till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT });
    expect(outbox.unsentCount()).toBeGreaterThan(0);
  });
});

describe('closing the shift — the blind count (M15)', () => {
  const closeWith = (countedMinor: number, reasonCode?: string) => {
    const { till } = newTill();
    return till.close({
      shiftId: 'shift-1', closedAt: AT,
      openingFloatMinor: 200_000, cashSalesMinor: 500_000,
      pickupsMinor: 100_000, cashRefundsMinor: 0,
      countedMinor,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  };

  // Expected = 200,000 + 500,000 − 100,000 − 0 = 600,000 (₹6,000)
  it('closes cleanly when the count matches', () => {
    const result = closeWith(600_000);
    expect(result.variance.minor).toBe(0);
    expect(result.exceptionRaised).toBe(false);
  });

  it('reports a shortfall as a NEGATIVE variance, counted minus expected', () => {
    // Short by ₹50. The sign says which way, and it says it the way a person reads it: less in the
    // drawer than there should be.
    expect(closeWith(595_000, 'short_change_given').variance.minor).toBe(-5_000);
  });

  it('raises an exception when the variance is material, and needs a reason', () => {
    // Tolerance is ₹100. ₹200 short is material.
    expect(() => closeWith(580_000)).toThrow();
    expect(closeWith(580_000, 'short_change_given').exceptionRaised).toBe(true);
  });

  it('lets an immaterial variance through without a reason', () => {
    // ₹50 short, inside tolerance. Demanding a reason for every rupee trains people to type
    // anything, and then the reasons on the material ones mean nothing either.
    expect(closeWith(595_000).exceptionRaised).toBe(false);
  });

  it('carries the expected figure only in the RESULT, after a count was given', () => {
    // `expectedCash` exists on the result and nowhere else, which is the shape that matters: the
    // cashier can see it once it can no longer influence what they wrote down.
    const result = closeWith(600_000);
    expect(result.expectedCash.minor).toBe(600_000);
    expect(result.countedCash.minor).toBe(600_000);
  });

  it('offers NO way to see the expected figure before counting', async () => {
    // Absence as a control, and the whole reason this is a separate module. Shown "expected:
    // ₹6,000", people write ₹6,000 — not from dishonesty, but because a number on a screen is an
    // answer and counting is work. A cash-up anchored to the expectation finds nothing.
    const { till } = newTill();
    for (const name of Object.keys(till)) {
      expect(name).not.toMatch(/expected|shouldBe|target|predict/i);
    }
    const module = await import('../../apps/pos/src/till-session');
    for (const name of Object.keys(module)) {
      expect(name).not.toMatch(/expectedCash|expectedMinor/i);
    }
    // And the interface itself has no such method — there is nothing to call early.
    expect(Object.keys(till).sort()).toEqual(['close', 'drawerBalanceMinor', 'moveCash', 'refund']);
  });
});

describe('refunds — a card refund is never assumed to have happened (M13-FR-04)', () => {
  const refundOf = (refundTender: 'cash' | 'card') => {
    const { till } = newTill();
    return till.refund({
      id: 'ret-1', number: 'RET-0001', originalSaleId: 'S-1',
      processedAt: AT, reasonCode: 'damaged',
      lines: [{
        productId: 'P1', uom: 'ea', quantityMinor: 1, originalQtyMinor: 1, disposition: 'damaged',
      }],
      refund: money(64_000, 'INR'), refundTender,
      maxRefund: money(64_000, 'INR'), approvalThresholdMinor: 100_000,
    });
  };

  it('settles a cash refund at the lane, offline', () => {
    expect(refundOf('cash').refundStatus).toBe('settled');
  });

  it('leaves a CARD refund pending — the provider has not reversed anything yet', () => {
    // Showing a completed refund for money that has not moved is how a customer is told they have
    // been paid back and finds out days later that they have not.
    expect(refundOf('card').refundStatus).toBe('pending');
  });
});
