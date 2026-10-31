import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received } from '../support/p3-purchase';
import { makeEvent } from '../../packages/contracts/src/event';
import { STOCK_COST_ADJUSTMENTS_STREAM, stockCostAdjustments } from '../../services/api/src/adapters';

// OB-556 follow-up (Round 1, from #851): a bill matched BEFORE OB-556 already carried its other charges in stock cost — the
// old landed-cost posting spread the bill's WHOLE charges (freight + other) into the goods' cost. After OB-556 those other
// charges stay out of stock cost until a person marks them. This proves what a re-match of such a bill does: it takes the
// other charges back out as a SEPARATE, compensating entry (hard rule 2) — the old entry is never overwritten or removed —
// and stock value lands on goods + freight. The pre-OB-556 posting is written exactly as the old code wrote it (same event
// type, stream and id shape, the full charges), since no code path writes it any more. In memory and on PostgreSQL, with a
// restart.

const backings = useRestartableBackings();
const LINES = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];

describe.each(backings)('a bill matched before OB-556: the re-match takes its other charges back out of stock cost — on $name', ({ harness }) => {
  it('posts a separate compensating entry of minus the other charges; the old entry stands untouched; value = goods + freight', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const value = async (hh = h) => ((await hh.request({ method: 'GET', path: '/v1/inventory/valuation', userId: P3.OWNER, tenantId: T })).body as { totalValueMinor: number }).totalValueMinor;
    await issuedOrder(call, 'po-1', LINES);
    await received(call, 'grn-1', 'po-1', LINES);
    // ₹500 goods + ₹45.50 freight + ₹10 other charges of unknown kind, captured as the paper says it.
    const cap = await call('POST', '/v1/purchase/invoices/inv-old/capture', P3.BUYER, {
      supplierId: 'sup-1', poId: 'po-1', declaredTotalMinor: 50_000 + 4_550 + 1_000,
      lines: LINES.map((l) => ({ productId: l.productId, quantity: l.qty, unitPriceMinor: l.unitMinor, lineTotalMinor: l.qty * l.unitMinor })),
      charges: { freightMinor: 4_550, otherMinor: 1_000 },
    });
    expect(cap.status).toBeLessThan(300);

    // What the pre-OB-556 match posted: the WHOLE ₹55.50 of charges into the rice's cost at the back store. (Dated after the
    // goods arrived, as a real match is — the valuation folds the ledger in time order.)
    const OLD_MATCHED_AT = new Date().toISOString();
    const oldId = `landed:inv-old:${OLD_MATCHED_AT}:rice:${P3.BACK}`;
    await h.store.appendBatch(T, [{ stream: STOCK_COST_ADJUSTMENTS_STREAM, event: makeEvent({
      id: oldId, type: 'StockCostAdjusted', occurredAt: OLD_MATCHED_AT, idempotencyKey: `stock-cost-${T}-${oldId}`, source: 'api/purchase',
      payload: { adjustmentId: oldId, invoiceId: 'inv-old', poId: 'po-1', productId: 'rice', locationId: P3.BACK, quantityMinor: 10, valueMinor: 5_550, occurredAt: OLD_MATCHED_AT, postedBy: P3.MATCHER, matchedAt: OLD_MATCHED_AT },
    }) }]);
    expect(await value()).toBe(55_550);

    // The re-match under OB-556.
    const again = await call('POST', '/v1/purchase/invoices/inv-old/match', P3.MATCHER, {}, 'rematch-after-ob556');
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ blocked: false, payableMinor: 55_550, otherCharges: { otherMinor: 1_000, kind: 'not_marked', inStockCost: false } });
    // Exactly one new entry: minus the ₹10 other charges, for the same goods and place.
    const posted = (again.body as { landedCost: { posted: { productId: string; locationId: string; quantityMinor: number; valueMinor: number }[] } }).landedCost.posted;
    expect(posted).toEqual([{ productId: 'rice', locationId: P3.BACK, quantityMinor: 10, valueMinor: -1_000 }]);
    expect(await value()).toBe(55_550 - 1_000);

    // Append-only: the old ₹55.50 entry is still there, unchanged, and the take-back is its OWN entry under its own id.
    const entries = (await stockCostAdjustments(h.store, T)).filter((x) => x.invoiceId === 'inv-old');
    expect(entries).toHaveLength(2);
    expect(entries.find((x) => x.adjustmentId === oldId)).toMatchObject({ valueMinor: 5_550, quantityMinor: 10 });
    const takeBack = entries.find((x) => x.adjustmentId !== oldId)!;
    expect(takeBack).toMatchObject({ valueMinor: -1_000, productId: 'rice', locationId: P3.BACK, postedBy: P3.MATCHER });
    expect(takeBack.adjustmentId).toMatch(/^landed:inv-old:.+:stock4550:rice:/);
    expect(entries.reduce((s, x) => s + x.valueMinor, 0)).toBe(4_550);

    // A second re-match posts nothing more; a restart reads the same.
    expect(((await call('POST', '/v1/purchase/invoices/inv-old/match', P3.MATCHER, {}, 'rematch-twice')).body as { landedCost: { posted: unknown[] } }).landedCost.posted).toEqual([]);
    const cold = harness(h);
    expect(await value(cold)).toBe(54_550);

    // Marked cost afterwards (OB-556), the ₹10 goes back into stock cost — again as its own entry, nothing overwritten.
    const marked = await call('POST', '/v1/purchase/invoices/inv-old/other-charges', P3.MATCHER, { kind: 'cost', reason: 'the supplier confirmed it is loading charges' });
    expect(marked.status).toBe(201);
    expect(await value()).toBe(55_550);
    const after = (await stockCostAdjustments(h.store, T)).filter((x) => x.invoiceId === 'inv-old');
    expect(after).toHaveLength(3);
    expect(after.map((x) => x.valueMinor).sort((a, b) => a - b)).toEqual([-1_000, 1_000, 5_550]);
  }, 120_000);
});
