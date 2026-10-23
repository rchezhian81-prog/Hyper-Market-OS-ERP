import { describe, it, expect } from 'vitest';
import {
  agreementProblems, blanketDrawdown, judgeCallOff, segregationConflict, firstSegregationConflict, ordersAPaymentPays,
  type BlanketAgreement, type BlanketRelease, type PurchaseActors,
} from '../../packages/purchasing/src/index';

// M06-FR-02 (OB-288 P3): the blanket-PO engine and the separation-of-duties engine across one purchase. Pure.

const INR = 'INR' as const;
const agreement = (over: Partial<BlanketAgreement> = {}): BlanketAgreement => ({
  agreementId: 'bpo-1', supplierId: 'sup-1', currency: INR, ceilingMinor: 100_000, validFrom: '2026-01-01', validTo: '2026-12-31',
  lines: [{ productId: 'rice', agreedUnitCost: { minor: 1_000, currency: INR }, maxQty: 50 }, { productId: 'oil', agreedUnitCost: { minor: 2_499, currency: INR, per: 2 } }],
  proposedBy: 'u-buyer', proposedAt: '2026-01-01T00:00:00.000Z', status: 'approved', approvedBy: 'u-owner', approvedAt: '2026-01-01T01:00:00.000Z', ...over,
});
const release = (poId: string, status: BlanketRelease['status'], rice: number, cancelled = 0): BlanketRelease => ({
  poId, status, lines: [{ productId: 'rice', orderedQty: rice, unitCost: { minor: 1_000, currency: INR } }], cancelledByProduct: cancelled > 0 ? { rice: cancelled } : {},
});

describe('blanket purchase orders (M06-FR-02)', () => {
  it('names every reason an agreement cannot be recorded', () => {
    expect(agreementProblems(agreement())).toEqual([]);
    expect(agreementProblems(agreement({ lines: [] }))).toContain('no_lines');
    expect(agreementProblems(agreement({ ceilingMinor: 0 }))).toContain('bad_ceiling');
    expect(agreementProblems(agreement({ validTo: '2025-12-31' }))).toContain('ends_before_it_starts');
    expect(agreementProblems(agreement({ validFrom: '2026-02-30' }))).toContain('bad_dates');
    expect(agreementProblems(agreement({ lines: [agreement().lines[0]!, agreement().lines[0]!] }))).toContain('duplicate_product');
    expect(agreementProblems(agreement({ lines: [{ productId: 'x', agreedUnitCost: { minor: 5, currency: 'USD' as never } }] }))).toContain('currency_mismatch');
  });

  it('prices a release at the agreement\'s cost (an OB-46 per-pack cost exactly) and says what is left', () => {
    const j = judgeCallOff({ agreement: agreement(), others: [], onDate: '2026-06-01', lines: [{ productId: 'rice', quantity: 10 }, { productId: 'oil', quantity: 3 }] });
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.lines).toEqual([
      { productId: 'rice', orderedQty: 10, unitCost: { minor: 1_000, currency: INR } },
      { productId: 'oil', orderedQty: 3, unitCost: { minor: 2_499, currency: INR, per: 2 } },
    ]);
    expect(j.valueMinor).toBe(10_000 + 3_749); // 3 × 2499 ÷ 2 = 3748.5 → 3749, rounded once
    expect(j.remainingAfterMinor).toBe(100_000 - 13_749);
  });

  it('counts proposed releases in full and issued ones net of cancellations; refuses past either ceiling', () => {
    const others = [release('r1', 'issued', 30, 10), release('r2', 'proposed', 20)];
    const d = blanketDrawdown(agreement(), others);
    expect(d).toMatchObject({ issuedMinor: 20_000, pendingMinor: 20_000, remainingMinor: 60_000 });
    expect(d.byProduct.find((p) => p.productId === 'rice')).toEqual({ productId: 'rice', maxQty: 50, releasedQty: 40, remainingQty: 10 });
    const qty = judgeCallOff({ agreement: agreement(), others, onDate: '2026-06-01', lines: [{ productId: 'rice', quantity: 11 }] });
    expect(qty).toMatchObject({ ok: false, refusal: 'quantity_ceiling_exceeded', productId: 'rice' });
    const value = judgeCallOff({ agreement: agreement({ ceilingMinor: 45_000 }), others, onDate: '2026-06-01', lines: [{ productId: 'rice', quantity: 6 }] });
    expect(value).toMatchObject({ ok: false, refusal: 'ceiling_exceeded' });
    expect(judgeCallOff({ agreement: agreement({ ceilingMinor: 45_000 }), others, onDate: '2026-06-01', lines: [{ productId: 'rice', quantity: 5 }] }).ok).toBe(true);
  });

  it('releases nothing against an unapproved, not-yet-valid or expired agreement, or for a product not on it', () => {
    const lines = [{ productId: 'rice', quantity: 1 }];
    expect(judgeCallOff({ agreement: agreement({ status: 'proposed', approvedBy: null }), others: [], onDate: '2026-06-01', lines })).toMatchObject({ ok: false, refusal: 'agreement_not_approved' });
    expect(judgeCallOff({ agreement: agreement(), others: [], onDate: '2025-12-31', lines })).toMatchObject({ ok: false, refusal: 'outside_validity' });
    expect(judgeCallOff({ agreement: agreement(), others: [], onDate: '2027-01-01', lines })).toMatchObject({ ok: false, refusal: 'outside_validity' });
    expect(judgeCallOff({ agreement: agreement(), others: [], onDate: '2026-12-31', lines }).ok).toBe(true); // inclusive
    expect(judgeCallOff({ agreement: agreement(), others: [], onDate: '2026-06-01', lines: [{ productId: 'ghee', quantity: 1 }] })).toMatchObject({ ok: false, refusal: 'product_not_on_agreement' });
    expect(judgeCallOff({ agreement: agreement(), others: [], onDate: '2026-06-01', lines: [{ productId: 'rice', quantity: 0 }] })).toMatchObject({ ok: false, refusal: 'bad_quantity' });
  });
});

