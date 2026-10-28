import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings, dayFromToday } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';

/**
 * **FG-4 · D03-FR-05 "landed cost, freight and purchase-price variance" — the PPV report: each goods-receipt line's cost as
 * received against the purchase order's price and the contract (approved blanket agreement) price on the day, rolled up
 * per product and per receipt, with the lines behind every figure (drill-through).**
 *
 *   • rice arrived at ₹52 against an order at ₹50 and a contract at ₹48: +₹20 against the order, +₹40 against the contract;
 *   • a second order's rice arrived ₹1 under the order: the product roll-up nets them; the receipt roll-up keeps them apart;
 *   • dal has no contract price on file — said, never a zero;
 *   • drilling by product or by receipt returns exactly the lines behind that figure;
 *   • a cashier cannot read it; a period that runs backwards is refused; a branch-limited reader sees only their branches
 *     and is told how many receipts were outside them;
 *   • OB-517 (owner, 28 Oct 2026): the cost "as received" is the price on the MATCHED SUPPLIER BILL — never the figure typed
 *     at the door (the receipt books the order's cost); a receipt with no matched bill yet shows "not yet billed";
 *   • a cold restart reads the same.
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Rollup { key: string; lines: number; comparedLines: number; varianceMinor: number; contractLines: number; contractVarianceMinor: number }
interface Report { lines: { grnId: string; productId: string; notCompared?: string; receivedUnitCost: { minor: number } | null; receivedValueMinor: number | null; invoiceId: string | null; order?: { varianceMinor: number; basis: string }; contract?: { agreementId: string; varianceMinor: number } }[]; byProduct: Rollup[]; byReceipt: Rollup[]; totals: Rollup & { notCompared: Record<string, number> }; outsideYourBranches?: number }

describe.each(backings)('D03-FR-05 — purchase-price variance — on $name', ({ harness }) => {
  it('per product and per receipt, against the order and the contract, with the lines behind each figure', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    // The contract: an approved blanket agreement with sup-1 naming rice at ₹48 (dal is not on it).
    expect((await call('POST', '/v1/purchase/blanket-orders/bpo-1', P3.BUYER, {
      supplierId: 'sup-1', currency: 'INR', ceilingMinor: 10_000_000, validFrom: dayFromToday(-2), validTo: dayFromToday(90), deliverToLocationId: P3.STORE,
      lines: [{ productId: 'rice', agreedUnitCost: { minor: 4_800, currency: 'INR' } }],
    })).status).toBe(201);
    expect((await call('POST', '/v1/purchase/blanket-orders/bpo-1/approval', P3.OWNER, { reason: 'annual rice terms' })).status).toBe(200);

    await issuedOrder(call, 'po-1', [{ productId: 'rice', qty: 10, unitMinor: 5_000 }, { productId: 'dal', qty: 5, unitMinor: 3_000 }]);
    await received(call, 'grn-1', 'po-1', [{ productId: 'rice', qty: 10, unitMinor: 5_200 }, { productId: 'dal', qty: 5, unitMinor: 3_000 }]);
    await issuedOrder(call, 'po-2', [{ productId: 'rice', qty: 4, unitMinor: 5_000 }]);
    await received(call, 'grn-2', 'po-2', [{ productId: 'rice', qty: 4, unitMinor: 4_900 }]);

    const read = async (q = '', userId: string = P3.OWNER, hh = h, branchId?: string) => {
      const query = Object.fromEntries(new URLSearchParams(q.replace(/^\?/, '')));
      const r = await hh.request({ method: 'GET', path: '/v1/purchase/price-variance', userId, tenantId: T, query, ...(branchId === undefined ? {} : { branchId }) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Report;
    };
    // OB-517: no bill matched yet — every line is "not yet billed": counted, never compared at the typed ₹52 / ₹49.
    const unbilled = await read('?supplierId=sup-1');
    expect(unbilled.totals).toMatchObject({ lines: 3, comparedLines: 0, varianceMinor: 0, notCompared: { not_yet_billed: 3 } });
    expect(unbilled.lines.every((l) => l.notCompared === 'not_yet_billed' && l.receivedUnitCost === null && l.receivedValueMinor === null && l.invoiceId === null)).toBe(true);
    // The supplier's bills, captured as the paper says and matched by the accountant: rice ₹52 on po-1, ₹49 on po-2.
    await capturedAndMatched(call, 'INV-1', 'po-1', [{ productId: 'rice', qty: 10, unitMinor: 5_200 }, { productId: 'dal', qty: 5, unitMinor: 3_000 }]);
    await capturedAndMatched(call, 'INV-2', 'po-2', [{ productId: 'rice', qty: 4, unitMinor: 4_900 }]);
    // OB-530 (round 8): the report reads only the bill matched to THAT receipt — matched to the order alone, still unbilled.
    expect((await read('?supplierId=sup-1')).totals).toMatchObject({ comparedLines: 0, notCompared: { not_yet_billed: 3 } });
    for (const [grnId, invoiceId] of [['grn-1', 'INV-1'], ['grn-2', 'INV-2']] as const) {
      const m = await call('POST', `/v1/inventory/goods-receipt/${grnId}/bill-match`, P3.MATCHER, { invoiceId });
      expect(m.status, JSON.stringify(m.body)).toBe(201);
    }
    const all = await read('?supplierId=sup-1');
    expect(all.lines.find((l) => l.grnId === 'grn-1' && l.productId === 'rice')).toMatchObject({ receivedUnitCost: { minor: 5_200 }, invoiceId: 'INV-1' });
    // Rice: grn-1 10 × (52 − 50) = +₹20.00; grn-2 4 × (49 − 50) = −₹4.00 → +₹16.00 net. Dal: on the order's price.
    expect(all.byProduct.find((p) => p.key === 'rice')).toMatchObject({ lines: 2, comparedLines: 2, varianceMinor: 1_600, contractLines: 2, contractVarianceMinor: 4_000 + 400 });
    expect(all.byProduct.find((p) => p.key === 'dal')).toMatchObject({ lines: 1, comparedLines: 1, varianceMinor: 0, contractLines: 0 });
    expect(all.byReceipt.map((r) => [r.key, r.varianceMinor])).toEqual([['grn-1', 2_000], ['grn-2', -400]]);
    expect(all.totals).toMatchObject({ lines: 3, comparedLines: 3, varianceMinor: 1_600, notCompared: { no_purchase_order: 0, order_not_held: 0, product_not_on_order: 0, currency_differs: 0, not_yet_billed: 0 } });
    const dal = all.lines.find((l) => l.productId === 'dal')!;
    expect(dal.contract).toBeUndefined(); // no contract price on file — absent, never zero
    expect(all.lines.find((l) => l.grnId === 'grn-1' && l.productId === 'rice')).toMatchObject({ order: { varianceMinor: 2_000, basis: 'purchase_order' }, contract: { agreementId: 'bpo-1', varianceMinor: 4_000 } });

    // Drill-through: the lines behind a product figure, and behind a receipt figure.
    expect((await read('?productId=rice')).lines.map((l) => l.grnId)).toEqual(['grn-1', 'grn-2']);
    expect((await read('?grnId=grn-1')).lines.map((l) => l.productId).sort()).toEqual(['dal', 'rice']);
    expect((await read('?supplierId=sup-nobody')).lines).toEqual([]);

    // Refusals: a cashier; a period that runs backwards.
    expect((await h.request({ method: 'GET', path: '/v1/purchase/price-variance', userId: P3.CASHIER, tenantId: T })).status).toBe(403);
    expect(codeOf(await h.request({ method: 'GET', path: '/v1/purchase/price-variance', userId: P3.OWNER, tenantId: T, query: { from: '2026-10-10', to: '2026-10-01' } }))).toBe('not_readable_as_a_period');

    // A reader limited to another branch sees none of these receipts, and is told how many were outside.
    await h.provisionRole(T, 'u-other', 'store_manager', ['store-2']);
    const other = await read('', 'u-other', h, 'store-2');
    expect(other.lines).toEqual([]);
    expect(other.outsideYourBranches).toBe(2);

    // A cold restart reads the same.
    expect((await read('?supplierId=sup-1', P3.OWNER, harness(h))).totals.varianceMinor).toBe(1_600);
  }, 120_000);
});
