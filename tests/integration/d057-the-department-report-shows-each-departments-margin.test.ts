import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useBackings } from '../support/backings';
import { aBranch } from '../support/a-branch';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

// D-057 (owner, 18 Nov 2026, under OB-801): head office's "What is selling, by department" shows each department's margin —
// what its lines took before GST less their goods at the AVERAGE BUYING COST (OB-39, the profitability report's cost). A
// department with a line whose product has no cost reads "Not known — 1 line had no cost": never a guessed or zero cost.
// Costs are commercial: a reader without company-wide report access sees no margin. In memory and, with DATABASE_URL, on
// real PostgreSQL.

type Report = { figures: { name: string; valueMinor?: number; notAvailableBecause?: string }[]; rows: Record<string, string>[] };

describe.each(useBackings())('D-057 — the department report shows each department\'s margin — on $name', ({ harness }) => {
  it('grocery costed: margin before GST; dairy with an uncosted line: "Not known — 1 line had no cost"', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, 'u-mgr', 'store_manager', ['store-1']);
    await aBranch(h, T, 'u-owner');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(userId === 'u-mgr' ? { branchId: 'store-1' } : {}), ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const cats = [{ categoryId: 'grocery', name: 'Grocery', parentId: null }, { categoryId: 'dairy', name: 'Dairy', parentId: null }];
    for (const [id, dept] of [['P-RICE', 'grocery'], ['P-MILK', 'dairy'], ['P-CURD', 'dairy']] as const) {
      await ok(call('POST', `/v1/catalogue/products/${id}/publish`, 'u-owner', { product: { sku: `SKU-${id}`, name: id, baseUom: 'ea', primaryCategoryId: dept, taxClass: '1006', lifecycle: 'active' }, categories: cats }), `publish ${id}`);
    }
    // Rice and milk bought at a cost; curd never bought — it has no average buying cost.
    for (const [mv, product, qty, cost] of [['mv-r', 'P-RICE', 10, 40_000], ['mv-m', 'P-MILK', 20, 3_000]] as const) {
      await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: mv, productId: product, locationId: 'store-1', kind: 'received', quantityMinor: qty, uom: 'ea', occurredAt: new Date(Date.now() - 3_600_000).toISOString(), enteredBy: 'u-owner', unitCostMinor: cost }), mv);
    }
    const today = shopDateIn(new Date().toISOString());
    const line = (productId: string, q: number, p: number) => ({ productId, quantityMinor: q, uom: 'ea', unitPriceMinor: p, lineTotalMinor: q * p, taxRateBps: 500 });
    const lines = [line('P-RICE', 1, 52_500), line('P-MILK', 2, 3_150), line('P-CURD', 1, 2_100)];
    const total = lines.reduce((t, l) => t + l.lineTotalMinor, 0);
    const saleId = `S-${randomUUID()}`;
    await ok(call('POST', '/v1/sales', 'u-till', { saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', locationId: 'store-1', cashierId: 'u-till', tradingDay: today, committedAt: new Date().toISOString(), totalMinor: total, currency: 'INR', packVersion: 1, lines, tenders: [{ kind: 'cash', amountMinor: total }] }), 'sale');

    const rep = (await ok(call('GET', '/v1/reports/units_by_category', 'u-owner'), 'report')).body as Report;
    const fig = (name: string) => rep.figures.find((f) => f.name === name);
    // Rice: ₹525.00 with 5% GST in it → ₹500.00 before GST, less ₹400.00 cost = ₹100.00.
    expect(fig('grocery — margin')?.valueMinor).toBe(10_000);
    expect(fig('dairy — margin')?.valueMinor).toBeUndefined();
    expect(fig('dairy — margin')?.notAvailableBecause).toBe('Not known — 1 line had no cost');
    expect(rep.rows.find((r) => r['department'] === 'grocery')).toMatchObject({ takenMinor: '52500', marginMinor: '10000', marginPercent: '20.0%' });
    expect(rep.rows.find((r) => r['department'] === 'dairy')).toMatchObject({ marginMinor: 'Not known — 1 line had no cost', marginPercent: '' });

    // A store manager (one store's reports) sees what sold, but no margin — costs are company-wide, as profit is.
    const mine = await call('GET', '/v1/reports/units_by_category', 'u-mgr');
    if (mine.status === 200) {
      const body = mine.body as Report;
      expect(body.figures.some((f) => f.name.endsWith(' — margin'))).toBe(false);
      expect(body.rows.every((r) => r['marginMinor'] === undefined)).toBe(true);
    }
  });
});
