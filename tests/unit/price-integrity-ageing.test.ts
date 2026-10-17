import { describe, it, expect } from 'vitest';
import { reconcilePriceIntegrity, type PriceObservation, type ChargedLine } from '../../packages/self-checkout/src/price-integrity-ageing';
import type { PriceEntry } from '../../packages/price-list/src/price-list';

// D-7 (roadmap v2.1 addendum, ratified R2; pairs with B25): "Price-of-record vs shelf vs POS vs app are reconciled into an
// ageing exception report; asserted".

const entry = (productId: string, minor: number, effectiveFrom: string, version = 1): PriceEntry => ({
  id: `${productId}-${version}`, productId, scope: 'store', scopeRef: 'BR1', price: { minor, currency: 'INR' }, effectiveFrom, effectiveTo: null, status: 'active', version,
});
const seen = (observationId: string, productId: string, surface: PriceObservation['surface'], priceMinor: number, observedAt: string): PriceObservation =>
  ({ observationId, branchId: 'BR1', productId, surface, priceMinor, observedAt, observedBy: 'u-walker', shelfAddress: 'A3-2' });
const sold = (saleId: string, productId: string, unitPriceMinor: number, committedAt: string, approvedOverride = false): ChargedLine =>
  ({ saleId, productId, unitPriceMinor, committedAt, approvedOverride });

const ASAT = '2026-10-16T12:00:00.000Z';

describe('D-7 price of record vs shelf vs POS vs app — an ageing exception report', () => {
  const report = reconcilePriceIntegrity({
    branchId: 'BR1', asAt: ASAT,
    entries: [
      entry('P1', 5_000, '2026-10-01'), entry('P1', 5_500, '2026-10-10', 2),
      entry('P2', 3_000, '2026-09-01'),
      entry('P3', 2_500, '2026-09-20'),
      entry('P4', 1_000, '2026-09-01'),
      { ...entry('P5', 900, '2026-09-01'), scopeRef: 'BR2' }, // another store's price: nothing to reconcile here
    ],
    observations: [
      seen('o1', 'P1', 'shelf_label', 5_000, '2026-10-05T09:00:00.000Z'), // agreed then; the price rose on 10-10 and nobody re-checked
      seen('o2', 'P1', 'app', 5_500, '2026-10-11T09:00:00.000Z'),
      seen('o3', 'P3', 'shelf_label', 2_000, '2026-10-01T09:00:00.000Z'),
      seen('o4', 'P3', 'shelf_label', 2_000, '2026-10-08T09:00:00.000Z'),
      seen('o5', 'P4', 'shelf_label', 1_200, '2026-10-02T09:00:00.000Z'),
      seen('o6', 'P4', 'shelf_label', 1_000, '2026-10-12T09:00:00.000Z'), // fixed and seen fixed: leaves the report
      { ...seen('o7', 'P1', 'shelf_label', 100, '2026-10-15T09:00:00.000Z'), branchId: 'BR2' }, // another store's shelf
    ],
    charged: [
      sold('s1', 'P1', 5_500, '2026-10-12T10:00:00.000Z'),
      sold('s2', 'P1', 6_000, '2026-10-15T10:00:00.000Z'),
      sold('s3', 'P1', 4_000, '2026-10-16T10:00:00.000Z', true), // lowered with a manager's approval: not a mismatch
      sold('s4', 'P2', 3_000, '2026-10-14T10:00:00.000Z'),
      sold('s5', 'P4', 1_000, '2026-10-14T10:00:00.000Z'),
    ],
  });

  it('reconciles every surface and the till against the price of record, and names each open exception', () => {
    expect(report.exceptions.map((e) => [e.productId, e.surface, e.kind, e.recordMinor, e.surfaceMinor ?? null])).toEqual([
      // legal exposure first (shown below record, charged above record), oldest first
      ['P3', 'shelf_label', 'shown_below_record', 2_500, 2_000],
      ['P1', 'shelf_label', 'shown_below_record', 5_500, 5_000],
      ['P1', 'pos', 'charged_above_record', 5_500, 6_000],
      ['P2', 'shelf_label', 'never_observed', 3_000, null],
    ]);
    expect(report.productsChecked).toBe(5);
  });

  it('ages each exception from the moment it began — the price change for a label nobody re-checked, the first wrong sighting, the first wrong charge', () => {
    const by = (p: string, s: string) => report.exceptions.find((e) => e.productId === p && e.surface === s)!;
    expect(by('P1', 'shelf_label')).toMatchObject({ openSince: '2026-10-10T00:00:00.000Z', ageDays: 6, band: '3-7 days', differenceMinor: -500, shelfAddress: 'A3-2' });
    expect(by('P3', 'shelf_label')).toMatchObject({ openSince: '2026-10-01T09:00:00.000Z', ageDays: 15, band: 'over 7 days' });
    expect(by('P1', 'pos')).toMatchObject({ openSince: '2026-10-15T10:00:00.000Z', ageDays: 1, band: '1-3 days', evidence: 'charged ₹60.00 on sale s2 at 2026-10-15T10:00:00.000Z' });
    expect(by('P2', 'shelf_label')).toMatchObject({ openSince: '2026-09-01T00:00:00.000Z', band: 'over 7 days' });
    expect(report.byBand).toEqual([
      { band: 'under 1 day', count: 0 }, { band: '1-3 days', count: 1 }, { band: '3-7 days', count: 1 }, { band: 'over 7 days', count: 2 },
    ]);
    expect(report.oldestOpenSince).toBe('2026-09-01T00:00:00.000Z');
    expect(by('P1', 'shelf_label').detail).toContain('the shown price is what the customer was offered');
  });

  it('a mismatch fixed and seen fixed leaves the report; the app agreeing raises nothing; an approved till override is not a mismatch', () => {
    expect(report.exceptions.some((e) => e.productId === 'P4')).toBe(false);
    expect(report.exceptions.some((e) => e.surface === 'app')).toBe(false);
    expect(report.exceptions.some((e) => e.evidence.includes('s3'))).toBe(false);
  });

  it('as at an earlier moment the same facts give the earlier truth (nothing stored that could drift)', () => {
    const before = reconcilePriceIntegrity({
      branchId: 'BR1', asAt: '2026-10-09T12:00:00.000Z',
      entries: [entry('P1', 5_000, '2026-10-01'), entry('P1', 5_500, '2026-10-10', 2)],
      observations: [seen('o1', 'P1', 'shelf_label', 5_000, '2026-10-05T09:00:00.000Z')], charged: [],
    });
    expect(before.exceptions).toEqual([]);
    expect(before.detail).toBe('all 1 product(s) agree with their price of record on every surface seen and at the till');
  });
});

