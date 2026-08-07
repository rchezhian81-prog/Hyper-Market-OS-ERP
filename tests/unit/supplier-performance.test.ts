import { describe, it, expect } from 'vitest';
import {
  scoreSupplier,
  accrueRebate,
  reviewContracts,
  DEFAULT_WEIGHTS,
  type ReceiptFact,
  type SupplierContract,
} from '../../packages/purchasing/src/index';
import { money } from '../../packages/contracts/src/money';

// M06-FR-03 — buyers judge suppliers on the relationship; the numbers usually say
// something different, and the gap is expensive.

const INR = 'INR' as const;
const TODAY = '2026-08-04';

const CONTRACT: SupplierContract = {
  contractId: 'c-1',
  supplierId: 'sup-1',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  agreedLeadTimeDays: 7,
  approvedBy: 'purchase-1',
};

function receipt(over: Partial<ReceiptFact> = {}): ReceiptFact {
  return {
    poId: 'po-1',
    supplierId: 'sup-1',
    orderedOn: '2026-07-01',
    receivedOn: '2026-07-08',
    orderedQtyMinor: 100,
    receivedQtyMinor: 100,
    agreedValue: money(100_000, INR),
    invoicedValue: money(100_000, INR),
    ...over,
  };
}

describe('scoreSupplier — from what happened, never from an opinion', () => {
  it('scores a supplier who does everything right', () => {
    const card = scoreSupplier({
      supplierId: 'sup-1',
      receipts: [receipt(), receipt({ poId: 'po-2', orderedOn: '2026-07-10', receivedOn: '2026-07-17' })],
      contract: CONTRACT,
    });
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 10_000 });
    expect(card.onTime).toEqual({ kind: 'rated', bp: 10_000 });
    expect(card.overall.kind).toBe('rated');
    expect(card.summary).toBe('no concerns in the period');
  });

  it('names the short deliverer for what it costs, not just the percentage', () => {
    const card = scoreSupplier({
      supplierId: 'sup-1',
      receipts: [receipt({ receivedQtyMinor: 82 })],
      contract: CONTRACT,
    });
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 8_200 });
    expect(card.summary).toContain('the lost sale dwarfs any price advantage');
  });

  it('scores the SPREAD of lead time, not just its average', () => {
    // A reliable 7 days beats an average of 6 that swings 3→11.
    const reliable = scoreSupplier({
      supplierId: 'sup-1',
      receipts: [
        receipt({ orderedOn: '2026-07-01', receivedOn: '2026-07-08' }),
        receipt({ poId: 'p2', orderedOn: '2026-07-10', receivedOn: '2026-07-17' }),
        receipt({ poId: 'p3', orderedOn: '2026-07-20', receivedOn: '2026-07-27' }),
      ],
      contract: CONTRACT,
    });
    const erratic = scoreSupplier({
      supplierId: 'sup-1',
      receipts: [
        receipt({ orderedOn: '2026-07-01', receivedOn: '2026-07-04' }),
        receipt({ poId: 'p2', orderedOn: '2026-07-10', receivedOn: '2026-07-21' }),
        receipt({ poId: 'p3', orderedOn: '2026-07-20', receivedOn: '2026-07-24' }),
      ],
      contract: CONTRACT,
    });
    expect(reliable.leadTimeReliability).toEqual({ kind: 'rated', bp: 10_000 });
    expect(erratic.leadTimeReliability.kind).toBe('rated');
    if (erratic.leadTimeReliability.kind === 'rated') {
      expect(erratic.leadTimeReliability.bp).toBeLessThan(8_000);
    }
    expect(erratic.averageLeadTimeDays).toBeLessThan(reliable.averageLeadTimeDays!);
    // Lower average, worse score — which is the whole point.
    expect(erratic.summary).toContain('you can only plan around a number you can trust');
  });

  it('catches invoices that drift above the agreed value', () => {
    const card = scoreSupplier({
      supplierId: 'sup-1',
      receipts: [receipt({ invoicedValue: money(102_000, INR) })],
      contract: CONTRACT,
    });
    expect(card.priceAdherence).toEqual({ kind: 'rated', bp: 9_800 });
    expect(card.summary).toContain('invoices run above the agreed value by 2.0%');
  });

  it('scores quality on what was accepted, not on what was sent', () => {
    const card = scoreSupplier({
      supplierId: 'sup-1',
      receipts: [receipt({ rejectedQtyMinor: 5 })],
      contract: CONTRACT,
    });
    expect(card.quality).toEqual({ kind: 'rated', bp: 9_500 });
    expect(card.summary).toContain('5.0% of what arrived was rejected');
  });

  it('says "not rated" rather than flattering a supplier with no evidence', () => {
    const card = scoreSupplier({ supplierId: 'sup-9', receipts: [] });
    expect(card.overall.kind).toBe('not_rated');
    expect(card.summary).toContain('not the same as good');
    // On-time cannot be judged without a contracted lead time.
    const noContract = scoreSupplier({ supplierId: 'sup-1', receipts: [receipt()] });
    expect(noContract.onTime).toEqual({
      kind: 'not_rated',
      because: 'no contracted lead time to measure against',
    });
  });

  it('takes the tenant’s own weights — availability-led or price-led', () => {
    const receipts = [receipt({ receivedQtyMinor: 80, invoicedValue: money(95_000, INR) })];
    const availabilityLed = scoreSupplier({ supplierId: 'sup-1', receipts, contract: CONTRACT });
    const priceLed = scoreSupplier({
      supplierId: 'sup-1',
      receipts,
      contract: CONTRACT,
      weights: { ...DEFAULT_WEIGHTS, fillRateBp: 500, priceAdherenceBp: 5_000 },
    });
    if (availabilityLed.overall.kind === 'rated' && priceLed.overall.kind === 'rated') {
      // The same supplier scores better for a shop that competes on price.
      expect(priceLed.overall.bp).toBeGreaterThan(availabilityLed.overall.bp);
    }
  });
});

