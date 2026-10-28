import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, type Call } from '../support/p3-purchase';
import type { ApiHarness } from '../support/api-harness';

/**
 * **G3 · OB-509 · OB-517 (owner, 28 Oct 2026) — matching the supplier's bill to a delivery whose cost is not known, from the office.**
 *
 *   • `GET /v1/inventory/receipts-cost-not-known` lists the receipts still waiting for their bill — gated like the match
 *     (`purchase.invoice.match`), only the caller's branches — each with the bills on head office's register that could be
 *     matched (the same order, or with no order a bill with none, naming a waiting product), and whether the reader booked it in;
 *   • every unit that reaches stock from a cost-not-known line ends up valued at the matched bill's cost, ONCE, whichever comes
 *     first: held / quarantined units released BEFORE the match are valued by the match; units released AFTER it come in at
 *     the bill's cost on their own movement. Before this fix only the sellable units were valued and later releases stayed
 *     unvalued forever.
 * On the in-memory store and — with DATABASE_URL — on real PostgreSQL, with a cold restart. Synthetic data only.
 */

const backings = useRestartableBackings();
const inr = (minor: number) => ({ minor, currency: 'INR' });
const code = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

interface Waiting {
  grnId: string; poId: string | null; receivedByYou: boolean;
  waiting: { lineId: string; productId: string; because: string; inStockMinor: number }[];
  bills: { invoiceId: string; prices: { productId: string; unitPriceMinor: number }[] }[];
}

/** A no-order delivery: 12 of `a` counted against 10 (2 HELD as excess at 0% tolerance) and 5 of `b` damaged (quarantined). */
const delivery = (call: Call, grnId: string, a: string, b: string) => call('POST', `/v1/inventory/goods-receipt/${grnId}`, P3.RECEIVER, {
  warehouseId: P3.BACK, receivedOnDate: '2026-10-20', currency: 'INR',
  lines: [
    { lineId: 'L1', productId: a, orderedMinor: 10, countedMinor: 12, uom: 'each', unitCost: inr(9_999), condition: 'good' },
    { lineId: 'L2', productId: b, orderedMinor: 5, countedMinor: 5, uom: 'each', unitCost: inr(9_999), condition: 'damaged' },
  ],
});
/** The supplier's bill (no order) as the paper says: ₹42.00 for `a`, ₹30.00 for `b`, captured by the buyer. */
const bill = (call: Call, invoiceId: string, a: string, b: string) => call('POST', `/v1/purchase/invoices/${invoiceId}/capture`, P3.BUYER, {
  supplierId: 'sup-1', poId: null, declaredTotalMinor: 12 * 4_200 + 5 * 3_000,
  lines: [{ productId: a, quantity: 12, unitPriceMinor: 4_200, lineTotalMinor: 12 * 4_200 }, { productId: b, quantity: 5, unitPriceMinor: 3_000, lineTotalMinor: 5 * 3_000 }],
});
const releaseBoth = async (call: Call, grnId: string) => {
  const ex = await call('POST', `/v1/inventory/goods-receipt/${grnId}/excess/decide`, P3.OWNER, { decision: 'approved', reason: 'keep the extra two' });
  expect(ex.status, JSON.stringify(ex.body)).toBe(200);
  const acc = await call('POST', `/v1/inventory/goods-receipt/${grnId}/lines/L2/disposition`, P3.OWNER, { disposition: 'accept', reason: 'only the outer box was dented' });
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
};

