import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { ownerApprovedSetting } from '../support/owner-approved-setting';
import { pinTheEveningClock } from '../support/evening-clock';
import { deliveryPlaces } from '../support/approved-supplier';

/**
 * **Round 16 (R16-A · P2 · M01-FR-02 · P-08): head office's "today" for the plan in force and for a published price pack is
 * the SHOP's date, in the tenant's own calendar (`locale.time_zone`) — never the UTC date of the moment.**
 *
 * The clock is pinned to an evening UTC moment (tests/support/evening-clock.ts): 01:00 the next morning in the shop. Before
 * round 16:
 *   • the plan in force (`inForcePlanogram`, planograms.ts) sliced the UTC date, so a planogram effective on the shop's today
 *     was "coming" until 05:30 — on the store's plan listing, the bay score and the store pack the box is given;
 *   • the price pack (`assembleCatalogueSnapshot`, catalogue-preview.ts) took its MRP, tax and tobacco-warning date from the
 *     UTC date, so an MRP starting on the shop's today missed a pack published from 00:00 to 05:30.
 * Everything is stored, head office restarts cold, and the answers hold; then the tenant's zone is changed (owner-approved)
 * to one still on the UTC date, and both follow it. In memory and on real PostgreSQL. Synthetic data only.
 */

const backings = r3OpsBackings();
const evening = pinTheEveningClock();
afterAll(() => { vi.useRealTimers(); });

const STORE = 'store-1';
const LOCS = [
  { locationId: 'A1-R1-B1-S1-P1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1, zone: 'ambient' },
  { locationId: 'A1-R1-B1-S1-P2', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 2, zone: 'ambient' },
];
const ASSIGN = [{ productId: 'P-RICE', locationId: 'A1-R1-B1-S1-P1', capacityMinor: 40, primary: true }];
const inr = (minor: number) => ({ minor, currency: 'INR' });
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };

describe.each(backings)('the plan in force and the price pack take the shop\'s today — on $name (R16-A P2)', ({ harness, restart }) => {
  it('at 01:00 shop time a plan effective today is in force and an MRP starting today reaches the pack; both follow the tenant\'s zone', async () => {
    const tenant = randomUUID(); // a fresh shop per backing — the PostgreSQL database outlives the run
    let h: ApiHarness = harness();
    await h.seedOwner(tenant, 'u-owner');
    const { req, ok } = tenantClient(() => h, tenant);
    const put = (path: string, body: unknown) => h.request({ method: 'PUT', path, userId: 'u-owner', tenantId: tenant, idempotencyKey: `k-${randomUUID()}`, body });
    const today = evening.shopDate; // the shop's date at the pinned moment — the UTC date is the day before
    expect(evening.utcDate < today).toBe(true);

    // ── the planogram: the shelf map, then a plan effective on the shop's today ─────────────────────────────────────────
    await ok(put(`/v1/merchandising/stores/${STORE}/shelf-map`, { locations: LOCS }), 'shelf map');
    await ok(put(`/v1/merchandising/stores/${STORE}/planograms/PG-OLD`, { effectiveFrom: '2026-01-01', assignments: ASSIGN }), 'old plan');
    await ok(put(`/v1/merchandising/stores/${STORE}/planograms/PG-TODAY`, { effectiveFrom: today, assignments: ASSIGN }), 'today\'s plan');
    await deliveryPlaces(h, tenant, STORE, 'wh-1');
    await ok(req('POST', `/v1/stores/${STORE}/settings`, { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'wh-1' }), 'settings');

    // ── the price pack: an MRP moving on the shop's today (₹100 → ₹120), priced, taxed ──────────────────────────────────
    await ok(req('POST', '/v1/catalogue/products/p-oil/publish', { product: { sku: 'SKU-OIL', name: 'Synthetic oil 1 L', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '15079010', lifecycle: 'active',
      mrpHistory: [{ value: inr(100_00), effectiveFrom: '2026-01-01' }, { value: inr(120_00), effectiveFrom: today }] }, categories: [GROCERY] }), 'product');
    await ok(req('POST', '/v1/catalogue/tax-classes/15079010/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/prices/list/p-oil/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 95_00, mrpMinor: 120_00, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), 'price');

    h = restart(h); // ── COLD RESTART: judged on what was stored ───────────────────────────────────────────────────────────
    await h.provisionRole(tenant, 'u-cash', 'cashier');
    await h.provisionRole(tenant, 'u-box', 'store_computer', [STORE]);

    const inForce = async (): Promise<string | null> => ((await ok(req('GET', `/v1/merchandising/stores/${STORE}/planograms`), 'plans')).body as { inForce: { planogramId: string } | null }).inForce?.planogramId ?? null;
    const packPlan = async (): Promise<string | undefined> => ((await ok(req('GET', `/v1/store-packs/${STORE}`, undefined, 'u-box'), 'store pack')).body as { sections: { planogram?: { planogramId: string } } }).sections.planogram?.planogramId;
    const bayPlan = async (): Promise<string> => ((await ok(req('GET', '/v1/merchandising/planogram-compliance/bays', undefined, 'u-owner', { storeId: STORE }), 'bays')).body as { planogramId: string }).planogramId;
    const packMrp = async (): Promise<number | undefined> => {
      await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE }), 'publish the pack');
      const pack = (await ok(req('GET', '/v1/catalogue/pack'), 'the pack')).body as { snapshot: { products: { productId: string; mrpMinor?: number }[] } };
      return pack.snapshot.products.find((p) => p.productId === 'p-oil')?.mrpMinor;
    };
    expect(await inForce()).toBe('PG-TODAY');
    expect(await packPlan()).toBe('PG-TODAY');
    expect(await bayPlan()).toBe('PG-TODAY');
    expect(await packMrp()).toBe(120_00);
    const preview = (await ok(req('GET', '/v1/catalogue/pack/preview', undefined, 'u-owner', { storeId: STORE }), 'preview')).body as { snapshot: { products: { mrpMinor?: number }[] } };
    expect(preview.snapshot.products[0]?.mrpMinor).toBe(120_00);

    // The shop's zone is the TENANT's, not a constant: in a zone still on the UTC date the plan and the MRP are yesterday's.
    expect((await ownerApprovedSetting(h, tenant, 'locale.time_zone', { value: 'Europe/London' })).status).toBe(200);
    expect(await inForce()).toBe('PG-OLD');
    expect(await bayPlan()).toBe('PG-OLD');
    expect(await packMrp()).toBe(100_00);

    // The error paths are unchanged: a cashier may not read the plans, nor publish a pack.
    expect((await req('GET', `/v1/merchandising/stores/${STORE}/planograms`, undefined, 'u-cash')).status).toBe(403);
    expect((await req('POST', '/v1/catalogue/pack', { storeId: STORE }, 'u-cash')).status).toBe(403);
  }, 60_000);
});