describe('NEW-9: each till sale is judged against the price of record in force at its own moment', () => {
  const drop = [{ ...entry('P1', 12_000, '2026-10-01T00:00:00.000Z'), effectiveTo: '2026-10-09T23:59:59.999Z' }, entry('P1', 10_000, '2026-10-10T00:00:00.000Z', 2)];
  const shelf = [seen('o1', 'P1', 'shelf_label', 10_000, '2026-10-10T09:00:00.000Z')];
  it('the verifier\'s case: a correct ₹120 sale before the drop to ₹100 is no mismatch', () => {
    const r = reconcilePriceIntegrity({ branchId: 'BR1', asAt: ASAT, entries: drop, observations: shelf, charged: [sold('s1', 'P1', 12_000, '2026-10-05T10:00:00.000Z')] });
    expect(r.exceptions).toEqual([]);
  });
  it('a rise does not make a correct earlier sale "charged below record" either', () => {
    const rise = [{ ...entry('P1', 10_000, '2026-10-01T00:00:00.000Z'), effectiveTo: '2026-10-09T23:59:59.999Z' }, entry('P1', 12_000, '2026-10-10T00:00:00.000Z', 2)];
    const r = reconcilePriceIntegrity({ branchId: 'BR1', asAt: ASAT, entries: rise, observations: [seen('o1', 'P1', 'shelf_label', 12_000, '2026-10-10T09:00:00.000Z')], charged: [sold('s1', 'P1', 10_000, '2026-10-05T10:00:00.000Z')] });
    expect(r.exceptions).toEqual([]);
  });
  it('a sale wrong at its own time is caught against THAT price, aged from the first of the run of wrong sales', () => {
    const r = reconcilePriceIntegrity({ branchId: 'BR1', asAt: ASAT, entries: drop, observations: shelf, charged: [
      sold('s0', 'P1', 10_000, '2026-10-11T10:00:00.000Z'), sold('s1', 'P1', 12_000, '2026-10-12T10:00:00.000Z'), sold('s2', 'P1', 12_000, '2026-10-14T10:00:00.000Z'),
    ] });
    expect(r.exceptions.map((e) => [e.surface, e.kind, e.recordMinor, e.surfaceMinor, e.openSince])).toEqual([['pos', 'charged_above_record', 10_000, 12_000, '2026-10-12T10:00:00.000Z']]);
  });
  it('is not carried past a later change in the price of record — the next sale is the evidence', () => {
    const r = reconcilePriceIntegrity({ branchId: 'BR1', asAt: ASAT, entries: drop, observations: shelf, charged: [sold('s1', 'P1', 11_000, '2026-10-05T10:00:00.000Z')] });
    expect(r.exceptions.filter((e) => e.surface === 'pos')).toEqual([]);
  });
});
