import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received, capturedAndMatched } from '../support/p3-purchase';

// M07-FR-04 acceptance "landed cost reflects freight" · D03-FR-05 (OB-288 P3): the freight and duty on a supplier's bill are
// stored on the captured invoice; when the bill is matched (and may be paid) they are apportioned to the paisa — across the
// products by the value paid for, then across the places each was received at — and posted as value-only cost adjustments.
// Weighted-average stock value and COGS then include them; a re-match posts only the difference (compensating, append-only).
// On the in-memory store and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
type Row = { productId: string; locationId: string; onHandMinor: number; value: { minor: number }; cogs: { minor: number }; unitCostMinor: number | 'not_known' };
const LINES = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }, { productId: 'dal', qty: 3, unitMinor: 3_333 }]; // goods ₹599.99

describe.each(backings)('landed cost into stock value (M07-FR-04) — on $name', ({ harness }) => {
  it('stock value after a freight-bearing bill = goods + apportioned freight, to the paisa; COGS carries its share; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const valuation = async (hh = h) => ((await hh.request({ method: 'GET', path: '/v1/inventory/valuation', userId: P3.OWNER, tenantId: T })).body as { rows: Row[]; totalValueMinor: number });
    await issuedOrder(call, 'po-1', LINES);
    await received(call, 'grn-1', 'po-1', LINES);
    expect((await valuation()).totalValueMinor).toBe(59_999);

    // The bill: the goods plus ₹10.01 freight. A declared total that leaves the freight out does not add up; a charge that is
    // not whole paise is refused.
    const lines = LINES.map((l) => ({ productId: l.productId, quantity: l.qty, unitPriceMinor: l.unitMinor, lineTotalMinor: l.qty * l.unitMinor }));
    expect(codeOf(await call('POST', '/v1/purchase/invoices/inv-x/capture', P3.BUYER, { supplierId: 'sup-1', poId: 'po-1', declaredTotalMinor: 59_999, lines, charges: { freightMinor: 1_001 } }))).toBe('does_not_add_up_to_the_invoice_total');
    expect(codeOf(await call('POST', '/v1/purchase/invoices/inv-y/capture', P3.BUYER, { supplierId: 'sup-1', poId: 'po-1', declaredTotalMinor: 61_000, lines, charges: { freightMinor: 10.01 } }))).toBe('not_readable_as_a_supplier_invoice');

    // Four rice are sold BEFORE the bill is matched: their share of the freight is cost of goods sold, not stock.
    expect((await call('POST', '/v1/inventory/movements', P3.RECEIVER, { movementId: 'sale-1', productId: 'rice', locationId: P3.BACK, kind: 'sold', quantityMinor: 4, uom: 'ea', occurredAt: new Date().toISOString(), enteredBy: P3.RECEIVER })).status).toBeLessThan(300);
    const before = await valuation();
    const riceBefore = before.rows.find((r) => r.productId === 'rice')!;
    expect(riceBefore).toMatchObject({ onHandMinor: 6, value: { minor: 30_000 }, cogs: { minor: 20_000 } });

    const m = await capturedAndMatched(call, 'inv-1', 'po-1', LINES, { freightMinor: 1_001 });
    expect(m.body).toMatchObject({ blocked: false, invoicedMinor: 61_000, payableMinor: 61_000, landedCharges: { freightMinor: 1_001, dutyMinor: 0, otherMinor: 0, totalMinor: 1_001 } });
    // Apportioned by value paid for, no remainder dropped: rice 50 000 / 59 999 of 1 001 = 834; dal = 167.
    const landed = (m.body as { landedCost: { posted: { productId: string; locationId: string; valueMinor: number }[] } }).landedCost;
    expect(landed.posted.map((p) => [p.productId, p.locationId, p.valueMinor]).sort()).toEqual([['dal', P3.BACK, 167], ['rice', P3.BACK, 834]]);

    const after = await valuation();
    const rice = after.rows.find((r) => r.productId === 'rice')!;
    const dal = after.rows.find((r) => r.productId === 'dal')!;
    // Rice: 6 of the 10 units are still on hand — they carry 6/10 of 834 (500.4 → 500); the sold 4 took 334 into COGS.
    expect(rice.value.minor - riceBefore.value.minor + rice.cogs.minor - riceBefore.cogs.minor).toBe(834);
    expect(rice).toMatchObject({ value: { minor: 30_500 }, cogs: { minor: 20_334 }, onHandMinor: 6 });
    expect(dal).toMatchObject({ value: { minor: 9_999 + 167 }, onHandMinor: 3 });
    // Stock + COGS = goods + freight, to the paisa.
    expect(after.totalValueMinor + rice.cogs.minor).toBe(59_999 + 1_001);

    // A re-match of the same bill posts nothing more (the standing apportionment already holds).
    const again = await call('POST', '/v1/purchase/invoices/inv-1/match', P3.MATCHER, {}, 'rematch');
    expect((again.body as { landedCost: { posted: unknown[] } }).landedCost.posted).toEqual([]);

    // A cold restart reads the same value.
    expect((await valuation(harness(h))).totalValueMinor).toBe(after.totalValueMinor);
  }, 120_000);

  it('a bill blocked at the match carries no landed cost into stock (it is withheld with the bill); once it matches clean, it does', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    const value = async () => ((await call('GET', '/v1/inventory/valuation', P3.OWNER)).body as { totalValueMinor: number }).totalValueMinor;
    await issuedOrder(call, 'po-2', [{ productId: 'rice', qty: 10, unitMinor: 5_000 }]);
    await received(call, 'grn-2a', 'po-2', [{ productId: 'rice', qty: 4, unitMinor: 5_000 }]);
    // Invoiced 10 but only 4 arrived: the match is blocked, nothing posts.
    const blocked = await capturedAndMatched(call, 'inv-2', 'po-2', [{ productId: 'rice', qty: 10, unitMinor: 5_000 }], { dutyMinor: 2_000 });
    expect(blocked.body).toMatchObject({ blocked: true, landedCharges: { totalMinor: 2_000 } });
    expect((blocked.body as { withheldMinor: number }).withheldMinor).toBe(30_000 + 2_000);
    expect(await value()).toBe(20_000);
    // The rest arrives; matched clean → the duty lands on the 10 received (over two receipts, at the same place).
    await received(call, 'grn-2b', 'po-2', [{ productId: 'rice', qty: 6, unitMinor: 5_000 }]);
    const clean = await call('POST', '/v1/purchase/invoices/inv-2/match', P3.MATCHER, {}, 'm2');
    expect(clean.body).toMatchObject({ blocked: false, payableMinor: 52_000 });
    expect(await value()).toBe(52_000);
  }, 120_000);
});
