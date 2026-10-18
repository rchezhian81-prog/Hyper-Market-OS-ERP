import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';

/**
 * D-16 (R3, OB-189) — on the real API, in memory and on PostgreSQL, with a cold restart:
 * "A product marked discontinued or clearance can't be put on a purchase order or reordered automatically, even if the
 * store's range doesn't say so. A clearance product produces price-cut suggestions that a person must approve; nothing is
 * cut automatically."
 */
const backings = r3OpsBackings();
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const cost = { minor: 2_000, currency: 'INR' };
const AS_OF = '2030-06-10';

describe.each(backings)('D-16 lifecycle stops ordering and drives clearance suggestions — on $name', ({ harness, restart }) => {
  it('discontinued / clearance refused on an order and kept out of replenishment with no range or a listing; clearance gets suggestions, no price moves', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-buyer', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    await approvedSuppliers(h, T, 'sup-1');
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' }), 'store A');
    await ok(req('POST', '/v1/org/nodes/S-B', { kind: 'branch', name: 'Store B', parentId: 'C1', companyId: 'C1' }), 'store B');
    await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    for (const [id, lifecycle] of [['p-live', 'active'], ['p-old', 'discontinued'], ['p-clr', 'clearance']] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name: `Product ${id}`, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle }, categories: [GROCERY] }), `publish ${id}`);
    }
    // Store B LISTS all three in its range; store A has no range recorded at all.
    for (const p of ['p-live', 'p-old', 'p-clr']) await ok(req('POST', `/v1/merchandising/assortment/S-B/${p}/list`, { effectiveFrom: '2026-01-01' }, 'u-buyer'), `list ${p}`);
    const order = (poId: string, store: string, productId: string) => req('POST', `/v1/purchase/orders/${poId}`, { supplierId: 'sup-1', deliverToLocationId: store, lines: [{ productId, orderedQty: 5, unitCost: cost }] }, 'u-buyer');

    h = restart(h); // ── COLD RESTART: the master and the range are rebuilt from the store ──────────────────────────────

    expect((await order('po-live-a', 'S-A', 'p-live')).status).toBe(201);
    for (const store of ['S-A', 'S-B']) {
      for (const p of ['p-old', 'p-clr']) {
        const r = await order(`po-${p}-${store}`, store, p);
        expect(r.status, `${p} at ${store}`).toBe(422);
        expect(code(r), `${p} at ${store}`).toBe('product_lifecycle_stops_ordering');
      }
    }
    // Replenishment never proposes them, at a store with no range or with them listed — and says which and why.
    for (const store of ['S-A', 'S-B']) {
      const prop = (await ok(req('POST', '/v1/replenishment/propose', { items: ['p-live', 'p-old', 'p-clr'].map((productId) => ({ productId, maxLevel: 20, reorderPoint: 5, avgDailyDemand: 1 })) }, 'u-buyer', { storeId: store }), `propose ${store}`)).body as {
        proposals: { productId: string }[]; stoppedByLifecycle: { productId: string; lifecycle: string }[];
      };
      expect(prop.proposals.map((p) => p.productId)).toEqual(['p-live']);
      expect(prop.stoppedByLifecycle).toEqual([{ productId: 'p-old', lifecycle: 'discontinued' }, { productId: 'p-clr', lifecycle: 'clearance' }]);
    }

    // ── Clearance: suggestions from the D-4 ladder, a person must commit; nothing is cut ─────────────────────────
    await ok(req('POST', '/v1/prices/list/p-clr/entries/e1', { scope: 'store', scopeRef: 'S-A', priceMinor: 10_000, mrpMinor: 12_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), 'price');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-clr-1', productId: 'p-clr', locationId: 'S-A', kind: 'received', quantityMinor: 30, uom: 'ea', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'B-1', expiry: '2030-06-12', unitCostMinor: 4_000 }), 'receive dated');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-clr-2', productId: 'p-clr', locationId: 'S-A', kind: 'received', quantityMinor: 4, uom: 'ea', occurredAt: '2030-05-01T00:00:00.000Z', enteredBy: 'u-owner', batchId: 'B-2', unitCostMinor: 4_000 }), 'receive undated');
    expect((await req('GET', '/v1/pricing/clearance-markdowns', undefined, 'u-till', { storeId: 'S-A', asOf: AS_OF })).status).toBe(403);
    const sug = (await ok(req('GET', '/v1/pricing/clearance-markdowns', undefined, 'u-buyer', { storeId: 'S-A', asOf: AS_OF }), 'suggestions')).body as {
      suggestions: { productId: string; batchId: string; reason: string; markdownBps: number; newPriceMinor: number; advisoryOnly: boolean; source: string }[];
      notJudged: { batchId: string; because: string }[]; pricesChanged: boolean; advisoryOnly: boolean;
    };
    expect(sug.advisoryOnly).toBe(true);
    expect(sug.pricesChanged).toBe(false);
    // 30 on hand, nothing sold, 2 days to the sell-by → 25% off on the default ladder, 10,000 → 7,500 (a person approves).
    expect(sug.suggestions).toEqual([expect.objectContaining({ productId: 'p-clr', batchId: 'B-1', reason: 'marked_down', markdownBps: 2500, newPriceMinor: 7_500, advisoryOnly: true, source: 'product_master' })]);
    expect(sug.notJudged).toEqual([expect.objectContaining({ batchId: 'B-2', because: 'no_sell_by_date_known' })]);
    // The shelf price is exactly what it was.
    const price = (await req('GET', '/v1/prices/list/p-clr/resolve', undefined, 'u-owner', { storeId: 'S-A', at: `${AS_OF}T12:00:00.000Z` })).body as Record<string, unknown>;
    expect(JSON.stringify(price)).toContain('10000');
    expect(JSON.stringify(price)).not.toContain('7500');
  }, 60_000);
});