describe.each(backings)('G3 — the bill is matched from the office and values every released unit — on $name', ({ harness }) => {
  it('the waiting list (permission, branch, bills, "you booked it in"), then both orders of release and match land on the bill\'s value, once', async () => {
    let h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    await h.provisionRole(T, 'u-sm-other', 'store_manager', ['store-2']); // holds the match right, but for ANOTHER store
    const call = caller(h, T);
    expect((await call('POST', '/v1/inventory/receipt-policy', P3.OWNER, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 })).status).toBe(201);
    const valuation = async (hh: ApiHarness, productId: string) => {
      const rows = ((await hh.request({ method: 'GET', path: '/v1/inventory/valuation', userId: P3.OWNER, tenantId: T, query: { productId } })).body as { rows: { locationId: string; onHandMinor: number; value: { minor: number }; unvaluedMinor: number }[] }).rows;
      return rows.filter((r) => r.locationId === P3.BACK).map((r) => ({ onHand: r.onHandMinor, value: r.value.minor, unvalued: r.unvaluedMinor }));
    };
    const waitingList = async (hh: ApiHarness, userId: string, branchId?: string) => hh.request({ method: 'GET', path: '/v1/inventory/receipts-cost-not-known', userId, tenantId: T, ...(branchId === undefined ? {} : { branchId }) });

    // Delivery A is released BEFORE its bill is matched; delivery B AFTER.
    expect((await delivery(call, 'g-a', 'p-a1', 'p-a2')).status).toBe(201);
    expect((await delivery(call, 'g-b', 'p-b1', 'p-b2')).status).toBe(201);
    expect((await bill(call, 'INV-A', 'p-a1', 'p-a2')).status).toBe(201);
    expect((await bill(call, 'INV-B', 'p-b1', 'p-b2')).status).toBe(201);

    // ── The waiting list ─────────────────────────────────────────────────────────────────────────────────────────────
    expect((await waitingList(h, P3.CASHIER)).status).toBe(403);
    const list = await waitingList(h, P3.MATCHER);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const rows = (list.body as { receipts: Waiting[]; count: number; billsReadable: boolean }).receipts;
    expect((list.body as { billsReadable: boolean }).billsReadable).toBe(true);
    expect(rows.map((r) => r.grnId).sort()).toEqual(['g-a', 'g-b']);
    const a = rows.find((r) => r.grnId === 'g-a')!;
    expect(a).toMatchObject({ poId: null, receivedByYou: false });
    expect(a.waiting.map((w) => [w.lineId, w.because, w.inStockMinor])).toEqual([['L1', 'no_issued_order', 10], ['L2', 'no_issued_order', 0]]);
    expect(a.bills.map((b) => b.invoiceId)).toEqual(['INV-A']); // INV-B names none of A's goods
    expect(a.bills[0]!.prices).toEqual([{ productId: 'p-a1', unitPriceMinor: 4_200 }, { productId: 'p-a2', unitPriceMinor: 3_000 }]);
    // The receiver is told the delivery is theirs (head office refuses them the match, §28).
    expect(((await waitingList(h, P3.RECEIVER)).body as { receipts: Waiting[] }).receipts.every((r) => r.receivedByYou)).toBe(true);
    // A manager of another store sees none of this store's receipts.
    const other = await waitingList(h, 'u-sm-other', 'store-2');
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect((other.body as { count: number }).count).toBe(0);

    // ── A: released first (unvalued — never ₹0), then the bill matched: the match values all 12 + 5, once ───────────────
    await releaseBoth(call, 'g-a');
    expect(await valuation(h, 'p-a1')).toEqual([{ onHand: 12, value: 0, unvalued: 12 }]);
    expect(await valuation(h, 'p-a2')).toEqual([{ onHand: 5, value: 0, unvalued: 5 }]);
    expect(code(await call('POST', '/v1/inventory/goods-receipt/g-a/bill-match', P3.RECEIVER, { invoiceId: 'INV-A' }))).toBe('self_match');
    const ma = await call('POST', '/v1/inventory/goods-receipt/g-a/bill-match', P3.MATCHER, { invoiceId: 'INV-A' });
    expect(ma.status, JSON.stringify(ma.body)).toBe(201);
    expect((ma.body as { matched: { lineId: string; quantityMinor: number; valueMinor: number }[] }).matched.map((m) => [m.lineId, m.quantityMinor, m.valueMinor])).toEqual([['L1', 12, 50_400], ['L2', 5, 15_000]]);
    expect(await valuation(h, 'p-a1')).toEqual([{ onHand: 12, value: 50_400, unvalued: 0 }]);
    expect(await valuation(h, 'p-a2')).toEqual([{ onHand: 5, value: 15_000, unvalued: 0 }]);

    // ── B: the bill matched first (10 sellable valued), then released: each release carries the bill's cost ───────────────
    const mb = await call('POST', '/v1/inventory/goods-receipt/g-b/bill-match', P3.MATCHER, { invoiceId: 'INV-B' });
    expect(mb.status, JSON.stringify(mb.body)).toBe(201);
    expect(await valuation(h, 'p-b1')).toEqual([{ onHand: 10, value: 42_000, unvalued: 0 }]);
    await releaseBoth(call, 'g-b');
    expect(await valuation(h, 'p-b1')).toEqual([{ onHand: 12, value: 50_400, unvalued: 0 }]);
    expect(await valuation(h, 'p-b2')).toEqual([{ onHand: 5, value: 15_000, unvalued: 0 }]);
    // Asked again, the match is "already matched" and nothing is valued twice.
    expect(code(await call('POST', '/v1/inventory/goods-receipt/g-b/bill-match', P3.MATCHER, { invoiceId: 'INV-B' }))).toBeUndefined();
    expect(await valuation(h, 'p-b1')).toEqual([{ onHand: 12, value: 50_400, unvalued: 0 }]);
    // Nothing is waiting any more.
    expect(((await waitingList(h, P3.MATCHER)).body as { count: number }).count).toBe(0);

    // ── A cold restart reads the same: every unit valued at its bill, the releases recorded with it ───────────────────────
    h = harness(h);
    for (const p of ['p-a1', 'p-b1']) expect(await valuation(h, p)).toEqual([{ onHand: 12, value: 50_400, unvalued: 0 }]);
    for (const p of ['p-a2', 'p-b2']) expect(await valuation(h, p)).toEqual([{ onHand: 5, value: 15_000, unvalued: 0 }]);
    const gb = (await h.request({ method: 'GET', path: '/v1/inventory/goods-receipt/g-b', userId: P3.OWNER, tenantId: T })).body as { grn: { excessDecision: { valuedAtBill?: unknown[] }; dispositions: { valuedAtBill?: unknown; valueMinor: number; valueNotKnown?: boolean }[] }; costNotKnown: unknown[] };
    expect(gb.grn.excessDecision.valuedAtBill).toEqual([expect.objectContaining({ lineId: 'L1', invoiceId: 'INV-B', quantityMinor: 2, valueMinor: 8_400 })]);
    expect(gb.grn.dispositions[0]).toMatchObject({ valueMinor: 15_000, valuedAtBill: { invoiceId: 'INV-B', quantityMinor: 5 } });
    expect(gb.grn.dispositions[0]!.valueNotKnown).toBeUndefined();
    expect(gb.costNotKnown).toEqual([]);
    expect(((await waitingList(h, P3.MATCHER)).body as { count: number }).count).toBe(0);
  }, 120_000);
});
