import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { productMasterAdapter } from '../../services/api/src/adapters';
import { productMasterRoutes } from '../../services/catalogue/src/product-master';
import { scanAndGoRoutes, type ScanAndGoDeps } from '../../services/orders/src/storefront-scan-and-go';
import type { StoredCategory } from '../../services/catalogue/src/categories';
import type { ApiError, RequestContext, Route } from '../../services/kernel/src/index';
import {
  labelFactsMayFollow, labelFactsMayFollowInCategory, labelFactsNeededFor, outstandingLabelFacts, validateProduct, type Category, type ProductRecord,
} from '../../packages/product/src/index';
import { STORE_DEPARTMENTS, labelFactsMayFollowIn, storeDepartment } from '../../packages/migration/src/bpal-slice';
import { checkOnlineListing, type OnlineListingFacts, type OnlineShopDetails } from '../../packages/storefront/src/listing-duties';

// OB-811 B (owner, 16 Nov 2026, in writing): OB-738's "sell at the till only" reaches EVERY packed good — household,
// personal care, dairy and other packed foods, as well as packaged groceries. The label facts are printed on the pack the
// customer holds at the till; the item is kept off online and scan-and-go and listed until staff type them in. Loose
// foods have no pack: they still need their allergens and origin before they sell anywhere. Made-up data only.

const T = 'tenant-ob811-unit';
const now = () => '2026-11-16T06:00:00.000Z';
const cat = (d: { categoryId: string; regulated: readonly string[] }): StoredCategory =>
  ({ categoryId: d.categoryId, name: d.categoryId, parentId: null, regulated: d.regulated, version: 1, definedBy: 'u-owner', approvedBy: 'u-owner', definedAt: now(), source: 'test' }) as unknown as StoredCategory;
const CATS = STORE_DEPARTMENTS.map(cat);
const PERMS: Record<string, readonly string[]> = { 'u-owner': ['catalogue.pack.publish', 'migration.load.record'], 'u-manager': ['catalogue.pack.read', 'migration.load.record'] };
const FOLLOW = { labelFactsFollow: { loadId: 'bpal-20261116-load-1' } };
const PACKED_FOUR = { countryOfOrigin: 'India', netQuantity: '1 kg', packerDetails: 'Test Home Care, Chennai', consumerCareContact: 'care@testhome.example' };

