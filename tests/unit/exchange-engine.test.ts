import { describe, it, expect } from 'vitest';
import { assessExchange, returnedValueAtOriginalPrices, type ReplacementLine } from '../../packages/returns/src/exchange';
import type { OriginalSale, RecordedReturn } from '../../packages/returns/src/return-register';
import type { ReturnRequestLine } from '../../packages/returns/src/assess-return';

/**
 * **M13-FR-03 — the exchange engine (pure).** Goods coming back are credited at the price the bill actually
 * charged; the replacement is priced as rung; the difference is even / a refund / a top-up. The two register
 * rules hold: a product comes back at most once, and the credit never takes the bill past what it was paid.
 */

// A bill: 3 × P1 at ₹50 (₹150) and 1 × P2 at ₹80, paid ₹230.
const sale: OriginalSale = {
  saleId: 'S1', number: 'R-1', tradingDay: '2026-08-07', committedAt: '2026-08-07T10:00:00.000Z', totalMinor: 23000,
  lines: [
    { productId: 'P1', uom: 'each', quantityMinor: 3, lineTotalMinor: 15000 },
    { productId: 'P2', uom: 'each', quantityMinor: 1, lineTotalMinor: 8000 },
  ],
  tenders: [{ kind: 'cash', amountMinor: 23000 }],
};
const back = (productId: string, qty: number, disposition: ReturnRequestLine['disposition'] = 'resell'): ReturnRequestLine => ({ productId, uom: 'each', quantityMinor: qty, disposition });
const out = (productId: string, qty: number, unitPriceMinor: number): ReplacementLine => ({ productId, uom: 'each', quantityMinor: qty, unitPriceMinor, lineTotalMinor: qty * unitPriceMinor });
const assess = (returnLines: ReturnRequestLine[], replacementLines: ReplacementLine[], priorReturns: RecordedReturn[] = [], priorRefunds: { returnId: string; originalSaleId: string | null; refundMinor: number }[] = []) =>
  assessExchange({ sale, priorReturns, priorRefunds, exchange: { exchangeId: 'X1', returnLines, replacementLines } });

describe('returnedValueAtOriginalPrices — the bill\'s own price, never today\'s', () => {
  it('values returned units at the line\'s per-unit price', () => {
    expect(returnedValueAtOriginalPrices(sale, [back('P1', 2)])).toBe(10000);
    expect(returnedValueAtOriginalPrices(sale, [back('P1', 1), back('P2', 1)])).toBe(13000);
  });
  it('pro-rates the bill total by quantity when the record carries no line prices (a legacy load)', () => {
    const unpriced: OriginalSale = { ...sale, lines: sale.lines.map((l) => ({ productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor })) };
    expect(returnedValueAtOriginalPrices(unpriced, [back('P1', 2)])).toBe(11500); // 23000 / 4 units × 2
  });
  it('a product not on the bill is worth nothing here (the assessment refuses it separately)', () => {
    expect(returnedValueAtOriginalPrices(sale, [back('P9', 1)])).toBe(0);
  });
});

