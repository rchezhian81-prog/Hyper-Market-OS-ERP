import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';

// Owner decision 2A (1 Nov 2026, in writing · hard rule 10 "conflicts visible, never last-write-wins"): a product's
// ingredients, allergens, nutrition, origin, storage and label facts are changed after publish through
// POST /v1/catalogue/products/:productId/safety, naming the version the person opened. Through the real routes, on the
// in-memory store and (with DATABASE_URL) real PostgreSQL, with a cold restart reading the same record:
//   • two people open version N; the first saves → N+1; the second is refused 409 product_changed_meanwhile and the record
//     keeps the first person's change;
//   • a save with no reason is refused; the allergen rule still holds; a manager (no catalogue.pack.publish) is refused.

const backings = useRestartableBackings();
const FOOD = { categoryId: 'food', name: 'Food', parentId: null, regulated: ['food'] };
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const post = (h: ApiHarness, T: string, path: string, body: unknown, userId = 'u-owner') =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: `k-${randomUUID()}`, body });
const get = (h: ApiHarness, T: string, path: string, userId = 'u-owner') => h.request({ method: 'GET', path, userId, tenantId: T });
type Read = { product: { name: string; safety: { allergens?: string[]; storageConditions?: string; ingredients?: string } }; version: number };

describe.each(backings)('owner 2A — a safety save never overwrites a newer edit — on $name', ({ harness }) => {
  it('two people open the same version: the first saves, the second is refused and nothing of theirs is kept', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionOwner(T, 'u-owner-2');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const product = { sku: 'SKU-DAL', name: 'Toor dal 1kg', baseUom: 'ea', primaryCategoryId: 'food', taxClass: '0713', lifecycle: 'active', safety: { allergens: [], countryOfOrigin: 'India', storageConditions: 'cool and dry' } };
    expect((await post(h, T, '/v1/catalogue/products/dal/publish', { product, categories: [FOOD] })).status).toBe(201);

    // Both open the page: the same version.
    const first = (await get(h, T, '/v1/catalogue/products/dal')).body as Read;
    const second = (await get(h, T, '/v1/catalogue/products/dal', 'u-owner-2')).body as Read;
    expect(first.version).toBe(1);
    expect(second.version).toBe(1);

    const one = await post(h, T, '/v1/catalogue/products/dal/safety', { expectedVersion: first.version, safety: { ...first.product.safety, allergens: ['mustard'], ingredients: 'pigeon peas, mustard oil' }, reason: 'new supplier label (synthetic)' });
    expect(one.status).toBe(201);
    expect((one.body as { version: number }).version).toBe(2);

    const two = await post(h, T, '/v1/catalogue/products/dal/safety', { expectedVersion: second.version, safety: { ...second.product.safety, storageConditions: 'refrigerate' }, reason: 'my own edit (synthetic)' }, 'u-owner-2');
    expect(two.status).toBe(409);
    expect(codeOf(two)).toBe('product_changed_meanwhile');
    expect((two.body as { error: { whatHappened: string; wasItSaved: string } }).error).toMatchObject({ wasItSaved: 'not_saved' });

    // Cold restart: the record is the first person's, at version 2.
    const again = harness(h);
    const now = (await get(again, T, '/v1/catalogue/products/dal')).body as Read;
    expect(now.version).toBe(2);
    expect(now.product.safety).toMatchObject({ allergens: ['mustard'], ingredients: 'pigeon peas, mustard oil', storageConditions: 'cool and dry' });

    // A missing reason, a missing allergen declaration, and a person without the right: each refused, nothing kept.
    expect(codeOf(await post(again, T, '/v1/catalogue/products/dal/safety', { expectedVersion: 2, safety: { ...now.product.safety, storageConditions: 'refrigerate' } }))).toBe('not_readable_as_a_safety_save');
    const noAllergens = { ...now.product.safety } as Record<string, unknown>;
    delete noAllergens['allergens'];
    expect(codeOf(await post(again, T, '/v1/catalogue/products/dal/safety', { expectedVersion: 2, safety: noAllergens, reason: 'dropping allergens (synthetic)' }))).toBe('product_not_publishable');
    expect((await post(again, T, '/v1/catalogue/products/dal/safety', { expectedVersion: 2, safety: now.product.safety, reason: 'manager (synthetic)' }, 'u-mgr')).status).toBe(403);
    expect(((await get(again, T, '/v1/catalogue/products/dal')).body as Read).version).toBe(2);

    // The second person reloads (version 2) and makes the change again: it lands, keeping the first person's allergens.
    const retry = await post(again, T, '/v1/catalogue/products/dal/safety', { expectedVersion: 2, safety: { ...now.product.safety, storageConditions: 'refrigerate' }, reason: 'my own edit, after reloading (synthetic)' }, 'u-owner-2');
    expect(retry.status).toBe(201);
    expect(((await get(again, T, '/v1/catalogue/products/dal')).body as Read).product.safety).toMatchObject({ allergens: ['mustard'], storageConditions: 'refrigerate' });
  }, 120_000);
});
