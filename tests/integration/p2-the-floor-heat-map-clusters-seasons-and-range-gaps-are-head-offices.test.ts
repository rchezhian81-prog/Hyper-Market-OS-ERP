import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useRestartableBackings, dayFromToday } from '../support/p3-backings';
import { aBranch } from '../support/a-branch';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { p2SeasonSweep } from '../../services/api/src/p2-catalogue-adapters';

// OB-288 P2 — merchandising facts folded from head office's own records, on the in-memory store and (with DATABASE_URL) on
// real PostgreSQL, each with a cold restart reading the same answer:
//   • M04-FR-04 · OB-308: a floor plan (coordinates per shelf area) and its heat map, by sales or margin per sq ft, from the
//     banked bills, the average buying cost and the planograms — a product with no cost is "margin not known", never zero;
//   • D02-FR-02 · OB-318: the cluster is the price-zone register; a cluster drop reads each store's own stock; a season plan
//     lists ahead and ends by itself into clearance (the ops worker's sweep);
//   • D02-FR-04 · OB-319: the range-gap report — short-picks, failed substitutions and no-result searches by category and
//     price band, and private-label margin against branded.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const STORE = 'store-1';
const today = dayFromToday(0);
const soldAt = new Date(Date.now() - 60_000).toISOString();