describe('assessExchange — the balance and the two register rules', () => {
  it('an even exchange moves no money', () => {
    const a = assess([back('P1', 1)], [out('P3', 1, 5000)]);
    expect(a.ok).toBe(true);
    expect(a).toMatchObject({ returnedValueMinor: 5000, replacementTotalMinor: 5000, netMinor: 0, balance: 'even', balanceMinor: 0, appliedMinor: 5000, restockedLines: 1 });
    expect(a.remaining).toEqual([{ productId: 'P1', returnableMinor: 2 }, { productId: 'P2', returnableMinor: 1 }]);
  });
  it('a dearer replacement is a top-up; a cheaper one is a refund of the balance', () => {
    expect(assess([back('P1', 1)], [out('P3', 1, 7500)])).toMatchObject({ ok: true, balance: 'top_up', balanceMinor: 2500, appliedMinor: 5000 });
    expect(assess([back('P1', 2)], [out('P3', 1, 6000)])).toMatchObject({ ok: true, balance: 'refund', balanceMinor: 4000, appliedMinor: 6000 });
  });
  it('refuses a product not on the bill and more than is still returnable — against the WHOLE history', () => {
    expect(assess([back('P9', 1)], [out('P3', 1, 5000)])).toMatchObject({ ok: false, refusedBecause: 'product_not_on_this_bill' });
    expect(assess([back('P1', 4)], [out('P3', 1, 5000)])).toMatchObject({ ok: false, refusedBecause: 'more_than_was_sold' });
    const prior: RecordedReturn[] = [{ returnId: 'RT0', originalSaleId: 'S1', processedAt: '2026-08-08T10:00:00.000Z', lines: [{ productId: 'P1', uom: 'each', quantityMinor: 2 }] }];
    expect(assess([back('P1', 2)], [out('P3', 1, 5000)], prior)).toMatchObject({ ok: false, refusedBecause: 'more_than_was_sold' });
    expect(assess([back('P1', 1)], [out('P3', 1, 5000)], prior).ok).toBe(true);
  });
  it('refuses a credit that would take the bill past what it was paid', () => {
    const refunds = [{ returnId: 'RT0', originalSaleId: 'S1', refundMinor: 20000 }];
    expect(assess([back('P1', 1)], [out('P3', 1, 5000)], [], refunds)).toMatchObject({ ok: false, refusedBecause: 'refund_exceeds_what_is_left' });
  });
  it('refuses nothing coming back, nothing going out, and replacement lines that do not add up', () => {
    expect(assess([], [out('P3', 1, 5000)])).toMatchObject({ ok: false, refusedBecause: 'no_return_lines' });
    expect(assess([back('P1', 1)], [])).toMatchObject({ ok: false, refusedBecause: 'no_replacement_lines' });
    expect(assess([back('P1', 1)], [{ productId: 'P3', uom: 'each', quantityMinor: 2, unitPriceMinor: 5000, lineTotalMinor: 5000 }])).toMatchObject({ ok: false, refusedBecause: 'replacement_lines_do_not_sum' });
    expect(assess([back('P1', 0)], [out('P3', 1, 5000)])).toMatchObject({ ok: false, refusedBecause: 'line_not_readable' });
  });
  it('honours a promotion discount ATTRIBUTED to a replacement line (SP-9b-ii): unit × qty − discount must equal the line total', () => {
    const discounted: ReplacementLine = { productId: 'P3', uom: 'each', quantityMinor: 2, unitPriceMinor: 3000, discountMinor: 1000, lineTotalMinor: 5000 };
    expect(assess([back('P1', 1)], [discounted])).toMatchObject({ ok: true, balance: 'even', replacementTotalMinor: 5000 });
    expect(assess([back('P1', 1)], [{ ...discounted, lineTotalMinor: 6000 }])).toMatchObject({ ok: false, refusedBecause: 'replacement_lines_do_not_sum' });
    expect(assess([back('P1', 1)], [{ ...discounted, discountMinor: -1 }])).toMatchObject({ ok: false, refusedBecause: 'line_not_readable' });
  });
  it('does not count itself — an idempotent retry is assessed as if new', () => {
    const own: RecordedReturn[] = [{ returnId: 'X1', originalSaleId: 'S1', processedAt: '2026-08-08T10:00:00.000Z', lines: [{ productId: 'P1', uom: 'each', quantityMinor: 3 }] }];
    expect(assess([back('P1', 3)], [out('P3', 3, 5000)], own, [{ returnId: 'X1', originalSaleId: 'S1', refundMinor: 15000 }]).ok).toBe(true);
  });
  it('counts only resold lines as restocked', () => {
    expect(assess([back('P1', 1, 'damaged'), back('P2', 1)], [out('P3', 1, 13000)])).toMatchObject({ ok: true, balance: 'even', restockedLines: 1 });
  });
});