describe('separation of duties across one purchase (M06-FR-02 · §28)', () => {
  const actors: PurchaseActors = { poId: 'po-1', requisition: ['u-buyer'], receipt: ['u-recv'], match: ['u-acct'], payment: [] };

  it('refuses a person who already did a different act on the same order, and allows the same act twice', () => {
    expect(segregationConflict(actors, 'receipt', 'u-buyer')).toMatchObject({ act: 'receipt', alreadyDid: 'requisition' });
    expect(segregationConflict(actors, 'match', 'u-recv')).toMatchObject({ alreadyDid: 'receipt' });
    expect(segregationConflict(actors, 'payment', 'u-acct')?.detail).toContain('matched the bill');
    expect(segregationConflict(actors, 'receipt', 'u-recv')).toBeUndefined(); // a second delivery by the same receiver
    expect(segregationConflict(actors, 'payment', 'u-fin')).toBeUndefined();
  });

  it('checks every order a payment pays and both people on it', () => {
    const other: PurchaseActors = { poId: 'po-2', requisition: ['u-fin'], receipt: [], match: [], payment: [] };
    expect(firstSegregationConflict([actors, other], 'payment', ['u-clerk', 'u-fin'])).toMatchObject({ poId: 'po-2', userId: 'u-fin', alreadyDid: 'requisition' });
    expect(firstSegregationConflict([actors], 'payment', ['u-clerk', 'u-fin'])).toBeUndefined();
  });

  it('a payment pays the oldest open bills first — opening balance, then bills by match date — and every bill still open', () => {
    const bills = [
      { invoiceId: 'i-2', poId: 'po-2', payableMinor: 300, at: '2026-10-02' },
      { invoiceId: 'i-1', poId: 'po-1', payableMinor: 500, at: '2026-10-01' },
      { invoiceId: 'i-3', poId: null, payableMinor: 100, at: '2026-10-03' },
      { invoiceId: 'i-4', poId: 'po-4', payableMinor: 200, at: '2026-10-04' },
    ];
    expect(ordersAPaymentPays({ openingMinor: 0, bills, paidBeforeMinor: 0 })).toEqual(['po-1', 'po-2', 'po-4']);
    expect(ordersAPaymentPays({ openingMinor: 0, bills, paidBeforeMinor: 500 })).toEqual(['po-2', 'po-4']);
    expect(ordersAPaymentPays({ openingMinor: 0, bills, paidBeforeMinor: 899 })).toEqual(['po-4']); // i-3 has no order
    expect(ordersAPaymentPays({ openingMinor: 1_000, bills, paidBeforeMinor: 1_400 })).toEqual(['po-1', 'po-2', 'po-4']); // only 400 past the opening: i-1 still part-open
    expect(ordersAPaymentPays({ openingMinor: 0, bills, paidBeforeMinor: 1_100 })).toEqual([]);
  });
});