async function shop(h: ApiHarness, T: string): Promise<void> {
  await h.seedOwner(T, 'u-owner');
  await aBranch(h, T, 'u-owner', STORE);
  await h.provisionRole(T, 'u-cash', 'cashier');
  await h.provisionRole(T, 'u-mgr', 'store_manager');
}
const post = (h: ApiHarness, T: string, path: string, body: unknown, userId = 'u-owner', method: 'POST' | 'PUT' = 'POST') =>
  h.request({ method, path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
const get = (h: ApiHarness, T: string, path: string, query: Record<string, string> = {}, userId = 'u-owner') =>
  h.request({ method: 'GET', path, userId, tenantId: T, query });

const GROCERY = { categoryId: 'staples', name: 'Staples', parentId: null };
const product = (productId: string, over: Record<string, unknown> = {}) => ({ sku: `SKU-${productId}`, name: productId, baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006', lifecycle: 'active', ...over });
async function publish(h: ApiHarness, T: string, productId: string, over: Record<string, unknown> = {}): Promise<void> {
  const r = await post(h, T, `/v1/catalogue/products/${productId}/publish`, { product: product(productId, over), categories: [GROCERY] });
  if (r.status !== 201) throw new Error(`${productId}: ${r.status} ${JSON.stringify(r.body)}`);
}
/** A pack published for the store, carrying each product's price and tax (what de-taxes a bill line). */
async function pack(h: ApiHarness, T: string, products: readonly { productId: string; price: number }[]): Promise<void> {
  await h.store.append(T, STREAM.catalogue, makeEvent({
    id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: soldAt, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: T, version: 1, builtAt: soldAt, scope: { tenantId: T, storeId: STORE }, products: products.map((p) => ({ productId: p.productId, sku: p.productId, name: p.productId, unitPriceMinor: p.price, taxBps: 500, status: 'active', uom: 'each' })), barcodes: [] } },
  }));
}
const receive = (h: ApiHarness, T: string, productId: string, qty: number, unitCostMinor: number) =>
  post(h, T, '/v1/inventory/movements', { movementId: `rc-${productId}-${randomUUID()}`, productId, locationId: STORE, kind: 'received', quantityMinor: qty, unitCostMinor, uom: 'each', occurredAt: soldAt, enteredBy: 'u-owner' });
const sell = (h: ApiHarness, T: string, saleId: string, lines: readonly { productId: string; qty: number; price: number }[]) => {
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  return post(h, T, '/v1/sales', {
    saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-owner', tradingDay: today, committedAt: soldAt, totalMinor: total, currency: 'INR', packVersion: 1, locationId: STORE,
    lines: lines.map((l) => ({ productId: l.productId, quantityMinor: l.qty, uom: 'each', unitPriceMinor: l.price, lineTotalMinor: l.qty * l.price })),
    tenders: [{ kind: 'cash', amountMinor: total }],
  });
};

describe.each(backings)('OB-288 P2 — the floor heat map, clusters and seasons, and range gaps — on $name', ({ harness }) => {
  it('a floor plan on the shelf map, and a heat map by sales and by margin per sq ft from the bills; a restart reads the same', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    for (const p of ['rice', 'dal', 'milk', 'soap']) await publish(h, T, p);
    await pack(h, T, [{ productId: 'rice', price: 10_500 }, { productId: 'dal', price: 5_250 }, { productId: 'milk', price: 3_150 }, { productId: 'soap', price: 2_100 }]);
    expect((await post(h, T, `/v1/merchandising/stores/${STORE}/shelf-map`, { locations: [
      { locationId: 'A1', aisle: 1, rack: 1, bay: 1, shelf: 1, position: 1 }, { locationId: 'B1', aisle: 2, rack: 1, bay: 1, shelf: 1, position: 1 },
    ] }, 'u-owner', 'PUT')).status).toBe(201);
    expect((await post(h, T, `/v1/merchandising/stores/${STORE}/planograms/main`, { effectiveFrom: dayFromToday(-1), assignments: [
      { productId: 'rice', locationId: 'A1', capacityMinor: 40, primary: true }, { productId: 'dal', locationId: 'A1', capacityMinor: 40, primary: true },
      { productId: 'milk', locationId: 'B1', capacityMinor: 40, primary: true },
    ] }, 'u-owner', 'PUT')).status).toBe(201);

    // The plan: refused by name when an area sits off the floor or names a shelf place the map does not hold.
    const bad = await post(h, T, `/v1/merchandising/stores/${STORE}/floor-plan`, { widthFt: 40, depthFt: 30, areas: [{ areaId: 'x', name: 'X', x: 35, y: 0, width: 10, depth: 10, locationIds: ['Z9'] }] });
    expect(bad.status).toBe(422);
    expect(codeOf(bad)).toBe('floor_plan_not_valid');
    expect((await post(h, T, `/v1/merchandising/stores/${STORE}/floor-plan`, { widthFt: 40, depthFt: 30, areas: [] }, 'u-cash')).status).toBe(403);
    expect(codeOf(await post(h, T, '/v1/merchandising/stores/nowhere/floor-plan', { widthFt: 40, depthFt: 30, areas: [] }))).toBe('unknown_store');
    const plan = await post(h, T, `/v1/merchandising/stores/${STORE}/floor-plan`, { widthFt: 40, depthFt: 30, areas: [
      { areaId: 'staples', name: 'Staples', nameTa: 'மளிகை', x: 0, y: 0, width: 10, depth: 10, locationIds: ['A1'] },
      { areaId: 'dairy', name: 'Dairy', nameTa: 'பால் பொருட்கள்', x: 20, y: 0, width: 5, depth: 10, locationIds: ['B1'] },
    ] });
    expect(plan.status).toBe(201);
    expect(plan.body).toMatchObject({ plan: { version: 1, areas: [{ areaId: 'staples', squareFeet: 100 }, { areaId: 'dairy', squareFeet: 50 }] } });

    // Rice and dal cost what they cost; milk has NO cost recorded; soap has no shelf place on the plan.
    await receive(h, T, 'rice', 10, 8_000);
    await receive(h, T, 'dal', 10, 4_000);
    expect((await sell(h, T, 'S1', [{ productId: 'rice', qty: 2, price: 10_500 }, { productId: 'dal', qty: 2, price: 5_250 }, { productId: 'milk', qty: 5, price: 3_150 }, { productId: 'soap', qty: 1, price: 2_100 }])).status).toBe(202);

    const window = { from: today, to: today };
    const sales = await get(h, T, `/v1/merchandising/stores/${STORE}/heat-map`, { ...window, measure: 'sales' });
    expect(sales.status).toBe(200);
    type Heat = { areas: { areaId: string; salesMinor: number; heat: number | null; marginMinor: number | null; marginNotKnownFor: string[]; salesPerSqFt: unknown }[]; notOnFloorPlan: { products: string[]; salesMinor: number } };
    const s = sales.body as Heat;
    expect(s.areas.find((a) => a.areaId === 'staples')).toMatchObject({ salesMinor: 31_500, heat: 100, salesPerSqFt: { kind: 'per_sq_ft', minorPerSqFt: 315 } });
    expect(s.areas.find((a) => a.areaId === 'dairy')).toMatchObject({ salesMinor: 15_750, heat: 100 });
    expect(s.notOnFloorPlan).toEqual({ products: ['soap'], salesMinor: 2_100 });
    const margin = (await get(h, T, `/v1/merchandising/stores/${STORE}/heat-map`, { ...window, measure: 'margin' })).body as Heat;
    // Rice: 21,000 → 20,000 ex-tax − 16,000 cost; dal: 10,500 → 10,000 − 8,000. Milk's margin is not known — named.
    expect(margin.areas.find((a) => a.areaId === 'staples')).toMatchObject({ marginMinor: 6_000, heat: 100 });
    expect(margin.areas.find((a) => a.areaId === 'dairy')).toMatchObject({ marginMinor: null, marginNotKnownFor: ['milk'], heat: null });
    expect(codeOf(await get(h, T, `/v1/merchandising/stores/${STORE}/heat-map`, { from: today, to: today, measure: 'turnover' }))).toBe('not_readable_as_a_heat_map');
    expect((await get(h, T, `/v1/merchandising/stores/${STORE}/heat-map`, { ...window, measure: 'sales' }, 'u-cash')).status).toBe(403);

    const again = harness(h);
    expect((await get(again, T, `/v1/merchandising/stores/${STORE}/heat-map`, { ...window, measure: 'margin' })).body).toMatchObject({ areas: margin.areas, planVersion: 1 });
    expect((await get(again, T, `/v1/merchandising/stores/${STORE}/floor-plan`)).body).toMatchObject({ plan: { version: 1 } });
  }, 120_000);

  it('a cluster is a price zone; a cluster drop reads each store\'s stock; a season lists ahead and ends by itself into clearance', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    await aBranch(h, T, 'u-owner', 'store-2');
    for (const p of ['crackers', 'sweets', 'diya']) await publish(h, T, p);
    expect((await post(h, T, '/v1/prices/zones/north/stores/store-1', {})).status).toBe(201);
    expect((await post(h, T, '/v1/prices/zones/north/stores/store-2', {})).status).toBe(201);
    expect((await get(h, T, '/v1/merchandising/clusters')).body).toMatchObject({ clusters: [{ zoneId: 'north', stores: ['store-1', 'store-2'] }], register: 'price_zones' });

    // A cluster listing is the ordinary per-store range entry for every store in it.
    expect((await post(h, T, '/v1/merchandising/clusters/north/diya/list', { effectiveFrom: today })).body).toMatchObject({ stores: ['store-1', 'store-2'] });
    expect(((await get(h, T, '/v1/merchandising/assortment/store-2', { onDate: today })).body as { listed: string[] }).listed).toContain('diya');
    expect(codeOf(await post(h, T, '/v1/merchandising/clusters/south/diya/list', { effectiveFrom: today }))).toBe('cluster_has_no_stores');
    expect((await post(h, T, '/v1/merchandising/clusters/north/diya/list', { effectiveFrom: today }, 'u-cash')).status).toBe(403);
    // A drop: stock on hand in store-1 → clearance there; none in store-2 → delisted. A typed stock figure is refused.
    await receive(h, T, 'diya', 7, 1_000);
    expect(codeOf(await post(h, T, '/v1/merchandising/clusters/north/diya/drop', { reason: 'poor_sales', effectiveFrom: today, onHandMinor: 0 }))).toBe('drop_carries_caller_stock');
    const drop = await post(h, T, '/v1/merchandising/clusters/north/diya/drop', { reason: 'poor_sales', effectiveFrom: today });
    expect((drop.body as { decisions: { storeId: string; outcome: string }[] }).decisions).toEqual([
      { storeId: 'store-1', outcome: 'routed_to_clearance', onHandMinor: 7 }, { storeId: 'store-2', outcome: 'delisted', onHandMinor: 0 },
    ]);

    // A season that has already ended (synthetic past dates) is listed ahead and ends by the ops worker's own sweep.
    expect(codeOf(await post(h, T, '/v1/merchandising/season-plans/diwali', { zoneId: 'north', productIds: ['crackers'], listFrom: today, listTo: dayFromToday(-1), reason: 'x' }))).toBe('season_ends_before_it_starts');
    const made = await post(h, T, '/v1/merchandising/season-plans/diwali', { zoneId: 'north', productIds: ['crackers', 'sweets'], listFrom: dayFromToday(-20), listTo: dayFromToday(-1), reason: 'Diwali' });
    expect(made.status).toBe(201);
    expect(codeOf(await post(h, T, '/v1/merchandising/season-plans/diwali', { zoneId: 'north', productIds: ['crackers'], listFrom: dayFromToday(-20), listTo: dayFromToday(-1), reason: 'again' }))).toBe('season_plan_already_made');
    expect(((await get(h, T, '/v1/merchandising/assortment/store-1', { onDate: dayFromToday(-5) })).body as { listed: string[] }).listed).toEqual(expect.arrayContaining(['crackers', 'sweets']));
    expect((await get(h, T, '/v1/merchandising/season-plans')).body).toMatchObject({ dueToEnd: 1 });
    await receive(h, T, 'crackers', 12, 500);
    expect(await p2SeasonSweep({ store: h.store, now: () => new Date().toISOString() })(T, new Date().toISOString())).toBe(1);
    expect(await p2SeasonSweep({ store: h.store, now: () => new Date().toISOString() })(T, new Date().toISOString())).toBe(0); // ends once
    const again = harness(h);
    const plans = (await get(again, T, '/v1/merchandising/season-plans')).body as { plans: { planId: string; standing: string; end: { decisions: { storeId: string; productId: string; outcome: string }[] } }[] };
    expect(plans.plans[0]).toMatchObject({ planId: 'diwali', standing: 'ended' });
    expect(plans.plans[0]!.end.decisions).toEqual(expect.arrayContaining([
      { storeId: 'store-1', productId: 'crackers', outcome: 'clearance' }, { storeId: 'store-1', productId: 'sweets', outcome: 'delisted' },
      { storeId: 'store-2', productId: 'crackers', outcome: 'delisted' },
    ]));
    // Clearance stays sellable; the delisted is gone from the range.
    const range = (await get(again, T, '/v1/merchandising/assortment/store-1', { onDate: today })).body as { listed: string[] };
    expect(range.listed).not.toContain('sweets');
  }, 120_000);

  it('the range-gap report folds short-picks, failed substitutions and no-result searches, and private label against branded', async () => {
    const h = harness();
    const T = randomUUID();
    await shop(h, T);
    await h.provisionRole(T, 'u-shopper', 'customer');
    for (const p of ['oil-1l', 'oil-5l', 'sre-rice', 'brand-rice']) await publish(h, T, p);
    await pack(h, T, [{ productId: 'oil-1l', price: 18_000 }, { productId: 'oil-5l', price: 80_000 }, { productId: 'sre-rice', price: 10_500 }, { productId: 'brand-rice', price: 21_000 }]);
    // The shop's own lost-demand facts, as the picker's handheld and the substitution record wrote them.
    const at = soldAt;
    await h.store.append(T, streamName(STREAM.delivery, 'assignment-index'), makeEvent({ id: 'ap-w1', type: 'AssignmentPlaced', occurredAt: at, idempotencyKey: `ap-${T}-w1`, source: 'test', payload: { kind: 'wave', id: 'w1', storeId: STORE, at } }));
    for (const [lineId, productId, required, picked] of [['l1', 'oil-1l', 3, 1], ['l2', 'oil-5l', 1, 0], ['l3', 'sre-rice', 2, 2]] as const) {
      await h.store.append(T, streamName(STREAM.delivery, 'wave', 'w1'), makeEvent({ id: `wl-${lineId}`, type: 'PickLineOutcomeRecorded', occurredAt: at, idempotencyKey: `wl-${T}-${lineId}`, source: 'test',
        payload: { waveId: 'w1', lineId, orderRef: `o-${lineId}`, productId, state: picked < required ? 'short' : 'picked', pickedQty: picked, requiredQty: required, uom: 'ea', finalPriceMinor: 0, currency: 'INR', substituted: false, note: null, pickedBy: 'u-mgr', relayedBy: 'u-box', at, governanceFlags: [] } }));
    }
    await h.store.append(T, streamName(STREAM.orders, 'substitutions'), makeEvent({ id: 'sub-o-l1', type: 'LineSubstituted', occurredAt: at, idempotencyKey: `sub-${T}-o-l1`, source: 'test',
      payload: { orderId: 'o-l1', lineId: 'x1', decision: 'declined', outcome: 'short_picked', pickProductId: null, pickQuantityMinor: 0, chargeMinor: 0, refundMinor: 0, at } }));
    // Two searches that found nothing — the words only; a phone number is never kept.
    for (const words of ['Cold pressed  groundnut OIL', 'cold pressed groundnut oil']) expect((await post(h, T, '/v1/catalogue/search-misses', { words }, 'u-shopper')).status).toBe(201);
    expect(codeOf(await post(h, T, '/v1/catalogue/search-misses', { words: 'call me 9876543210' }, 'u-shopper'))).toBe('not_readable_as_a_search');
    expect((await post(h, T, '/v1/catalogue/search-misses', { words: 'oil' }, 'u-cash')).status).toBe(403);
    // SRE's own rice is private label (its EPR own-brand declaration); the branded one is not.
    expect((await post(h, T, '/v1/compliance/epr/own-brand/sre-rice', { ownBrand: true, packaging: [] })).status).toBeLessThan(300);
    await receive(h, T, 'sre-rice', 10, 7_000);
    await receive(h, T, 'brand-rice', 10, 17_000);
    expect((await sell(h, T, 'S1', [{ productId: 'sre-rice', qty: 1, price: 10_500 }, { productId: 'brand-rice', qty: 1, price: 21_000 }])).status).toBe(202);

    const q = { from: today, to: today, bandEdgesMinor: '5000,20000' };
    const report = await get(h, T, '/v1/merchandising/range-gaps', q);
    expect(report.status).toBe(200);
    const r = report.body as { gaps: { categoryId: string; band: string; shortPicks: number; failedSubstitutions: number; products: string[] }[]; searchesWithNoResult: { words: string; count: number }[]; privateLabel: { categoryId: string; privateLabel: { marginMinor: number; marginBps: number }; branded: { marginMinor: number } }[]; totals: Record<string, number>; bands: string[] };
    expect(r.bands).toEqual(['under ₹50', '₹50 to ₹200', '₹200 and above']);
    expect(r.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ categoryId: 'staples', band: '₹50 to ₹200', shortPicks: 1, failedSubstitutions: 1, products: ['oil-1l'] }),
      expect.objectContaining({ categoryId: 'staples', band: '₹200 and above', shortPicks: 1, failedSubstitutions: 0, products: ['oil-5l'] }),
    ]));
    expect(r.searchesWithNoResult).toEqual([{ words: 'cold pressed groundnut oil', count: 2 }]);
    expect(r.totals).toEqual({ shortPicks: 2, failedSubstitutions: 1, searchesWithNoResult: 2 });
    // sre-rice: 10,500 → 10,000 ex-tax − 7,000; brand-rice: 21,000 → 20,000 − 17,000.
    expect(r.privateLabel).toEqual([expect.objectContaining({ categoryId: 'staples', privateLabel: expect.objectContaining({ marginMinor: 3_000, marginBps: 3_000 }), branded: expect.objectContaining({ marginMinor: 3_000 }) })]);
    // No bands sent: one band, said.
    expect((await get(h, T, '/v1/merchandising/range-gaps', { from: today, to: today })).body).toMatchObject({ bands: ['all prices'], bandsChosenBy: 'none_sent_one_band' });
    expect(codeOf(await get(h, T, '/v1/merchandising/range-gaps', { from: today, to: today, bandEdgesMinor: 'cheap' }))).toBe('not_readable_as_a_range_gap_report');
    expect((await get(h, T, '/v1/merchandising/range-gaps', q, 'u-cash')).status).toBe(403);
    const again = harness(h);
    expect((await get(again, T, '/v1/merchandising/range-gaps', q)).body).toMatchObject({ gaps: r.gaps, totals: r.totals, privateLabel: r.privateLabel });
  }, 120_000);
});