describe('accrueRebate — money already earned and not yet collected', () => {
  const scheme = {
    schemeId: 'rb-1',
    supplierId: 'sup-1',
    basis: 'purchase_value' as const,
    rateBp: 300, // 3%
    thresholdMinor: 1_000_000,
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
    approvedBy: 'finance-1',
  };

  it('accrues nothing below the threshold, and says how far short', () => {
    const result = accrueRebate({ scheme, basisAmount: money(800_000, INR) });
    expect(result.thresholdMet).toBe(false);
    expect(result.accrued).toEqual(money(0, INR));
    expect(result.detail).toContain('200000 more to earn anything');
  });

  it('accrues above the threshold and shows what is unclaimed', () => {
    const result = accrueRebate({ scheme, basisAmount: money(2_000_000, INR) });
    expect(result.accrued).toEqual(money(60_000, INR)); // 3% of ₹20,000
    expect(result.outstanding).toEqual(money(60_000, INR));
    expect(result.detail).toContain('NOT YET CLAIMED — this is money already made');
  });

  it('reconciles against what finance actually received', () => {
    const result = accrueRebate({
      scheme,
      basisAmount: money(2_000_000, INR),
      received: money(60_000, INR),
    });
    expect(result.outstanding).toEqual(money(0, INR));
    expect(result.detail).toBe('fully claimed and received');
  });

  it('measures a growth scheme against its baseline, never the raw total', () => {
    const result = accrueRebate({
      scheme: { ...scheme, basis: 'growth_over_baseline', thresholdMinor: 0 },
      basisAmount: money(2_000_000, INR),
      baselineAmount: money(1_500_000, INR),
    });
    // 3% of the ₹5,000 of growth, not of the ₹20,000 total.
    expect(result.accrued).toEqual(money(15_000, INR));
  });
});

describe('reviewContracts — buying on no terms at all', () => {
  it('flags an expired contract in the language that matters', () => {
    const alerts = reviewContracts([{ ...CONTRACT, endsOn: '2026-06-30' }], TODAY);
    expect(alerts[0]?.finding).toBe('expired');
    expect(alerts[0]?.detail).toContain('every order since has been placed on no agreed terms');
  });

  it('warns before expiry, worst first, and flags unapproved terms', () => {
    const alerts = reviewContracts(
      [
        { ...CONTRACT, contractId: 'far', endsOn: '2026-12-31' },
        { ...CONTRACT, contractId: 'soon', endsOn: '2026-09-01' },
        { ...CONTRACT, contractId: 'unapproved', endsOn: '2026-10-01', approvedBy: undefined },
      ],
      TODAY,
    );
    expect(alerts.map((a) => a.contractId)).toEqual(['soon', 'unapproved', 'far']);
    expect(alerts.find((a) => a.contractId === 'soon')?.finding).toBe('expiring_soon');
    expect(alerts.find((a) => a.contractId === 'unapproved')?.finding).toBe('unapproved');
  });
});
