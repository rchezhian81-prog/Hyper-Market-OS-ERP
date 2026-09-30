import { describe, it, expect } from 'vitest';
import { matchLinesFrom, invoicedBeforeOn, threeWayMatch, type SupplierInvoiceRecord } from '../../services/purchase/src/index';
import type { StoredPurchaseOrder } from '../../services/purchase/src/purchase-orders';

/**
 * SP-7c (M07-FR-04 · invoiced-to-date): a SECOND bill against the same order is judged against what the first left — the
 * order and the receipts remaining after earlier invoices — so the same goods are never paid for twice, and together the
 * bills are said to over-claim the order. Pure pieces; the route is covered in `tests/integration/supplier-master.test.ts`.
 */

const AT = '2026-09-30T10:00:00.000Z';
const LATER = '2026-09-30T11:00:00.000Z';
const order: StoredPurchaseOrder = {
  poId: 'po-1', number: 'po-1', supplierId: 's-1', requisitionedBy: 'u-buyer', at: AT, status: 'issued', approvedBy: 'u-owner', issuedAt: AT,
  lines: [{ productId: 'p1', orderedQty: 10, unitCost: { minor: 500, currency: 'INR' } }],
  totalMinor: 5000, currency: 'INR', receivedByProduct: { p1: 10 }, cancelledByProduct: {}, amendmentCount: 0,
};
const inv = (invoiceId: string, quantity: number, capturedAt: string, poId: string | null = 'po-1'): SupplierInvoiceRecord => ({
  invoiceId, supplierId: 's-1', poId, lines: [{ productId: 'p1', quantity, unitPriceMinor: 500, lineTotalMinor: quantity * 500 }],
  declaredTotalMinor: quantity * 500, totalMinor: quantity * 500, currency: 'INR', capturedBy: 'u-buyer', capturedAt, approvedBy: 'u-checker', approvedAt: capturedAt,
  source: 'head-office', governanceFlags: [],
});

describe('invoicedBeforeOn — what earlier bills against the same order already claimed', () => {
  it('counts only invoices against the SAME order captured BEFORE this one (ties by id); never itself, never another order', () => {
    const first = inv('inv-1', 10, AT);
    const second = inv('inv-2', 10, LATER);
    const other = inv('inv-9', 99, AT, 'po-2');
    const twin = inv('inv-0', 3, LATER); // same moment as inv-2, lower id → earlier
    const all = [first, second, other, twin];
    expect(invoicedBeforeOn('po-1', first, all)).toEqual({});
    expect(invoicedBeforeOn('po-1', second, all)).toEqual({ p1: 13 });
    expect(invoicedBeforeOn('po-1', twin, all)).toEqual({ p1: 10 });
    expect(invoicedBeforeOn('po-2', other, all)).toEqual({});
  });
});

describe('matchLinesFrom with what was invoiced before — the second bill sees only what the first left', () => {
  it('the first bill pays in full; the second for the same goods pays NOTHING and is withheld; a bill for a second delivery pays what arrived beyond the first', () => {
    const first = inv('inv-1', 10, AT);
    const second = inv('inv-2', 10, LATER);
    expect(matchLinesFrom(order, first, {})).toEqual([{ productId: 'p1', orderedQty: 10, receivedQty: 10, invoicedQty: 10, orderedUnitMinor: 500, invoicedUnitMinor: 500 }]);
    const again = matchLinesFrom(order, second, { p1: 10 });
    expect(again).toEqual([{ productId: 'p1', orderedQty: 0, receivedQty: 0, invoicedQty: 10, orderedUnitMinor: 500, invoicedUnitMinor: 500 }]);
    expect(threeWayMatch({ lines: again })).toMatchObject({ payableMinor: 0, withheldMinor: 5000, blocked: true });
    // A genuine second delivery: 20 received against an order of 20; the first bill took 10 → the second is judged against the other 10.
    const bigger: StoredPurchaseOrder = { ...order, lines: [{ productId: 'p1', orderedQty: 20, unitCost: { minor: 500, currency: 'INR' } }], receivedByProduct: { p1: 20 } };
    expect(threeWayMatch({ lines: matchLinesFrom(bigger, second, { p1: 10 }) })).toMatchObject({ payableMinor: 5000, withheldMinor: 0, blocked: false });
    // Nothing invoiced before behaves exactly as before SP-7c.
    expect(matchLinesFrom(order, first)).toEqual(matchLinesFrom(order, first, {}));
  });
});