function rig() {
  const store = new InMemoryEventStore();
  const routes = productMasterRoutes({
    ...productMasterAdapter({ store, now }), now, recordAudit: () => {},
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
  return {
    publish: (id: string, product: Record<string, unknown>, extra: Record<string, unknown> = {}) => call('POST', '/v1/catalogue/products/:productId/publish', id, { product, ...extra }),
    read: async (id: string) => (await call('GET', '/v1/catalogue/products/:productId', id)).body as { product: ProductRecord; version: number },
    outstanding: async () => ((await call('GET', '/v1/catalogue/label-facts-outstanding', '')).body as { items: { productId: string; facts: string[] }[] }).items,
    fill: (id: string, body: Record<string, unknown>) => call('POST', '/v1/catalogue/products/:productId/label-facts', id, body, 'u-manager'),
  };
}
const item = (sku: string, categoryId: string, hsn: string, safety: Record<string, unknown> = {}) => ({
  sku, name: `Test ${sku}`, baseUom: 'pcs', primaryCategoryId: categoryId, taxClass: hsn, lifecycle: 'active', ...(Object.keys(safety).length === 0 ? {} : { safety }),
});
const code = (r: { body: Record<string, unknown> }) => (r.body['error'] as { code?: string } | undefined)?.code;

describe('OB-811 B: which departments may load before their label facts are read', () => {
  it('every packed-goods department of the load table, and no loose one — read off the table\'s own "packed" column', () => {
    expect(STORE_DEPARTMENTS.filter(labelFactsMayFollowIn).map((d) => d.categoryId)).toEqual(['packaged-groceries', 'other-packaged-foods', 'personal-care', 'household-general']);
    for (const id of ['packaged-groceries', 'other-packaged-foods', 'personal-care', 'household-general']) expect(labelFactsMayFollowInCategory(id)).toBe(true);
    for (const id of ['loose-foods', 'loose-general', 'chilled-dairy', '', null, undefined]) expect(labelFactsMayFollowInCategory(id)).toBe(false);
  });

  it('a packed non-food is asked the four facts its pack carries — never allergens; a packed food all five', () => {
    expect(labelFactsNeededFor('household-general')).toEqual(['country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
    expect(labelFactsNeededFor('personal-care')).toEqual(['country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
    expect(labelFactsNeededFor('other-packaged-foods')).toEqual(['allergens', 'country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
  });

  it('the product rule: a marked household item is publishable with every missing fact still said as "not yet read"; a marked loose food is not', () => {
    const MARK = { decision: 'OB-738', loadId: 'l1', markedBy: 'u-owner', markedAt: now() } as const;
    const household: Category = { categoryId: 'household-general', name: 'Household', parentId: null, regulated: ['packed'] };
    const loose: Category = { categoryId: 'loose-foods', name: 'Loose foods', parentId: null, regulated: ['food'] };
    const rec = (over: Partial<ProductRecord>): ProductRecord => ({ productId: 'p', tenantId: T, sku: 'P', name: 'Test', baseUom: 'pcs', primaryCategoryId: 'household-general', taxClass: '34022010', lifecycle: 'active', ...over });
    const det = rec({ labelFactsFollow: MARK });
    expect(labelFactsMayFollow(det)).toBe(true);
    const v = validateProduct(det, [household]);
    expect(v.publishable).toBe(true);
    expect(v.issues.filter((i) => i.message.startsWith('label fact not yet read off the pack')).map((i) => i.severity).every((s) => s === 'advisory')).toBe(true);
    expect(outstandingLabelFacts(det)).toEqual(['country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
    expect(validateProduct(rec({ labelFactsFollow: MARK }), [household]).publishable).toBe(true);
    const dal = rec({ primaryCategoryId: 'loose-foods', taxClass: '07133100', baseUom: 'kg', labelFactsFollow: MARK });
    expect(labelFactsMayFollow(dal)).toBe(false);
    expect(validateProduct(dal, [loose]).publishable).toBe(false); // allergens and origin first
    expect(validateProduct(rec({ labelFactsFollow: MARK }), [household]).publishable).toBe(validateProduct(det, [household]).publishable);
  });
});

describe('OB-811 B at head office: loaded, sold at the till, listed, filled; loose foods still refused', () => {
  it('a packed household item from the load goes on sale (at the till only), is listed with its four facts, and leaves the list when they are typed', async () => {
    const { publish, read, outstanding, fill } = rig();
    const out = await publish('det', item('DET', 'household-general', '34022010'), FOLLOW);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body['labelFactsOutstanding']).toMatchObject({ facts: ['country_of_origin', 'net_quantity', 'packer', 'consumer_care'], onSaleAtTheTill: true, soldOnline: false });
    expect((await read('det')).product).toMatchObject({ lifecycle: 'active', labelFactsFollow: { decision: 'OB-738', loadId: 'bpal-20261116-load-1' } });
    expect((await outstanding()).map((x) => [x.productId, x.facts])).toEqual([['det', ['country_of_origin', 'net_quantity', 'packer', 'consumer_care']]]);
    // A packed dairy item and a shampoo too — every packed department.
    expect((await publish('curd', item('CURD', 'other-packaged-foods', '04039010'), FOLLOW)).status).toBe(201);
    expect((await publish('sham', item('SHAM', 'personal-care', '33051090'), FOLLOW)).status).toBe(201);
    // The four facts typed: the hold lifts (the full rule from now); no allergens were asked of a detergent.
    const filled = await fill('det', { expectedVersion: 1, facts: PACKED_FOUR, reason: 'read off the pack' });
    expect(filled.status, JSON.stringify(filled.body)).toBe(201);
    expect(filled.body['labelFactsOutstanding']).toBeUndefined();
    expect((await read('det')).product.labelFactsFollow).toBeUndefined();
    expect((await outstanding()).map((x) => x.productId).sort()).toEqual(['curd', 'sham']);
  });

  it('a loose food may not be loaded before its allergens and origin — refused by name, nothing saved', async () => {
    const { publish, read } = rig();
    const dal = await publish('dal', { ...item('DAL', 'loose-foods', '07133100'), baseUom: 'kg' }, FOLLOW);
    expect([dal.status, code(dal)]).toEqual([422, 'label_facts_follow_not_this_department']);
    expect(JSON.stringify(dal.body)).toContain('loose foods and loose goods have no pack');
    expect((await read('dal')).product).toBeUndefined();
  });
});

describe('OB-811 B: sold at the till only — never online, never in a phone basket, while a fact is still to read', () => {
  const shop = { version: 1, legalName: 'Test Shop', address: '1 Test Road', gstin: '33ABCDE1234F1Z5', returnTerms: '7 days', grievanceOfficerName: 'Test Officer', grievanceOfficerContact: 'grievance@test.example', setBy: 'u-owner', setAt: now() } as unknown as OnlineShopDetails;
  const facts = (over: Partial<OnlineListingFacts> = {}): OnlineListingFacts => ({
    productId: 'det', name: 'Test detergent', mrpMinor: 20_000, sellingPriceMinor: 18_000, taxRateBps: 1_800, carriesDate: false, countryOfOrigin: 'India', seller: { own: true }, ...over,
  });

  it('the household item\'s online listing is refused while its facts are outstanding — the same facts head office lists', async () => {
    const { publish, read } = rig();
    await publish('det', item('DET', 'household-general', '34022010'), FOLLOW);
    const outstanding = outstandingLabelFacts((await read('det')).product);
    expect(outstanding).toEqual(['country_of_origin', 'net_quantity', 'packer', 'consumer_care']);
    expect(checkOnlineListing(facts({ labelFactsOutstanding: outstanding }), shop, { deliveryFeeMinor: 3_000 })).toMatchObject({ publishable: false, refusal: 'online listing incomplete: label facts read off the pack' });
  });

  it('a phone basket with it is refused, nothing kept; with its facts typed it may be scanned', async () => {
    const { publish, read, fill } = rig();
    await publish('det', item('DET', 'household-general', '34022010'), FOLLOW);
    const kept: unknown[] = [];
    const deps: ScanAndGoDeps = {
      pack: async () => ({ version: 1, products: [{ productId: 'det', name: 'Test detergent', baseUom: 'pcs', unitPriceMinor: 18_000 }], barcodes: [{ code: '8901234567944', productId: 'det', kind: 'standard' }] }),
      // The real adapters read exactly this: outstandingLabelFacts of the product as head office holds it.
      labelFactsOutstanding: async (_t, id) => outstandingLabelFacts((await read(id)).product),
      basket: async () => undefined, recalls: async () => [], basketsOf: async () => [],
      recordBasket: async (_t, b) => { kept.push(b); }, recordRecall: async () => {}, randomInt: () => 123_456, now,
    };
    const route = scanAndGoRoutes(deps).find((r) => r.method === 'POST')!;
    const ctx = (): RequestContext => ({ tenantId: T, userId: 'cust-1', branchId: null, params: { basketId: 'basket-811' }, query: {}, body: { lines: [{ productId: 'det', quantityMinor: 1 }] }, traceId: 't', idempotencyKey: 'k' });
    const refused = await Promise.resolve(route.handler(ctx())).catch((e: ApiError) => e);
    expect((refused as ApiError).status).toBe(422);
    expect((refused as ApiError).body).toMatchObject({ code: 'not_for_scan_and_go', refused: [{ productId: 'det', why: 'label_facts_not_yet_read' }] });
    expect(kept).toEqual([]);
    expect((await fill('det', { expectedVersion: 1, facts: PACKED_FOUR, reason: 'read off the pack' })).status).toBe(201);
    expect((await route.handler(ctx())).status).toBe(201);
  });

  it('pins the department table: storeDepartment(household) is packed, and a loose food is not', () => {
    expect(storeDepartment('household-general')!.regulated).toEqual(['packed']);
    expect(labelFactsMayFollowIn(storeDepartment('loose-foods')!)).toBe(false);
  });
});
