import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide } from '../support/approval-request';
import { deliveryPlaces } from '../support/approved-supplier';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Wave 2 · Round 4a part 2 — the shop's space set up from a screen, the supplier display-space register, and the three
 * product checks (M04-FR-01..04 · D02-FR-02/06 · OB-625 · M34-FR-01 · §28).**
 *
 * Through the real head-office surface (in memory, and on real PostgreSQL when DATABASE_URL is set):
 *   • a shelf map, a planogram version and a floor plan each leave who, before and after on the audit trail; a second
 *     shelf map names the places it added and took away;
 *   • the display-contract register lists each contract with its finding judged on the shop's today; a contract recorded
 *     without Finance's approval is "unapproved"; the maker asks, the accountant (never the maker) approves exactly those
 *     terms, the correction names the approval and the register says approved; each is sealed on the trail; a cashier is
 *     refused the register;
 *   • a cluster listing and a season plan are sealed on the trail with the stores they reached;
 *   • the product checks (OB-625) name each sellable product with no GST rate for its HSN, with no allergen declaration in
 *     a food category or no ingredient list in a packed-food category, and with no barcode — and say how many they checked;
 *     a discontinued line is not checked; a cashier is refused.
 * Synthetic data only.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const STORE = 'store-1';
const loc = (id: string, aisle: number, bay: number, shelf: number) => ({ locationId: id, aisle, rack: 1, bay, shelf, position: 1 });

