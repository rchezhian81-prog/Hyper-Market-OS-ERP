import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { assembleCatalogueSnapshot } from '../../services/catalogue/src/catalogue-preview';
import { cataloguePreviewAdapter } from '../../services/api/src/adapters';
import { packPricingFor } from '../../services/api/src/r3-ops-adapters';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';

/**
 * **D-19 → the pack (R3 seam, OB-148 "A" / OB-190), on the real API, in memory and on PostgreSQL, with a cold restart.**
 *
 * The catalogue pack the tills and the store computer take is built from the price list THROUGH the owner's switches:
 *   • while every switch is off — even with zone, app and delivery prices on file from an earlier switch-on, and the store
 *     in a zone — the pack is BYTE-IDENTICAL to the pack built as before D-19 (no gate, no zone): one shelf price;
 *   • a till (in-store) pack never takes an app or delivery price, even with those channels switched on;
 *   • once a second person switches ZONE pricing on, the pack names the store's zone and carries its zone price — and the
 *     store pack's products section carries it to the store computer.
 */
const backings = r3OpsBackings();
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const FROM = '2030-01-01';
const AS_OF = '2030-06-01';
const entry = (scope: string, scopeRef: string, priceMinor: number) => ({ scope, scopeRef, priceMinor, mrpMinor: 12_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: FROM });
interface Snapshot { scope: { storeId: string; zoneId?: string; channel?: string }; products: { productId: string; unitPriceMinor: number }[] }

describe.each(backings)('the pack carries the owner\'s zone / channel switches — on $name (D-19)', ({ harness, restart }) => {
  it('all off → byte-identical to before · app/delivery on → the till pack keeps the shelf price · zone on → the zone price', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const { req, ok } = tenantClient(() => h, T);
    const now = (): string => new Date().toISOString();
    await ok(req('POST', '/v1/catalogue/tax-classes/04061000/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/products/p-ghee/publish', { product: { sku: 'SKU-GHEE', name: 'Ghee 1L', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '04061000', lifecycle: 'draft' }, categories: [GROCERY] }), 'publish');
    await ok(req('POST', '/v1/prices/list/p-ghee/entries/shelf', entry('store', 'S-A', 10_000)), 'shelf price');
    await ok(req('POST', '/v1/prices/zones/Z-CBE/stores/S-A', {}), 'S-A is in zone Z-CBE');
    let n = 0;
    const switchTo = async (subject: string, to: 'on' | 'off') => {
      n += 1;
      await ok(req('POST', `/v1/prices/channel-pricing/requests/rq-${n}`, { subject, to, reason: `synthetic: ${subject} ${to}` }, 'u-mgr'), `ask ${subject} ${to}`);
      // Switching on needs a second person; switching off is immediate.
      if (to === 'on') await ok(req('POST', `/v1/prices/channel-pricing/requests/rq-${n}/approve`, { reason: 'checked' }), `approve ${subject}`);
    };

    // Earlier, each switch was on long enough for a price to be recorded — then all switched off again.
    for (const [subject, scope, ref, price] of [['zone', 'zone', 'Z-CBE', 9_500], ['channel:app', 'channel', 'app', 9_000], ['channel:delivery', 'channel', 'delivery', 8_800]] as const) {
      await switchTo(subject, 'on');
      await ok(req('POST', `/v1/prices/list/p-ghee/entries/${scope}-${ref}`, entry(scope, ref, price)), `${subject} price`);
      await switchTo(subject, 'off');
    }

    const opts = { tenantId: T, storeId: 'S-A', asOf: AS_OF, version: 0 };
    const before = async () => JSON.stringify((await assembleCatalogueSnapshot(cataloguePreviewAdapter({ store: h.store, now }), opts)).snapshot);
    const gated = async () => (await assembleCatalogueSnapshot(cataloguePreviewAdapter({ store: h.store, now, pricing: packPricingFor({ store: h.store, now }) }), opts)).snapshot as unknown as Snapshot;
    const preview = async () => ((await ok(req('GET', '/v1/catalogue/pack/preview', undefined, 'u-owner', { storeId: 'S-A', asOf: AS_OF }), 'preview')).body as { snapshot: Snapshot }).snapshot;

    // ── every switch off: byte-identical to the pack built before D-19 — the gate and the zone change nothing ──
    expect(JSON.stringify(await gated())).toBe(await before());
    expect((await gated()).scope).toEqual({ tenantId: T, storeId: 'S-A' });
    expect((await gated()).products.map((p) => p.unitPriceMinor)).toEqual([10_000]);
    // The served preview (main.ts's wiring) is the same snapshot.
    expect(JSON.stringify(await preview())).toBe(await before());

    h = restart(h); // ── COLD RESTART ──

    // ── app and delivery switched on: the till's own pack names no channel, so it keeps the shelf price ──
    await switchTo('channel:app', 'on');
    await switchTo('channel:delivery', 'on');
    expect((await gated()).products.find((p) => p.productId === 'p-ghee')!.unitPriceMinor).toBe(10_000);
    expect((await gated()).scope.channel).toBeUndefined();
    expect(JSON.stringify(await gated())).toBe(await before());

    // ── zone pricing switched on by a second person: the pack names the store's zone and carries its price ──
    await switchTo('zone', 'on');
    const zoned = await gated();
    expect(zoned.scope).toEqual({ tenantId: T, storeId: 'S-A', zoneId: 'Z-CBE' });
    expect(zoned.products.find((p) => p.productId === 'p-ghee')!.unitPriceMinor).toBe(9_500);
    expect(JSON.stringify(zoned)).not.toBe(await before());
    // Published through the real route: the signed pack the lanes take carries it…
    await ok(req('POST', '/v1/catalogue/pack', { storeId: 'S-A', asOf: AS_OF }), 'publish the pack');
    const pack = ((await ok(req('GET', '/v1/catalogue/pack'), 'pack')).body as { snapshot: Snapshot }).snapshot;
    expect(pack.scope.zoneId).toBe('Z-CBE');
    expect(pack.products.find((p) => p.productId === 'p-ghee')!.unitPriceMinor).toBe(9_500);
    // …and so does the store pack's products section for the store computer.
    const sections = await buildStorePackSections({ store: h.store, now, signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, T, 'S-A');
    expect((sections['products'] as { productId: string; unitPriceMinor: number }[]).find((p) => p.productId === 'p-ghee')!.unitPriceMinor).toBe(9_500);

    // ── zone pricing off again: back to the one shelf price, byte-identical once more ──
    await switchTo('zone', 'off');
    expect(JSON.stringify(await gated())).toBe(await before());
  }, 120_000);
});
