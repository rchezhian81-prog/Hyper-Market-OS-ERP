import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { productMasterAdapter } from '../../services/api/src/adapters';
import { productMasterRoutes } from '../../services/catalogue/src/product-master';
import type { StoredCategory } from '../../services/catalogue/src/categories';
import type { ApiError, RequestContext, Route } from '../../services/kernel/src/index';
import type { ProductRecord } from '../../packages/product/src/index';

// Owner decision 2A (1 Nov 2026, in writing · hard rule 10): a product's safety and label facts are edited after publish
// through their OWN save, which names the version the person opened and is refused — nothing written — when someone else
// saved the product since. The version is the count of the product's published versions. The safety save runs the very
// same rules as the full publish (allergens, OB-307 nutrition, liquor and medicine refused, OB-503 second person).

const T = 'tenant-safety-unit';
const now = () => '2026-11-01T06:00:00.000Z';
const cat = (categoryId: string, regulated: readonly string[] = []): StoredCategory =>
  ({ categoryId, name: categoryId, parentId: null, regulated, version: 1, definedBy: 'u-owner', approvedBy: 'u-owner', definedAt: now(), source: 'test' }) as unknown as StoredCategory;
const CATS = [cat('food', ['food']), cat('home')];

function rig() {
  const store = new InMemoryEventStore();
  const adapter = productMasterAdapter({ store, now });
  const routes = productMasterRoutes({ ...adapter, now, categoryRegister: { categories: () => CATS, define: () => {}, permissionsOfUser: () => undefined, now } });
  const route = (method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
  let n = 0;
  const call = async (method: 'GET' | 'POST', path: string, productId: string, body?: unknown, key?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const ctx: RequestContext = { tenantId: T, userId: 'u-owner', branchId: null, params: { productId }, query: {}, body, traceId: 't', ...(method === 'POST' ? { idempotencyKey: key ?? `k-${(n += 1)}` } : {}) };
    try {
      const r = await route(method, path).handler(ctx);
      return { status: r.status, body: r.body as Record<string, unknown> };
    } catch (e) {
      const err = e as ApiError;
      if (typeof err.status !== 'number') throw e;
      return { status: err.status, body: { error: err.body } };
    }
  };
  const publish = (id: string, product: Record<string, unknown>, key?: string) => call('POST', '/v1/catalogue/products/:productId/publish', id, { product }, key);
  const read = (id: string) => call('GET', '/v1/catalogue/products/:productId', id);
  const safety = (id: string, body: Record<string, unknown>) => call('POST', '/v1/catalogue/products/:productId/safety', id, body);
  return { store, adapter, publish, read, safety };
}
const dal = (safety: Record<string, unknown> = {}) => ({
  sku: 'SKU-DAL', name: 'Toor dal 1kg', baseUom: 'ea', primaryCategoryId: 'food', taxClass: '0713', lifecycle: 'active',
  safety: { allergens: [], countryOfOrigin: 'India', storageConditions: 'cool and dry', ...safety },
});
const code = (r: { body: Record<string, unknown> }) => (r.body['error'] as { code?: string } | undefined)?.code;

describe('the product version — the count of its published versions', () => {
  it('is 0 before any publish, 1 after the first, 2 after the next; a retry of the same publish is not a new version', async () => {
    const { adapter, publish, read } = rig();
    expect(await adapter.productVersion!(T, 'dal')).toBe(0);
    expect((await publish('dal', dal(), 'first')).status).toBe(201);
    expect(await adapter.productVersion!(T, 'dal')).toBe(1);
    expect((await publish('dal', dal(), 'first')).status).toBe(201); // the same key: deduplicated
    expect(await adapter.productVersion!(T, 'dal')).toBe(1);
    expect((await publish('dal', { ...dal(), name: 'Toor dal 1 kg' }, 'second')).status).toBe(201);
    expect(await adapter.productVersion!(T, 'dal')).toBe(2);
    expect(await adapter.productVersion!(T, 'other')).toBe(0);
    // Read beside the record; the stored record itself carries no version field.
    const r = await read('dal');
    expect(r.body['version']).toBe(2);
    expect((r.body['product'] as Record<string, unknown>)['version']).toBeUndefined();
  });
});

describe('the safety save (owner 2A): the version the person opened, then the publish rules, then the write', () => {
  it('replaces ONLY the safety facts, names the new version, and keeps everything else as head office holds it', async () => {
    const { publish, safety, read } = rig();
    await publish('dal', { ...dal(), brand: 'Synthetic', mrpHistory: [{ value: { minor: 15_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] });
    const out = await safety('dal', { expectedVersion: 1, safety: { allergens: ['mustard'], countryOfOrigin: 'India', storageConditions: 'cool and dry', ingredients: 'pigeon peas' }, reason: 'label reprint (synthetic)' });
    expect(out.status).toBe(201);
    expect(out.body['version']).toBe(2);
    const held = (await read('dal')).body['product'] as ProductRecord;
    expect(held.safety).toMatchObject({ allergens: ['mustard'], ingredients: 'pigeon peas' });
    expect(held).toMatchObject({ name: 'Toor dal 1kg', brand: 'Synthetic', sku: 'SKU-DAL', taxClass: '0713', mrpHistory: [{ value: { minor: 15_000 }, effectiveFrom: '2026-01-01' }] });
  });

  it('is refused 409 product_changed_meanwhile when the version is not the one held — nothing written', async () => {
    const { publish, safety, adapter } = rig();
    await publish('dal', dal());
    await publish('dal', { ...dal(), name: 'Toor dal (renamed)' });
    const out = await safety('dal', { expectedVersion: 1, safety: { allergens: ['sesame'], countryOfOrigin: 'India' }, reason: 'stale screen' });
    expect(out.status).toBe(409);
    expect(code(out)).toBe('product_changed_meanwhile');
    expect((out.body['error'] as { whatHappened: string }).whatHappened).toMatch(/someone else saved this product since you opened it/i);
    expect((out.body['error'] as { wasItSaved: string }).wasItSaved).toBe('not_saved');
    expect(await adapter.productVersion!(T, 'dal')).toBe(2);
  });

  it('needs a reason, a version and a safety object; a product never published is not found', async () => {
    const { publish, safety } = rig();
    await publish('dal', dal());
    expect(code(await safety('dal', { expectedVersion: 1, safety: { allergens: [] } }))).toBe('not_readable_as_a_safety_save');
    expect(code(await safety('dal', { expectedVersion: 1, safety: { allergens: [] }, reason: '   ' }))).toBe('not_readable_as_a_safety_save');
    expect(code(await safety('dal', { safety: { allergens: [] }, reason: 'x' }))).toBe('not_readable_as_a_safety_save');
    expect(code(await safety('dal', { expectedVersion: 1, reason: 'x' }))).toBe('not_readable_as_a_safety_save');
    expect((await safety('nobody', { expectedVersion: 1, safety: {}, reason: 'x' })).status).toBe(404);
  });

  it('refuses whatever the publish refuses — allergens, OB-307 nutrition, liquor, medicine, an unreadable age, a new age limit without a second person', async () => {
    const { publish, safety, adapter } = rig();
    await publish('dal', dal());
    const tryIt = (s: Record<string, unknown>) => safety('dal', { expectedVersion: 1, safety: s, reason: 'trying (synthetic)' });
    const noAllergens = await tryIt({ countryOfOrigin: 'India' });
    expect(code(noAllergens)).toBe('product_not_publishable');
    expect((noAllergens.body['error'] as { whatHappened: string }).whatHappened).toMatch(/allergen/i);
    const noPanel = await tryIt({ allergens: [], countryOfOrigin: 'India', packedBySre: true });
    expect(code(noPanel)).toBe('product_not_publishable');
    expect((noPanel.body['error'] as { whatHappened: string }).whatHappened).toMatch(/nutrition/i);
    expect(code(await tryIt({ allergens: [], countryOfOrigin: 'India', liquor: true }))).toBe('liquor_not_sold');
    expect(code(await tryIt({ allergens: [], countryOfOrigin: 'India', medicine: true }))).toBe('medicine_not_sold');
    expect(code(await tryIt({ allergens: [], countryOfOrigin: 'India', minimumAge: 'eighteen' }))).toBe('not_readable_as_a_product');
    expect(code(await tryIt({ allergens: [], countryOfOrigin: 'India', minimumAge: 18 }))).toBe('regulated_product_needs_second_person');
    // The same body through the full publish meets the same refusals.
    expect(code(await publish('dal', dal({ allergens: undefined })))).toBe('product_not_publishable');
    expect(code(await publish('dal', dal({ liquor: true })))).toBe('liquor_not_sold');
    expect(await adapter.productVersion!(T, 'dal')).toBe(1);
  });

  it('two safety saves racing on the same version: exactly one lands, the other is refused 409 and nothing of it is kept', async () => {
    const { publish, safety, read } = rig();
    await publish('dal', dal());
    const [a, b] = await Promise.all([
      safety('dal', { expectedVersion: 1, safety: { allergens: ['mustard'], countryOfOrigin: 'India' }, reason: 'first person' }),
      safety('dal', { expectedVersion: 1, safety: { allergens: ['sesame'], countryOfOrigin: 'India' }, reason: 'second person' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? ['mustard'] : ['sesame'];
    const r = await read('dal');
    expect(r.body['version']).toBe(2);
    expect((r.body['product'] as ProductRecord).safety?.allergens).toEqual(winner);
  });
});
