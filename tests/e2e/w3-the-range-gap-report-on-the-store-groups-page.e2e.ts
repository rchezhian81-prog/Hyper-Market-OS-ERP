import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { dayFromToday } from '../support/p3-backings';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **W3 (D02-FR-04 "range gaps and private label" · OB-319): the range-gap report on the Store groups and seasons page, on the
 * store computer, over head office's own records.** No screen read the report before. In a real browser:
 *   • over a day with two short-picks (1-litre oil short 2, 5-litre oil short 1), one substitute turned down, two empty app
 *     searches for "cold pressed groundnut oil", and a bill of SRE's own rice beside a branded rice, the manager asks for the
 *     report in ₹50 and ₹200 bands: the oil lines are filed under Staples in their bands, the search under its words, and
 *     own-brand margin (30.0%, net of tax) beside branded (15.0%);
 *   • asked with no bands, the page says it is one band, all prices; bands typed falling are refused on the page;
 *   • reading writes nothing; a cashier the box lets open the page is refused the report by head office, in its words.
 * Synthetic data only.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const CASH = 'u-cash'; const SHOPPER = 'u-shopper';
const today = dayFromToday(0);
const at = new Date(Date.now() - 60_000).toISOString();

describe.skipIf(!HAVE_BROWSER)('the range-gap report on the Store groups and seasons page (D02-FR-04)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'range-gaps',
      people: [{ userId: MGR, permissions: ['merchandising.range.read', 'merchandising.range.manage'] }, { userId: CASH, permissions: ['merchandising.range.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, CASH, 'cashier', [store]);
        await ho.provisionRole(T, SHOPPER, 'customer');
        const post = async (path: string, body: unknown, who = OWNER) => {
          const r = await ho.request({ method: 'POST', path, userId: who, tenantId: T, idempotencyKey: `seed-${path}-${JSON.stringify(body).length}-${Math.random()}`, body });
          if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
        };
        for (const p of ['oil-1l', 'oil-5l', 'sre-rice', 'brand-rice']) {
          await post(`/v1/catalogue/products/${p}/publish`, { product: { sku: `SKU-${p}`, name: p, baseUom: 'each', primaryCategoryId: 'staples', taxClass: '1006', lifecycle: 'active' }, categories: [{ categoryId: 'staples', name: 'Staples', parentId: null }] });
        }
        await ho.store.append(T, STREAM.catalogue, makeEvent({
          id: `pack-${T}-1`, type: 'CataloguePublished', occurredAt: at, idempotencyKey: `catalogue-${T}-v1`, source: 'test/catalogue',
          payload: { snapshot: { tenantId: T, version: 1, builtAt: at, scope: { tenantId: T, storeId: store }, products: [['oil-1l', 18_000], ['oil-5l', 80_000], ['sre-rice', 10_500], ['brand-rice', 21_000]].map(([productId, price]) => ({ productId, sku: productId, name: productId, unitPriceMinor: price, taxBps: 500, status: 'active', uom: 'each' })), barcodes: [] } },
        }));
        // the picker's handheld and the substitution record, as they write them
        await ho.store.append(T, streamName(STREAM.delivery, 'assignment-index'), makeEvent({ id: 'ap-w1', type: 'AssignmentPlaced', occurredAt: at, idempotencyKey: `ap-${T}-w1`, source: 'test', payload: { kind: 'wave', id: 'w1', storeId: store, at } }));
        for (const [lineId, productId, required, picked] of [['l1', 'oil-1l', 3, 1], ['l2', 'oil-5l', 1, 0], ['l3', 'sre-rice', 2, 2]] as const) {
          await ho.store.append(T, streamName(STREAM.delivery, 'wave', 'w1'), makeEvent({ id: `wl-${lineId}`, type: 'PickLineOutcomeRecorded', occurredAt: at, idempotencyKey: `wl-${T}-${lineId}`, source: 'test',
            payload: { waveId: 'w1', lineId, orderRef: `o-${lineId}`, productId, state: picked < required ? 'short' : 'picked', pickedQty: picked, requiredQty: required, uom: 'ea', finalPriceMinor: 0, currency: 'INR', substituted: false, note: null, pickedBy: MGR, relayedBy: 'u-box', at, governanceFlags: [] } }));
        }
        await ho.store.append(T, streamName(STREAM.orders, 'substitutions'), makeEvent({ id: 'sub-o-l1', type: 'LineSubstituted', occurredAt: at, idempotencyKey: `sub-${T}-o-l1`, source: 'test',
          payload: { orderId: 'o-l1', lineId: 'x1', decision: 'declined', outcome: 'short_picked', pickProductId: null, pickQuantityMinor: 0, chargeMinor: 0, refundMinor: 0, at } }));
        for (const words of ['Cold pressed  groundnut OIL', 'cold pressed groundnut oil']) await post('/v1/catalogue/search-misses', { words }, SHOPPER);
        await post('/v1/compliance/epr/own-brand/sre-rice', { ownBrand: true, packaging: [] });
        for (const [p, cost] of [['sre-rice', 7_000], ['brand-rice', 17_000]] as const) {
          await post('/v1/inventory/movements', { movementId: `rc-${p}`, productId: p, locationId: store, kind: 'received', quantityMinor: 10, unitCostMinor: cost, uom: 'each', occurredAt: at, enteredBy: OWNER });
        }
        const lines = [{ productId: 'sre-rice', qty: 1, price: 10_500 }, { productId: 'brand-rice', qty: 1, price: 21_000 }];
        const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
        const sale = await ho.request({ method: 'POST', path: '/v1/sales', userId: OWNER, tenantId: T, idempotencyKey: 'sale-S1', body: {
          saleId: 'S1', receiptNumber: 'R-S1', laneId: 'lane-1', cashierId: OWNER, tradingDay: today, committedAt: at, totalMinor: total, currency: 'INR', packVersion: 1, locationId: store,
          lines: lines.map((l) => ({ productId: l.productId, quantityMinor: l.qty, uom: 'each', unitPriceMinor: l.price, lineTotalMinor: l.qty * l.price })), tenders: [{ kind: 'cash', amountMinor: total }],
        } });
        if (sale.status !== 202) throw new Error(`sale: ${sale.status} ${JSON.stringify(sale.body)}`);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager reads the gaps by category and band, the empty searches and own brand against branded', async () => {
    const m = await shop.open(MGR, '/range-clusters/');
    await m.page.waitForSelector('#gaps:not([hidden])');
    await says(m.page, '#gaps-h', /^Range gaps and own brand$/);
    await m.page.fill('#g-from', today); await m.page.fill('#g-to', today);
    await m.page.fill('#g-bands', '200, 50');
    await m.page.click('#gaps-go');
    await says(m.page, '#gaps-status', /^Type the band edges in rupees, rising/);
    await m.page.fill('#g-bands', '50, 200');
    await m.page.click('#gaps-go');
    await says(m.page, '#gaps-cards', /Short-picks: 2.*Substitutes turned down: 1.*Searches with no result: 2.*Own-brand products: 1/);
    await says(m.page, '#gap-table tr[data-category="staples"][data-band="₹50 to ₹200"]', /staples₹50 to ₹20011oil-1l/);
    await says(m.page, '#gap-table tr[data-category="staples"][data-band="₹200 and above"]', /staples₹200 and above10oil-5l/);
    await says(m.page, '#search-table tr[data-words="cold pressed groundnut oil"]', /cold pressed groundnut oil2/);
    await says(m.page, '#pl-table tr[data-category="staples"]', /staples30\.0%15\.0%/);
    // no bands typed: one band, said so
    await m.page.fill('#g-bands', '');
    await m.page.click('#gaps-go');
    await says(m.page, '#one-band', /One band, all prices/);
    await m.page.click('#lang');
    await says(m.page, '#gaps-h', /^வரிசை இடைவெளிகளும் சொந்த பிராண்டும்$/);
    expect(m.writes).toEqual([]);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a cashier the box lets open the page is refused the report by head office, in its words', async () => {
    const c = await shop.open(CASH, '/range-clusters/');
    await c.page.waitForSelector('#gaps:not([hidden])');
    await c.page.fill('#g-from', today); await c.page.fill('#g-to', today);
    await c.page.click('#gaps-go');
    await says(c.page, '#gaps-status', /^Head office refused:/);
    expect(await c.page.locator('#gap-table').count()).toBe(0);
    expect(c.writes).toEqual([]);
    await c.close();
  });
});
