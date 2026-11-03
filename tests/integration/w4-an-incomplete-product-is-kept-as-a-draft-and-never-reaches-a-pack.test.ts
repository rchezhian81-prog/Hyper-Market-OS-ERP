import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { aStoreWithRules } from '../support/store-rules';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W4 · M03-FR-01 "Alt/error: incomplete product saved as draft" · M03-FR-03 · P-08 · hard rule #2 — on the real API, in memory
 * and on real PostgreSQL.**
 *   • a new food product sent as a DRAFT with no allergen declaration and no country of origin is KEPT as a draft: not on sale,
 *     and the reply names, in words, what it still needs; a draft still needs its category and tax class to be saved at all;
 *   • a draft whose value is there but WRONG (a nutrition panel that does not add up) is refused by name, nothing kept;
 *   • with a price at the store, the draft is NOT in the signed pack — left out with its reason (never silent);
 *   • the draft cannot be put on sale until it is complete; once complete, moving it on puts it on sale and in the next pack;
 *     every save is a new version (the draft's version stays on its stream — append-only); after a restart the same holds.
 */

const backings = r3OpsBackings();
const DAIRY = { categoryId: 'dairy', name: 'Dairy', parentId: null, regulated: ['food'] };

describe.each(backings)('an incomplete product is kept as a draft and never reaches a pack — on $name (W4 · M03-FR-01)', ({ harness, restart }) => {
  it('kept as a draft with what it still needs; never in a pack; on sale only once complete and moved on', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const { req, ok, code } = tenantClient(() => h, T);
    const today = shopDateIn(new Date().toISOString());
    await aStoreWithRules(h, T, 'u-owner', 'S1', 0);
    await ok(req('POST', '/v1/catalogue/tax-classes/04059020/rates/2017-07-01', { rateBps: 1_200 }), 'tax');
    await ok(req('POST', '/v1/catalogue/categories/dairy', DAIRY), 'category');
    const ghee = { sku: 'GHEE-500', name: 'Synthetic ghee 500 ml', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '04059020', lifecycle: 'draft', mrpHistory: [{ value: { minor: 30_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] };
    // One product already on sale, so the pack is never empty.
    await ok(req('POST', '/v1/catalogue/products/p-milk/publish', { product: { ...ghee, sku: 'MILK-1L', name: 'Synthetic milk 1 L', lifecycle: 'active', safety: { allergens: ['milk'], countryOfOrigin: 'India' } } }), 'milk');
    await ok(req('POST', '/v1/prices/list/p-milk/entries/e1', { scope: 'store', scopeRef: 'S1', priceMinor: 6_000, mrpMinor: 30_000, costMinor: 4_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), 'milk price');
    const publish = (product: unknown) => req('POST', '/v1/catalogue/products/p-ghee/publish', { product });

    // No category or no tax class: not saved, even as a draft (M03-FR-01 acceptance).
    expect(code(await publish({ ...ghee, taxClass: null }))).toBe('product_not_publishable');
    expect(code(await publish({ ...ghee, primaryCategoryId: null }))).toBe('product_not_publishable');
    // A value that is there but wrong is refused, draft or not.
    const wrong = await publish({ ...ghee, safety: { allergens: ['milk'], nutrition: { basis: 'per_100g', energyKcal: 900, proteinG: 0, carbohydrateG: 1, totalSugarsG: 50, addedSugarsG: 0, totalFatG: 99, saturatedFatG: 60, transFatG: 0, cholesterolMg: 250, sodiumMg: 0 } } });
    expect(wrong.status).toBe(422);
    expect((await req('GET', '/v1/catalogue/products/p-ghee')).status).toBe(404);

    // Incomplete: kept as a draft, with what it still needs, in words.
    const kept = await ok(publish(ghee), 'draft');
    expect(kept.body).toMatchObject({ product: { lifecycle: 'draft' }, draft: { keptAsDraft: true, onSale: false } });
    const needs = (kept.body as { draft: { stillNeeded: string[]; detail: string } }).draft;
    expect(needs.stillNeeded.join(' | ')).toMatch(/allergen.*\| .*country of origin/);
    expect(needs.detail).toMatch(/^Kept as a draft — not on sale and not in any pack\. Before it can go on sale it still needs: /);

    // A price at the store — and still the pack leaves the draft out, with its reason.
    await ok(req('POST', '/v1/prices/list/p-ghee/entries/e1', { scope: 'store', scopeRef: 'S1', priceMinor: 28_000, mrpMinor: 30_000, costMinor: 20_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), 'price');
    const preview = (await ok(req('GET', '/v1/catalogue/pack/preview', undefined, 'u-owner', { storeId: 'S1', asOf: today }), 'preview')).body as { snapshot: { products: { productId: string }[] }; excluded: { productId: string; reason: string }[] };
    expect(preview.snapshot.products.map((p) => p.productId)).not.toContain('p-ghee');
    expect(preview.excluded).toContainEqual({ productId: 'p-ghee', sku: 'GHEE-500', reason: 'draft_not_on_sale' });
    await ok(req('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: today }), 'pack');
    const pack = (await ok(req('GET', '/v1/catalogue/pack'), 'read pack')).body as { snapshot: { products: { productId: string }[] } };
    expect(pack.snapshot.products.map((p) => p.productId)).not.toContain('p-ghee');

    // It cannot go on sale while incomplete.
    expect(code(await publish({ ...ghee, lifecycle: 'active' }))).toBe('product_not_publishable');
    expect(((await req('GET', '/v1/catalogue/products/p-ghee')).body as { product: { lifecycle: string } }).product.lifecycle).toBe('draft');

    // After a restart head office still holds the draft (its own stream), and the draft is still left out.
    h = restart(h);
    expect(((await req('GET', '/v1/catalogue/products/p-ghee')).body as { product: { lifecycle: string } }).product.lifecycle).toBe('draft');

    // Completed but still sent as a draft: it STAYS a draft — completing it is not putting it on sale.
    const completeDraft = await ok(publish({ ...ghee, safety: { allergens: ['milk'], countryOfOrigin: 'India' } }), 'complete draft');
    expect(completeDraft.body).toMatchObject({ product: { lifecycle: 'draft' }, draft: { keptAsDraft: true, stillNeeded: [], detail: expect.stringMatching(/It is complete: move it to new or active/) } });

    // Moved on by a person: on sale, and in the next pack.
    const complete = { ...ghee, lifecycle: 'active', safety: { allergens: ['milk'], countryOfOrigin: 'India' } };
    const onSale = await ok(publish(complete), 'on sale');
    expect(onSale.body).toMatchObject({ product: { lifecycle: 'active' } });
    expect((onSale.body as { draft?: unknown }).draft).toBeUndefined();
    await ok(req('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: today }), 'next pack');
    const next = (await ok(req('GET', '/v1/catalogue/pack'), 'read next pack')).body as { snapshot: { products: { productId: string; unitPriceMinor: number }[] } };
    expect(next.snapshot.products.find((p) => p.productId === 'p-ghee')?.unitPriceMinor).toBe(28_000);
    // Append-only: the two drafts and the sale are three versions of one product.
    expect(((await req('GET', '/v1/catalogue/products/p-ghee')).body as { version: number }).version).toBe(3);
  });
});