describe.each(backings)('Wave 2: space setup, display contracts and product checks — on $name', ({ harness }) => {
  const setUp = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await deliveryPlaces(h, T, STORE);
    const req = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method !== 'GET' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const trail = async (action: string) => (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
      .map((e) => e.event.payload as { action: string; actorId: string; objectId: string; before: Record<string, string> | null; after: Record<string, string> | null; approvalId?: string })
      .filter((r) => r.action === action);
    const product = (id: string, extra: Record<string, unknown> = {}) => ({
      sku: `SKU-${id}`, name: `Synthetic ${id}`, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063020', lifecycle: 'active',
      safety: { allergens: [], countryOfOrigin: 'India', storageConditions: 'Cool and dry', ingredients: 'Rice' }, ...extra,
    });
    return { h, T, req, ok, trail, product };
  };

  it('a shelf map, a planogram and a floor plan each leave who, before and after on the audit trail', async () => {
    const { req, ok, trail, product } = await setUp();
    await ok(req('POST', '/v1/catalogue/tax-classes/10063020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'category');
    await ok(req('POST', '/v1/catalogue/products/RICE/publish', { product: product('RICE') }), 'product');
    await ok(req('PUT', `/v1/merchandising/stores/${STORE}/shelf-map`, { locations: [loc('A1-B1-S1', 1, 1, 1), loc('A1-B1-S2', 1, 1, 2)] }), 'map v1');
    await ok(req('PUT', `/v1/merchandising/stores/${STORE}/shelf-map`, { locations: [loc('A1-B1-S1', 1, 1, 1), loc('A1-B2-S1', 1, 2, 1)] }), 'map v2');
    const maps = await trail('merchandising.shelf_map.publish');
    expect(maps.map((m) => [m.before, m.after])).toEqual([
      [null, { version: '1', places: '2', added: 'A1-B1-S1,A1-B1-S2', removed: '' }],
      [{ version: '1', places: '2' }, { version: '2', places: '2', added: 'A1-B2-S1', removed: 'A1-B1-S2' }],
    ]);
    expect(maps[0]).toMatchObject({ actorId: 'u-owner', objectId: STORE });

    const plan = { effectiveFrom: '2026-01-01', assignments: [{ productId: 'RICE', locationId: 'A1-B1-S1', capacityMinor: 24, primary: true }] };
    await ok(req('PUT', `/v1/merchandising/stores/${STORE}/planograms/grocery`, plan), 'plan v1');
    await ok(req('PUT', `/v1/merchandising/stores/${STORE}/planograms/grocery`, { ...plan, assignments: [{ ...plan.assignments[0], capacityMinor: 30 }] }, 'u-mgr'), 'plan v2');
    const plans = await trail('merchandising.planogram.publish');
    expect(plans.map((p) => [p.actorId, p.before?.['facings'] ?? null, p.after?.['facings']])).toEqual([
      ['u-owner', null, 'RICE@A1-B1-S1:24*'], ['u-mgr', 'RICE@A1-B1-S1:24*', 'RICE@A1-B1-S1:30*'],
    ]);

    await ok(req('POST', `/v1/merchandising/stores/${STORE}/floor-plan`, { widthFt: 100, depthFt: 80, areas: [{ areaId: 'grocery', name: 'Grocery', nameTa: 'மளிகை', x: 0, y: 0, width: 20, depth: 10, locationIds: ['A1-B1-S1'] }] }), 'floor');
    const floors = await trail('merchandising.floor_plan.publish');
    expect(floors).toHaveLength(1);
    expect(floors[0]).toMatchObject({ objectId: STORE, before: null, after: { version: '1', size: '100x80 ft', areas: 'grocery(200 sq ft: A1-B1-S1)' } });
    // A refused plan (a place not on the map) is not sealed as a change.
    expect((await req('POST', `/v1/merchandising/stores/${STORE}/floor-plan`, { widthFt: 100, depthFt: 80, areas: [{ areaId: 'x', name: 'X', x: 0, y: 0, width: 5, depth: 5, locationIds: ['NOPE'] }] })).status).toBe(422);
    expect(await trail('merchandising.floor_plan.publish')).toHaveLength(1);
  });

  it('the display-contract register: unapproved until the accountant approves exactly those terms; the correction names her; a cashier is refused', async () => {
    const { h, T, req, ok, trail } = await setUp();
    await ok(req('PUT', `/v1/merchandising/stores/${STORE}/shelf-map`, { locations: [loc('END-1', 9, 1, 1)] }), 'map');
    const today = shopDateIn(new Date().toISOString());
    const year = Number(today.slice(0, 4));
    const terms = { storeId: STORE, supplierId: 'SUP-TEA', description: 'Tea end cap', fundingAmount: { minor: 500_000, currency: 'INR' }, startsOn: `${year}-01-01`, endsOn: `${year + 1}-12-31`, locationIds: ['END-1'] };
    expect((await ok(req('POST', '/v1/merchandising/display-contracts/DC-1', terms, 'u-mgr'), 'record')).body).toMatchObject({ approved: false });
    let reg = (await ok(req('GET', '/v1/merchandising/display-contracts', undefined, 'u-mgr', { storeId: STORE }), 'register')).body as { contracts: Record<string, unknown>[]; onDate: string; flagged: number };
    expect(reg.onDate).toBe(today);
    expect(reg.contracts).toEqual([expect.objectContaining({ contractId: 'DC-1', supplierId: 'SUP-TEA', approved: false, finding: 'unapproved', receivedMinor: 0, outstandingMinor: 500_000 })]);
    expect(reg.flagged).toBe(1);

    const ask = { kind: 'display_contract', subjectRef: 'DC-1', details: actionDetails(terms, { contractId: 'DC-1' }), valueMinor: 500_000 };
    const requestId = ((await askForApproval(h, T, 'u-mgr', ask)).body as { requestId: string }).requestId;
    expect(codeOf(await decide(h, T, 'u-mgr', requestId))).toBe('not_permitted_for_this_approval'); // the maker, and not a Finance approver
    expect((await decide(h, T, 'u-acct', requestId)).status).toBe(201);
    expect(codeOf(await req('POST', '/v1/merchandising/display-contracts/DC-1', { ...terms, fundingAmount: { minor: 400_000, currency: 'INR' }, approvalId: requestId }, 'u-mgr'))).toBe('approval_does_not_match');
    expect((await ok(req('POST', '/v1/merchandising/display-contracts/DC-1', { ...terms, approvalId: requestId }, 'u-mgr'), 'approved')).body).toMatchObject({ approved: true });
    reg = (await ok(req('GET', '/v1/merchandising/display-contracts', undefined, 'u-mgr'), 'register again')).body as typeof reg;
    expect(reg.contracts).toEqual([expect.objectContaining({ contractId: 'DC-1', approved: true, approvedBy: 'u-acct', finding: 'funding_not_received' })]);

    expect((await trail('merchandising.display_contract.record'))[0]).toMatchObject({ actorId: 'u-mgr', before: null, after: { supplierId: 'SUP-TEA', fundingMinor: '500000', space: 'END-1', approvedBy: '' } });
    expect((await trail('merchandising.display_contract.correct'))[0]).toMatchObject({ before: { approvedBy: '' }, after: { approvedBy: 'u-acct' }, approvalId: requestId });
    expect((await req('GET', '/v1/merchandising/display-contracts', undefined, 'u-cash')).status).toBe(403);
    expect((await req('POST', '/v1/merchandising/display-contracts/DC-2', terms, 'u-cash')).status).toBe(403);
  });

  it('a cluster listing and a season plan are sealed on the trail with the stores they reached', async () => {
    const { req, ok, trail, product } = await setUp();
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'category');
    await ok(req('POST', '/v1/catalogue/products/RICE/publish', { product: product('RICE') }), 'product');
    await ok(req('POST', `/v1/prices/zones/coast/stores/${STORE}`, {}), 'zone');
    await ok(req('POST', '/v1/merchandising/clusters/coast/RICE/list', { effectiveFrom: '2026-11-01' }, 'u-mgr'), 'list');
    expect((await trail('merchandising.cluster.list'))[0]).toMatchObject({ actorId: 'u-mgr', objectId: 'coast/RICE', after: { effectiveFrom: '2026-11-01', stores: STORE } });
    await ok(req('POST', '/v1/merchandising/season-plans/diwali', { zoneId: 'coast', productIds: ['RICE'], listFrom: '2026-11-01', listTo: '2026-11-20', reason: 'Diwali sweets season' }, 'u-mgr'), 'season');
    expect((await trail('merchandising.season_plan.make'))[0]).toMatchObject({ objectId: 'diwali', after: { zoneId: 'coast', products: 'RICE', listFrom: '2026-11-01', listTo: '2026-11-20', stores: STORE }, });
  });

  it('the product checks name each gap, say how many were checked, leave a discontinued line out and refuse a cashier', async () => {
    const { req, ok, product } = await setUp();
    await ok(req('POST', '/v1/catalogue/tax-classes/10063020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'plain category');
    await ok(req('POST', '/v1/catalogue/products/RICE/publish', { product: product('RICE') }), 'rice');
    await ok(req('POST', '/v1/catalogue/products/RICE/barcodes/RICE-0001', { kind: 'internal' }), 'barcode');
    await ok(req('POST', '/v1/catalogue/products/SOAP/publish', { product: product('SOAP', { taxClass: '34011190' }) }), 'soap, an HSN with no rate');
    await ok(req('POST', '/v1/catalogue/products/DRAFT/publish', { product: product('DRAFT', { lifecycle: 'discontinued', taxClass: '34011190' }) }), 'a discontinued line');
    await ok(req('POST', '/v1/catalogue/products/DAL/publish', { product: product('DAL', { baseUom: 'kg' }) }), 'dal, by weight');
    await ok(req('POST', '/v1/catalogue/products/BISCUIT/publish', { product: product('BISCUIT', { safety: { countryOfOrigin: 'India' } }) }), 'biscuit, no allergens or ingredients');
    await ok(req('POST', '/v1/catalogue/products/BISCUIT/barcodes/BIS-0001', { kind: 'internal' }), 'barcode 2');
    // The categories later declared food and packed food: products published before keep what they had.
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null, regulated: ['food', 'packed'] }), 'packed food');
    await ok(req('POST', '/v1/catalogue/categories/fresh', { name: 'Fresh', parentId: null, regulated: ['food'] }), 'food');
    const r = await ok(req('GET', '/v1/catalogue/reports/product-checks', undefined, 'u-mgr'), 'checks');
    const body = r.body as { checked: number; onMaster: number; counts: Record<string, number>; rows: { report: string; productId: string; reasons: string[]; soldByWeight?: boolean }[]; readOnly: boolean };
    expect(body.readOnly).toBe(true);
    expect(body).toMatchObject({ checked: 4, onMaster: 5 });
    expect(body.rows.filter((x) => x.report === 'tax')).toEqual([expect.objectContaining({ productId: 'SOAP', reasons: ['no_gst_rate_today'] })]);
    expect(body.rows.filter((x) => x.report === 'barcode').map((x) => [x.productId, x.soldByWeight])).toEqual([['DAL', true], ['SOAP', false]]);
    expect(body.rows.filter((x) => x.report === 'allergens')).toEqual([expect.objectContaining({ productId: 'BISCUIT', reasons: ['no_allergen_declaration', 'no_ingredient_list'] })]);
    expect(body.counts).toEqual({ tax: 1, allergens: 1, barcode: 2 });
    expect(body.rows.some((x) => x.productId === 'DRAFT')).toBe(false);
    expect((await req('GET', '/v1/catalogue/reports/product-checks', undefined, 'u-cash')).status).toBe(403);
  });
});
