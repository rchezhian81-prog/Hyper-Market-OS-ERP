import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { productMasterAdapter } from '../../services/api/src/adapters';
import { productMasterRoutes } from '../../services/catalogue/src/product-master';
import { scanAndGoRoutes, type ScanAndGoDeps } from '../../services/orders/src/storefront-scan-and-go';
import type { StoredCategory } from '../../services/catalogue/src/categories';
import type { ApiError, RequestContext, Route } from '../../services/kernel/src/index';
import type { AuditEntry } from '../../packages/audit/src/index';
import {
  LABEL_FACT_KEYS, LABEL_FACTS_MAY_FOLLOW_IN, labelFactsMayFollow, missingLabelFacts, outstandingLabelFacts, validateProduct,
  type Category, type ProductRecord,
} from '../../packages/product/src/index';
import { LABEL_FACTS, PILOT_CATEGORY_ID } from '../../packages/migration/src/bpal-slice';
import { checkOnlineListing, type OnlineListingFacts, type OnlineShopDetails } from '../../packages/storefront/src/listing-duties';

// OB-733 (owner, 14 Nov 2026, in writing "1A", replacing OB-696; recorded on its branch as OB-730) and option A of the same
// day ("sell at the till only"): a packaged-groceries item may be LOADED from the old ERP before staff have read its five
// label facts off the pack. The facts stay REQUIRED TO BE KEPT (M03-FR-03): every loaded item still missing one is listed
// until filled (P-03 · P-08); blank allergens are never "none"; the item sells at the till (the customer holds the printed
// pack) but never online or by scan-and-go until all five are read. Every other department, and every product made on a
// screen, keeps the full rule. Made-up data only.

const T = 'tenant-ob733-unit';
const now = () => '2026-11-14T06:00:00.000Z';
const cat = (categoryId: string, regulated: readonly string[]): StoredCategory =>
  ({ categoryId, name: categoryId, parentId: null, regulated, version: 1, definedBy: 'u-owner', approvedBy: 'u-owner', definedAt: now(), source: 'test' }) as unknown as StoredCategory;
const CATS = [cat(LABEL_FACTS_MAY_FOLLOW_IN, ['food', 'packed']), cat('chilled-dairy', ['food', 'packed'])];
const PERMS: Record<string, readonly string[]> = {
  'u-owner': ['catalogue.pack.publish', 'migration.load.record'],
  'u-publisher': ['catalogue.pack.publish'], // may publish, does not run the old-system load
  'u-manager': ['catalogue.pack.read', 'migration.load.record'],
};

function rig() {
  const store = new InMemoryEventStore();
  const audit: AuditEntry[] = [];
  const adapter = productMasterAdapter({ store, now });
  const routes = productMasterRoutes({
    ...adapter, now, recordAudit: (_t, e) => { audit.push(e); },
    categoryRegister: { categories: () => CATS, define: () => {}, permissionsOfUser: (_t, u) => PERMS[u], now },
  });
  const route = (method: string, path: string): Route => routes.find((r) => r.method === method && r.path === path)!;
  let n = 0;
  const call = async (method: 'GET' | 'POST', path: string, productId: string, body?: unknown, userId = 'u-owner'): Promise<{ status: number; body: Record<string, unknown> }> => {
    const ctx: RequestContext = { tenantId: T, userId, branchId: null, params: { productId }, query: {}, body, traceId: 't', ...(method === 'POST' ? { idempotencyKey: `k-${(n += 1)}` } : {}) };
    try {
      const r = await route(method, path).handler(ctx);
      return { status: r.status, body: r.body as Record<string, unknown> };
    } catch (e) {
      const err = e as ApiError;
      if (typeof err.status !== 'number') throw e;
      return { status: err.status, body: { error: err.body } };
    }
  };
  const publish = (id: string, product: Record<string, unknown>, extra: Record<string, unknown> = {}, userId = 'u-owner') =>
    call('POST', '/v1/catalogue/products/:productId/publish', id, { product, ...extra }, userId);
  const read = async (id: string) => (await call('GET', '/v1/catalogue/products/:productId', id)).body as { product: ProductRecord; version: number };
  const outstanding = async () => (await call('GET', '/v1/catalogue/label-facts-outstanding', '')).body as { items: { productId: string; facts: string[]; loadId: string; loadedBy: string }[]; count: number; detail: string };
  const fill = (id: string, body: Record<string, unknown>, userId = 'u-manager') => call('POST', '/v1/catalogue/products/:productId/label-facts', id, body, userId);
  const safety = (id: string, body: Record<string, unknown>) => call('POST', '/v1/catalogue/products/:productId/safety', id, body);
  return { audit, publish, read, outstanding, fill, safety };
}
const oil = (safety: Record<string, unknown> = {}, categoryId = LABEL_FACTS_MAY_FOLLOW_IN) => ({
  sku: 'SKU-OIL', name: 'Test sunflower oil 1L', baseUom: 'pcs', primaryCategoryId: categoryId, taxClass: '15121110', lifecycle: 'active',
  ...(Object.keys(safety).length === 0 ? {} : { safety }),
});
const FOLLOW = { labelFactsFollow: { loadId: 'bpal-20261114-load-1' } };
const ALL_FIVE = { allergens: [], countryOfOrigin: 'India', netQuantity: '1 L', packerDetails: 'Test Oils, Erode', consumerCareContact: 'care@testoils.example' };
const code = (r: { body: Record<string, unknown> }) => (r.body['error'] as { code?: string } | undefined)?.code;

