import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';

/**
 * **OB-630 (owner, 1 Nov 2026): the Buying page's Reorder tab on the store computer, with head office up and then down.**
 *   • head office answers: the tab shows head office's own settings (version 2), never the box's copy;
 *   • head office cannot be reached: the tab shows the store computer's copy from its signed store pack (version 1, as the
 *     pack carried it), said plainly as "copy from <time>", English and Tamil — and offers no proposal (P-08).
 */

const OWNER = 'u-owner'; const BUYER = 'u-buyer';
const V1 = { storeId: 'store-1', productId: 'RICE', version: 1, maxLevel: 50_000, reorderPoint: 10_000, reason: 'festival season', setBy: 'u-buyer', setAt: '2026-10-30T05:00:00.000Z' };

describe.skipIf(!HAVE_BROWSER)('OB-630 — the Reorder tab shows the store computer\'s copy when head office is down', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'ob630',
      people: [{ userId: BUYER, permissions: ['purchase.commitment.read', 'inventory.availability.read', 'purchase.order.propose'] }],
      pack: {
        buyingPolicy: { quantityToleranceBps: 0, priceToleranceBps: 0, immaterialMinor: 0, approvers: [] },
        // the store pack as head office built it last night: version 1 of rice's settings
        reorderSettings: { storeId: 'store-1', products: [{ current: V1, history: [V1] }], asAt: '2026-10-31T20:00:00.000Z' },
      },
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, BUYER, 'store_manager', [store]);
        for (const [maxLevel, reason] of [[50_000, 'festival season'], [60_000, 'sells faster now']] as const) {
          const r = await ho.request({ method: 'POST', path: `/v1/replenishment/parameters/${store}/RICE`, userId: BUYER, tenantId: T, branchId: store, idempotencyKey: `rp-${maxLevel}`, body: { maxLevel, reorderPoint: 10_000, reason } });
          if (r.status >= 300) throw new Error(JSON.stringify(r.body));
        }
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('head office up: its own settings; head office down: the copy, marked "copy from <time>"', async () => {
    const b = await shop.open(BUYER, '/buying/');
    await b.page.click('#tab-reorder');
    await b.page.fill('#reorder-store', 'store-1');
    await b.page.click('#reorder-read');
    await says(b.page, '#reorder-params tr[data-product="RICE"]', /version 2/);
    expect(await b.page.getAttribute('#reorder-params', 'data-copy')).toBeNull();
    expect(await b.page.textContent('#reorder-status')).not.toMatch(/copy/);

    // head office cannot be reached
    await b.page.context().unroute('**/v1/**');
    await b.page.context().route('**/v1/**', (route) => route.abort('internetdisconnected'));
    await b.page.click('#reorder-read');
    await says(b.page, '#reorder-status', /^Head office cannot be reached — these are the store computer's copy from .+\. Nothing can be saved or proposed until head office answers/);
    await says(b.page, '#reorder-params tr[data-product="RICE"]', /version 1 · set by u-buyer · Why: festival season/);
    expect(await b.page.getAttribute('#reorder-params', 'data-copy')).toBe('true');
    expect(await b.page.locator('#reorder-proposal tr').count()).toBe(0);
    await b.page.click('#lang');
    await b.page.click('#reorder-read');
    await says(b.page, '#reorder-status', /கடைக் கணினியின் நகல்/);
    expect(b.errors).toEqual([]);
    await b.close();
  });
});
