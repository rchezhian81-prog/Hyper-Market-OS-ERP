import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { certifyFoodHandler } from '../support/food-handler';

/**
 * **Round 4d (M11-FR-03): a batch is repacked from the Production page on the store computer.** The store manager puts six
 * packs of cookie batch CK-1 into a new batch CK-1-R1; head office gives it CK-1's expiry and keeps it waiting for release,
 * and the lot trace of CK-1 shows it. A person who may only look at production is offered no repack form.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const VIEWER = 'u-view';

describe.skipIf(!HAVE_BROWSER)('Repack on the Production page (Round 4d)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'repack',
      // the store pack's production section: the box serves the Production page only when it carries one (it names who looks)
      pack: { productionPolicy: { permissions: [] } },
      people: [{ userId: MGR, permissions: ['production.read', 'production.plan.commit', 'production.release'] }, { userId: VIEWER, permissions: ['production.read'] }],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await certifyFoodHandler(ho.store, T, MGR);
        await ho.enableFeature(T, 'dept.bakery');
        const post = async (path: string, body: unknown) => {
          const r = await ho.request({ method: 'POST', path, userId: OWNER, tenantId: T, idempotencyKey: `seed-${path}`, body });
          if (r.status >= 300) throw new Error(`${path}: ${JSON.stringify(r.body)}`);
        };
        await post('/v1/production/departments/bakery', {});
        await post('/v1/inventory/movements', { movementId: 'rx-CK-1', productId: 'COOKIES', locationId: store, kind: 'received', quantityMinor: 20, uom: 'ea', occurredAt: '2030-04-01T01:00:00.000Z', enteredBy: OWNER, unitCostMinor: 4_000, batchId: 'CK-1', expiry: '2030-12-01' });
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager repacks six packs into a new batch that keeps the source\'s expiry', async () => {
    const m = await shop.open(MGR, '/production/');
    await m.page.waitForSelector('#repack:not([hidden])');
    await says(m.page, '#repack-h', /^Repack a batch$/);
    await m.page.fill('#rp-department', 'bakery');
    await m.page.fill('#rp-product', 'COOKIES');
    await m.page.fill('#rp-location', shop.store);
    await m.page.fill('#rp-source', 'CK-1');
    await m.page.fill('#rp-new', 'CK-1');
    await m.page.fill('#rp-qty', '6');
    await m.page.click('#repack-go');
    await says(m.page, '#repack-status', /must differ/);
    await m.page.fill('#rp-new', 'CK-1-R1');
    await m.page.click('#repack-go');
    await says(m.page, '#repack-status', /^Repacked\. The new batch keeps expiry 2030-12-01; it waits for its quality release below\.$/);
    const chain = (await shop.call('GET', '/v1/quality/lot-trace/CK-1/chain', OWNER)).body as { rows: { hop: string }[] };
    expect(chain.rows.some((r) => r.hop === 'production_used' && JSON.stringify(r).includes('CK-1-R1'))).toBe(true);
    await m.page.click('#lang');
    await says(m.page, '#repack-h', /^ஒரு தொகுதியை மறுபொதி செய்$/);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a person who may only look at production is offered no repack form', async () => {
    const v = await shop.open(VIEWER, '/production/');
    await v.page.waitForLoadState('load');
    expect(await v.page.isVisible('#repack')).toBe(false);
    expect(v.writes).toEqual([]);
    await v.close();
  });
});