describe('the product rule (packages/product): which items may have their label facts follow', () => {
  const grocery: Category = { categoryId: LABEL_FACTS_MAY_FOLLOW_IN, name: 'Packaged groceries', parentId: null, regulated: ['food', 'packed'] };
  const dairy: Category = { categoryId: 'chilled-dairy', name: 'Chilled dairy', parentId: null, regulated: ['food', 'packed'] };
  const record = (over: Partial<ProductRecord> = {}): ProductRecord => ({
    productId: 'p1', tenantId: T, sku: 'P1', name: 'Test oil', baseUom: 'pcs', primaryCategoryId: LABEL_FACTS_MAY_FOLLOW_IN, taxClass: '15121110', lifecycle: 'active', ...over,
  });
  const MARK = { decision: 'OB-733', loadId: 'l1', markedBy: 'u-owner', markedAt: now() } as const;

  it('pins its words to the import\'s: the one department is the pilot department, and the five facts are the same five', () => {
    expect(LABEL_FACTS_MAY_FOLLOW_IN).toBe(PILOT_CATEGORY_ID);
    expect([...LABEL_FACT_KEYS]).toEqual([...LABEL_FACTS]);
  });

  it('without the mark, a food item with no facts is blocked from publish — M03-FR-03 as the roadmap writes it', () => {
    const v = validateProduct(record(), [grocery]);
    expect(v.publishable).toBe(false);
    expect(v.issues.filter((i) => i.severity === 'blocks_publish').map((i) => i.field).sort()).toEqual(
      ['safety.allergens', 'safety.consumerCareContact', 'safety.countryOfOrigin', 'safety.netQuantity', 'safety.packerDetails']);
  });

  it('with the mark, in packaged groceries: publishable, every missing fact still said — as "not yet read", never dropped', () => {
    const v = validateProduct(record({ labelFactsFollow: MARK }), [grocery]);
    expect(v.publishable).toBe(true);
    const later = v.issues.filter((i) => i.message.startsWith('label fact not yet read off the pack (OB-733'));
    expect(later.map((i) => i.severity)).toEqual(['advisory', 'advisory', 'advisory', 'advisory', 'advisory']);
    expect(outstandingLabelFacts(record({ labelFactsFollow: MARK }))).toEqual(['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
  });

  it('the mark does nothing in any other department — the full rule applies there', () => {
    const p = record({ primaryCategoryId: 'chilled-dairy', labelFactsFollow: MARK });
    expect(labelFactsMayFollow(p)).toBe(false);
    expect(validateProduct(p, [dairy]).publishable).toBe(false);
  });

  it('allergens: an empty list is the declaration "none"; undefined is "not read yet" — never the same thing', () => {
    expect(missingLabelFacts({ safety: { allergens: [] } })).not.toContain('allergens');
    expect(missingLabelFacts({ safety: {} })).toContain('allergens');
    expect(missingLabelFacts({ safety: { countryOfOrigin: '  ' } })).toContain('country_of_origin');
    expect(outstandingLabelFacts(record({ safety: ALL_FIVE }))).toEqual([]); // no mark: never on the list
    expect(outstandingLabelFacts(record({ safety: ALL_FIVE, labelFactsFollow: MARK }))).toEqual([]);
  });
});

describe('head office: the mark is set by the load, listed until filled, filled later by the people who run the load', () => {
  it('a load\'s first publish with blank facts goes on sale (at the till), is said in the reply, listed and audited', async () => {
    const { publish, read, outstanding, audit } = rig();
    const out = await publish('oil', oil(), FOLLOW);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body['labelFactsOutstanding']).toMatchObject({ facts: ['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care'], onSaleAtTheTill: true, soldOnline: false });
    const held = (await read('oil')).product;
    expect(held.lifecycle).toBe('active');
    expect(held.safety?.allergens).toBeUndefined();
    expect(held.labelFactsFollow).toEqual({ decision: 'OB-733', loadId: 'bpal-20261114-load-1', markedBy: 'u-owner', markedAt: now() });
    const list = await outstanding();
    expect(list.items).toEqual([{ productId: 'oil', name: 'Test sunflower oil 1L', lifecycle: 'active', facts: ['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care'], loadId: 'bpal-20261114-load-1', loadedBy: 'u-owner', loadedAt: now() }]);
    expect(audit.find((a) => a.action === 'catalogue.product.label_facts.follow')).toMatchObject({ actorId: 'u-owner', objectId: 'oil' });
  });

  it('the mark is never taken from the body\'s product; without the load\'s request the full rule refuses it', async () => {
    const { publish } = rig();
    const sneaky = await publish('oil', { ...oil(), labelFactsFollow: { decision: 'OB-733', loadId: 'x', markedBy: 'x', markedAt: 'x' } });
    expect(sneaky.status).toBe(422);
    expect(code(sneaky)).toBe('product_not_publishable');
  });

  it('refused by name: another department, someone who does not run the load, an item already on sale, an unreadable load id', async () => {
    const { publish } = rig();
    const dairy = await publish('curd', { ...oil({}, 'chilled-dairy'), sku: 'SKU-CURD' }, FOLLOW);
    expect([dairy.status, code(dairy)]).toEqual([422, 'label_facts_follow_not_this_department']);
    const notTheLoad = await publish('oil', oil(), FOLLOW, 'u-publisher');
    expect([notTheLoad.status, code(notTheLoad)]).toEqual([403, 'label_facts_follow_is_the_load']);
    const unreadable = await publish('oil', oil(), { labelFactsFollow: { loadId: 'has spaces!' } });
    expect([unreadable.status, code(unreadable)]).toEqual([400, 'not_readable_as_label_facts_follow']);
    expect((await publish('rice', { ...oil(ALL_FIVE), sku: 'SKU-RICE' })).status).toBe(201); // on sale with all five facts
    const late = await publish('rice', { ...oil({}), sku: 'SKU-RICE' }, FOLLOW);
    expect([late.status, code(late)]).toEqual([422, 'label_facts_follow_only_on_first_load']);
  });

  it('the manager fills the facts later, some now and the rest later; each save is a new version, audited with the reason; the item leaves the list at the fifth', async () => {
    const { publish, read, outstanding, fill, audit } = rig();
    await publish('oil', oil(), FOLLOW);
    const first = await fill('oil', { expectedVersion: 1, facts: { allergens: [], countryOfOrigin: 'India' }, reason: 'read off the pack' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body['version']).toBe(2);
    expect((first.body['labelFactsOutstanding'] as { facts: string[] }).facts).toEqual(['net_quantity', 'packer', 'consumer_care']);
    expect((await outstanding()).items.map((x) => x.facts)).toEqual([['net_quantity', 'packer', 'consumer_care']]);
    const rest = await fill('oil', { expectedVersion: 2, facts: { netQuantity: '1 L', packerDetails: 'Test Oils, Erode', consumerCareContact: 'care@testoils.example' }, reason: 'read off the pack' });
    expect(rest.status).toBe(201);
    expect(rest.body['labelFactsOutstanding']).toBeUndefined();
    const held = (await read('oil')).product;
    expect(held.safety).toEqual(ALL_FIVE);
    expect(held.labelFactsFollow).toBeUndefined(); // complete: the full rule from now on
    expect(held).toMatchObject({ name: 'Test sunflower oil 1L', taxClass: '15121110', lifecycle: 'active' }); // nothing else touched
    expect(await outstanding()).toMatchObject({ items: [], count: 0, detail: 'No item is on sale with label facts still to read.' });
    expect(audit.filter((a) => a.action === 'catalogue.product.label_facts.save').map((a) => [a.actorId, a.reason])).toEqual([['u-manager', 'read off the pack'], ['u-manager', 'read off the pack']]);
    expect(audit.find((a) => a.action === 'catalogue.product.label_facts.complete')).toMatchObject({ actorId: 'u-manager', objectId: 'oil' });
  });

  it('the label-facts save is narrow: only the five facts, only an item still on the list, the version opened, never a blank', async () => {
    const { publish, fill } = rig();
    await publish('oil', oil(), FOLLOW);
    const price = await fill('oil', { expectedVersion: 1, facts: { countryOfOrigin: 'India', minimumAge: 18 }, reason: 'x' });
    expect([price.status, code(price)]).toEqual([400, 'not_readable_as_a_safety_save']);
    const blank = await fill('oil', { expectedVersion: 1, facts: { countryOfOrigin: '  ' }, reason: 'x' });
    expect(blank.status).toBe(400);
    const allergenWords = await fill('oil', { expectedVersion: 1, facts: { allergens: 'none' }, reason: 'x' });
    expect(allergenWords.status).toBe(400); // "none" is the empty list, said as a list
    const stale = await fill('oil', { expectedVersion: 7, facts: { countryOfOrigin: 'India' }, reason: 'x' });
    expect([stale.status, code(stale)]).toEqual([409, 'product_changed_meanwhile']);
    const noReason = await fill('oil', { expectedVersion: 1, facts: { countryOfOrigin: 'India' } });
    expect(noReason.status).toBe(400);
    await publish('rice', { ...oil(ALL_FIVE), sku: 'SKU-RICE' });
    const done = await fill('rice', { expectedVersion: 1, facts: { countryOfOrigin: 'Nepal' }, reason: 'x' });
    expect([done.status, code(done)]).toEqual([409, 'not_waiting_for_label_facts']);
  });

  it('a fact once read is corrected, never blanked — even through the full safety save', async () => {
    const { publish, fill, safety } = rig();
    await publish('oil', oil(), FOLLOW);
    await fill('oil', { expectedVersion: 1, facts: { countryOfOrigin: 'India' }, reason: 'read off the pack' });
    const unread = await safety('oil', { expectedVersion: 2, safety: { allergens: [] }, reason: 'oops' });
    expect([unread.status, code(unread)]).toEqual([422, 'label_fact_cannot_be_unread']);
    const corrected = await safety('oil', { expectedVersion: 2, safety: { countryOfOrigin: 'Sri Lanka' }, reason: 'misread' });
    expect(corrected.status).toBe(201);
  });
});

describe('sold at the till only: never listed online, never in a phone basket, while a fact is still to read', () => {
  const shop: OnlineShopDetails = { version: 1, legalName: 'Test Shop', address: '1 Test Road', gstin: '33ABCDE1234F1Z5', returnTerms: '7 days', grievanceOfficerName: 'Test Officer', grievanceOfficerContact: 'grievance@test.example', setBy: 'u-owner', setAt: now() } as unknown as OnlineShopDetails;
  const facts = (over: Partial<OnlineListingFacts> = {}): OnlineListingFacts => ({
    productId: 'oil', name: 'Test oil', mrpMinor: 20_000, sellingPriceMinor: 18_000, taxRateBps: 500, carriesDate: false, countryOfOrigin: 'India', seller: { own: true }, ...over,
  });

  it('the online listing is refused by name while any label fact is still to read; complete, it may be listed', () => {
    const refused = checkOnlineListing(facts({ labelFactsOutstanding: ['allergens'] }), shop, { deliveryFeeMinor: 3_000 });
    expect(refused).toMatchObject({ publishable: false, refusal: 'online listing incomplete: label facts read off the pack' });
    expect(checkOnlineListing(facts(), shop, { deliveryFeeMinor: 3_000 }).publishable).toBe(true);
  });

  it('a phone basket with such an item is refused, nothing kept; the cashier scans it at the till', async () => {
    const kept: unknown[] = [];
    const deps: ScanAndGoDeps = {
      pack: async () => ({ version: 1, products: [{ productId: 'oil', name: 'Test oil', baseUom: 'pcs', unitPriceMinor: 18_000 }, { productId: 'rice', name: 'Test rice', baseUom: 'pcs', unitPriceMinor: 7_000 }], barcodes: [{ code: '8901234567937', productId: 'oil', kind: 'standard' }, { code: '8901234567890', productId: 'rice', kind: 'standard' }] }),
      labelFactsOutstanding: async (_t, id) => (id === 'oil' ? ['packer'] : []),
      basket: async () => undefined, recalls: async () => [], basketsOf: async () => [],
      recordBasket: async (_t, b) => { kept.push(b); }, recordRecall: async () => {}, randomInt: () => 123_456, now,
    };
    const route = scanAndGoRoutes(deps).find((r) => r.method === 'POST')!;
    const ctx = (lines: unknown): RequestContext => ({ tenantId: T, userId: 'cust-1', branchId: null, params: { basketId: 'basket-001' }, query: {}, body: { lines }, traceId: 't', idempotencyKey: 'k' });
    const refused = await Promise.resolve(route.handler(ctx([{ productId: 'oil', quantityMinor: 1 }, { productId: 'rice', quantityMinor: 2 }]))).catch((e: ApiError) => e);
    expect((refused as ApiError).status).toBe(422);
    expect((refused as ApiError).body).toMatchObject({ code: 'not_for_scan_and_go', refused: [{ productId: 'oil', why: 'label_facts_not_yet_read' }] });
    expect(JSON.stringify((refused as ApiError).body)).toContain('sold at the till only');
    expect(kept).toEqual([]);
    const ok = await route.handler(ctx([{ productId: 'rice', quantityMinor: 2 }]));
    expect(ok.status).toBe(201);
  });
});
