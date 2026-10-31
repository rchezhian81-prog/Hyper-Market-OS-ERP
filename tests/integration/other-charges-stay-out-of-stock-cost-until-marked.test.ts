import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';

// OB-556 (owner, 30 Oct 2026 — answer B to the M07-FR-04 re-audit question): a bill's OTHER charges whose kind is not known
// (an e-invoice's OthChrg, a typed bill's "other charges") count in the bill's total — it adds up, matches and is paid with
// them — but stay OUT of the stock's cost until a person who may match bills (never the receiver, §28) marks what they are:
// freight/cost (then spread into stock cost like freight) or a tax the supplier charged (never in stock cost). Freight and duty typed
// as such go into stock cost exactly as before. The marking is append-only, once per bill; when the bill is already matched
// the stock-cost difference is posted at once as compensating entries. Until marked, the bill and its match say plainly
// that ₹X is not yet in stock cost. On the in-memory store and — with DATABASE_URL — on real PostgreSQL, with a restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const LINES = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }];

describe.each(backings)('other charges of unknown kind stay out of stock cost until marked (OB-556) — on $name', ({ harness }) => {
  it('freight goes into stock cost as before; other charges do not until marked cost; a second, different marking is refused', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const value = async (hh = h) => ((await hh.request({ method: 'GET', path: '/v1/inventory/valuation', userId: P3.OWNER, tenantId: T })).body as { totalValueMinor: number }).totalValueMinor;
    await issuedOrder(call, 'po-1', LINES);
    await received(call, 'grn-1', 'po-1', LINES);
    expect(await value()).toBe(50_000);

    // ₹500 goods + ₹45.50 freight + ₹10 other charges: adds up, matches clean, all of it payable.
    const m = await capturedAndMatched(call, 'inv-1', 'po-1', LINES, { freightMinor: 4_550, otherMinor: 1_000 });
    expect(m.body).toMatchObject({ blocked: false, payableMinor: 55_550, landedCharges: { freightMinor: 4_550, otherMinor: 1_000, totalMinor: 5_550 } });
    // Only the freight reaches stock cost; the other charges are said, not hidden.
    expect(await value()).toBe(54_550);
    expect(m.body).toMatchObject({ otherCharges: { otherMinor: 1_000, kind: 'not_marked', inStockCost: false } });
    expect((m.body as { otherCharges: { said: string } }).otherCharges.said).toMatch(/NOT in stock cost until a person marks them/);
    const read = async (hh = h) => (await hh.request({ method: 'GET', path: '/v1/purchase/invoices/inv-1', userId: P3.OWNER, tenantId: T })).body as { otherCharges?: { kind: string; inStockCost: boolean } };
    expect((await read()).otherCharges).toMatchObject({ kind: 'not_marked', inStockCost: false });

    // Who may mark: not a cashier; not the person who received the goods (§28); a reason is needed.
    expect((await call('POST', '/v1/purchase/invoices/inv-1/other-charges', P3.CASHIER, { kind: 'cost', reason: 'freight' })).status).toBe(403);
    expect(codeOf(await call('POST', '/v1/purchase/invoices/inv-1/other-charges', P3.RECEIVER, { kind: 'cost', reason: 'it is packing' }))).toBe('segregation_of_duties');
    expect(codeOf(await call('POST', '/v1/purchase/invoices/inv-1/other-charges', P3.MATCHER, { kind: 'cost', reason: ' ' }))).toBe('not_readable_as_an_other_charges_marking');
    expect(codeOf(await call('POST', '/v1/purchase/invoices/inv-404/other-charges', P3.MATCHER, { kind: 'cost', reason: 'x' }))).toBe('invoice_unknown');
    expect(await value()).toBe(54_550);

    // The matcher marks them freight/cost: the bill was already matched, so the ₹10 lands in stock cost now (append-only).
    const marked = await call('POST', '/v1/purchase/invoices/inv-1/other-charges', P3.MATCHER, { kind: 'cost', reason: 'the supplier confirmed it is loading charges' });
    expect(marked.status).toBe(201);
    expect(marked.body).toMatchObject({ marking: { kind: 'cost', otherMinor: 1_000, markedBy: P3.MATCHER }, otherCharges: { kind: 'cost', inStockCost: true } });
    expect((marked.body as { landedCost: { posted: { valueMinor: number }[] } }).landedCost.posted.map((p) => p.valueMinor)).toEqual([1_000]);
    expect(await value()).toBe(55_550);
    // The same marking again is no change; a different one is refused by name — never overwritten.
    expect((await call('POST', '/v1/purchase/invoices/inv-1/other-charges', P3.MATCHER, { kind: 'cost', reason: 'again' })).body).toMatchObject({ alreadyMarked: true });
    expect(codeOf(await call('POST', '/v1/purchase/invoices/inv-1/other-charges', P3.MATCHER, { kind: 'tax', reason: 'changed my mind' }))).toBe('other_charges_already_marked');
    // A re-match posts nothing more; a restart reads the same.
    const again = await call('POST', '/v1/purchase/invoices/inv-1/match', P3.MATCHER, {}, 'rematch');
    expect((again.body as { landedCost: { posted: unknown[] } }).landedCost.posted).toEqual([]);
    const cold = harness(h);
    expect(await value(cold)).toBe(55_550);
    expect((await read(cold)).otherCharges).toMatchObject({ kind: 'cost', inStockCost: true });
  }, 120_000);

  it('other charges marked as a tax never reach stock cost — marked before the match, the match posts only the freight', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const value = async () => ((await call('GET', '/v1/inventory/valuation', P3.OWNER)).body as { totalValueMinor: number }).totalValueMinor;
    await issuedOrder(call, 'po-2', LINES);
    await received(call, 'grn-2', 'po-2', LINES);
    // Captured, not yet matched: marked tax first.
    await call('POST', '/v1/purchase/invoices/inv-2/capture', P3.BUYER, { supplierId: 'sup-1', poId: 'po-2', declaredTotalMinor: 50_000 + 2_000 + 50, lines: LINES.map((l) => ({ productId: l.productId, quantity: l.qty, unitPriceMinor: l.unitMinor, lineTotalMinor: l.qty * l.unitMinor })), charges: { freightMinor: 2_000, otherMinor: 50 } });
    const tax = await call('POST', '/v1/purchase/invoices/inv-2/other-charges', P3.MATCHER, { kind: 'tax', reason: 'the supplier says it is a tax it collected' });
    expect(tax.body).toMatchObject({ marking: { kind: 'tax' }, otherCharges: { kind: 'tax', inStockCost: false } });
    expect(tax.body).not.toHaveProperty('landedCost');
    const m = await call('POST', '/v1/purchase/invoices/inv-2/match', P3.MATCHER, {}, 'm2');
    expect(m.body).toMatchObject({ blocked: false, payableMinor: 52_050, otherCharges: { kind: 'tax' } });
    expect(await value()).toBe(52_000);
    // A bill with no other charges has nothing to mark.
    await capturedAndMatched(call, 'inv-3', 'po-2', [{ productId: 'rice', qty: 0 + 1, unitMinor: 5_000 }]).catch(() => undefined);
    expect(codeOf(await call('POST', '/v1/purchase/invoices/inv-3/other-charges', P3.MATCHER, { kind: 'cost', reason: 'x' }))).toBe('no_other_charges');
  }, 120_000);
});
