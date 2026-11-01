import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide, approvedRequestId } from '../support/approval-request';
import { deliveryPlaces } from '../support/approved-supplier';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Round 4a — products and prices: every product-master and price-list write is sealed on the audit trail, a compensation
 * cess changes only with Finance's approval, and a dated, scoped price is judged on head office's own figures (M03-FR-01..04
 * · M05-FR-01/02 · OB-291 · M34-FR-01 · §28).**
 *
 * Through the real head-office surface (in memory, and on real PostgreSQL when DATABASE_URL is set):
 *   • a category, a pack, a barcode, a product publish, a merge proposed / approved / reversed and a store's price zone each
 *     leave an audit record with who did it, the before and the after;
 *   • the first cess of an HSN is set by the catalogue keeper; a CHANGE is refused until a Finance approver (the accountant,
 *     never the asker) approves exactly it, and is then recorded with who approved;
 *   • a price-list entry sent with a lower floor, a higher MRP or a lower cost than head office holds is judged on head
 *     office's figures (the store rules' floor, the product master's MRP, the average buying cost) and refused by name; a
 *     move of more than the owner's set size (OB-291) needs a second person; with the approval it lands and is audited;
 *   • the price basis read says each figure, and "not known" / "not set" by name where head office holds none.
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
const HSN = '24039910';
const RULES = {
  approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
  reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
  service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
  journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
  merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
  writeOffMaterialThresholdMinor: 50_000,
  checklist: [{ itemId: 'close-1', description: 'Count every till blind', blocking: true }],
};

describe.each(backings)('Round 4a: products and prices are audited and judged on head office\'s figures — on $name', ({ harness }) => {
  const setUp = async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-acct', 'accountant');
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const trail = async (action: string) => (await h.store.readStream(T, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
      .map((e) => e.event.payload as { action: string; actorId: string; objectId: string; before: Record<string, string> | null; after: Record<string, string> | null; approvalId?: string })
      .filter((r) => r.action === action);
    return { h, T, req, ok, trail };
  };

  it('a category, a pack, a barcode, a product, a merge and a price zone each leave who, before and after on the audit trail', async () => {
    const { h, req, ok, trail } = await setUp();
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null, regulated: ['food'] }), 'category');
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery and staples', parentId: null, regulated: ['food'] }), 'category change');
    const cats = await trail('catalogue.category.change');
    expect(cats).toHaveLength(1);
    expect(cats[0]).toMatchObject({ actorId: 'u-owner', objectId: 'grocery', before: { name: 'Grocery', version: '1' }, after: { name: 'Grocery and staples', version: '2', approvedBy: 'u-owner' } });
    expect(await trail('catalogue.category.define')).toHaveLength(1);

    await ok(req('POST', '/v1/catalogue/tax-classes/10063020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    const product = { sku: 'SKU-RICE', name: 'Rice 5 kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063020', lifecycle: 'draft', brand: 'Synthetic', safety: { allergens: [], countryOfOrigin: 'India' } };
    await ok(req('POST', '/v1/catalogue/products/p-rice/publish', { product }), 'publish');
    await ok(req('POST', '/v1/catalogue/products/p-rice/publish', { product: { ...product, manufacturer: 'Synthetic Mills', safety: { ...product.safety, storageConditions: 'Cool and dry' } } }), 'republish');
    expect((await trail('catalogue.product.create'))[0]).toMatchObject({ objectId: 'p-rice', before: null, after: { name: 'Rice 5 kg', allergens: 'none' } });
    expect((await trail('catalogue.product.publish'))[0]).toMatchObject({ before: { manufacturer: '', storageConditions: '' }, after: { manufacturer: 'Synthetic Mills', storageConditions: 'Cool and dry' } });

    await ok(req('POST', '/v1/catalogue/products/p-rice/pack', { baseUom: 'ea', levels: [{ level: 'ea', containsMinor: 1 }, { level: 'case', containsMinor: 10 }] }), 'pack');
    expect((await trail('catalogue.pack.define'))[0]).toMatchObject({ before: null, after: { baseUom: 'ea', levels: 'ea=1,case=10' } });
    await ok(req('POST', '/v1/catalogue/products/p-rice/barcodes/RICE-0001', { kind: 'internal' }), 'barcode');
    await ok(req('POST', '/v1/catalogue/products/p-rice/barcodes/RICE-0001', { kind: 'internal' }), 'barcode again');
    expect(await trail('catalogue.barcode.assign')).toEqual([expect.objectContaining({ objectId: 'p-rice', after: { code: 'RICE-0001', kind: 'internal', level: '' } })]);

    await ok(req('POST', '/v1/catalogue/products/p-rice2/publish', { product: { ...product, sku: 'SKU-RICE2' } }), 'duplicate');
    await ok(req('POST', '/v1/catalogue/merges/m-1', { keepProductId: 'p-rice', supersedeProductId: 'p-rice2', reason: 'same rice, entered twice' }, 'u-mgr'), 'propose');
    await ok(req('POST', '/v1/catalogue/merges/m-1/decision', { decision: 'approved' }), 'approve');
    await ok(req('POST', '/v1/catalogue/merges/m-1/reverse', {}), 'reverse');
    expect((await trail('catalogue.merge.propose'))[0]).toMatchObject({ actorId: 'u-mgr', after: { status: 'pending', keep: 'p-rice', supersede: 'p-rice2' } });
    expect((await trail('catalogue.merge.approve'))[0]).toMatchObject({ actorId: 'u-owner', before: { status: 'pending' }, after: { status: 'approved', decidedBy: 'u-owner' } });
    expect((await trail('catalogue.merge.reverse'))[0]).toMatchObject({ before: { status: 'approved' }, after: { status: 'reversed' } });

    await ok(req('POST', `/v1/prices/zones/coast/stores/${STORE}`, {}), 'zone');
    await ok(req('POST', `/v1/prices/zones/inland/stores/${STORE}`, {}), 'zone move');
    expect((await trail('price.zone.set')).map((r) => [r.before, r.after])).toEqual([[null, { zoneId: 'coast' }], [{ zoneId: 'coast' }, { zoneId: 'inland' }]]);
    expect(h).toBeDefined();
  });

  it('the first cess is set; a cess CHANGE waits for a Finance approver (never the asker) and is recorded with who approved', async () => {
    const { T, h, req, ok, trail } = await setUp();
    const first = { advaloremBps: 6_100, specificPerQuantityMinor: 0, perQuantity: 1 };
    await ok(req('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2017-07-01`, first), 'first cess');
    expect((await trail('catalogue.cess_rate.set'))[0]).toMatchObject({ objectId: HSN, before: null, after: { advaloremBps: '6100', approvedBy: '' } });

    const change = { advaloremBps: 7_100, specificPerQuantityMinor: 0, perQuantity: 1 };
    const refused = await req('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2026-12-01`, change);
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('cess_change_needs_finance_approval');
    expect((await req('GET', `/v1/catalogue/tax-classes/${HSN}/cess`)).body).toMatchObject({ schedule: [{ effectiveFrom: '2017-07-01' }] });

    const ask = { kind: 'cess_rate_change', subjectRef: HSN, details: { ...change, hsnCode: HSN, effectiveFrom: '2026-12-01' } };
    const own = ((await askForApproval(h, T, 'u-owner', ask)).body as { requestId: string }).requestId;
    expect(codeOf(await decide(h, T, 'u-owner', own))).toBe('self_approval');
    expect((await decide(h, T, 'u-mgr', own)).status).toBe(403);
    const approvalId = await approvedRequestId(h, T, 'u-owner', 'u-acct', ask);
    expect(codeOf(await req('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2026-12-01`, { ...change, advaloremBps: 7_200, approvalId }))).toBe('approval_does_not_match');
    const done = await ok(req('POST', `/v1/catalogue/tax-classes/${HSN}/cess/2026-12-01`, { ...change, approvalId }), 'approved change');
    expect(done.body).toMatchObject({ approvedBy: 'u-acct' });
    expect((await trail('catalogue.cess_rate.change'))[0]).toMatchObject({ actorId: 'u-owner', before: { schedule: '2017-07-01:6100/0/1' }, after: { advaloremBps: '7100', approvedBy: 'u-acct' }, approvalId });
  });

  it('a dated, scoped price is judged on head office\'s floor, MRP and cost; a move beyond the set size needs a second person; the basis says what it does not know', async () => {
    const { h, T, req, ok, trail } = await setUp();
    await deliveryPlaces(h, T, STORE);
    const today = shopDateIn(new Date().toISOString());
    await ok(req('POST', '/v1/catalogue/tax-classes/09024020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/products/p-tea/publish', { product: { sku: 'SKU-TEA', name: 'Tea', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '09024020', lifecycle: 'draft', mrpHistory: [{ value: { minor: 10_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }), 'publish');

    // Nothing known yet: the basis says so by name — no cost, no floor, no price.
    const bare = (await ok(req('GET', '/v1/prices/list/p-tea/basis', undefined, 'u-mgr', { scope: 'store', scopeRef: STORE, on: today }), 'basis')).body;
    expect(bare).toMatchObject({ mrpMinor: 10_000, mrpFrom: '2026-01-01', costMinor: null, costNotKnownAt: [STORE], marginFloorBps: null, floorNotSetAt: [STORE], currentPriceMinor: null, secondPersonAbove: { percentBps: 1_000, amountMinor: 5_000 } });
    expect((await req('GET', '/v1/prices/list/p-tea/basis', undefined, 'u-acct', { scope: 'store', scopeRef: STORE })).status).toBe(403);

    await ok(req('POST', `/v1/stores/${STORE}/rules`, RULES), 'store rules (20% floor)');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-tea', productId: 'p-tea', locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'EA', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: 'u-owner', unitCostMinor: 7_000 }), 'receive');
    const basis = (await ok(req('GET', '/v1/prices/list/p-tea/basis', undefined, 'u-mgr', { scope: 'store', scopeRef: STORE, on: today }), 'basis')).body;
    expect(basis).toMatchObject({ mrpMinor: 10_000, costMinor: 7_000, costNotKnownAt: [], marginFloorBps: 2_000, floorNotSetAt: [] });

    const entry = (priceMinor: number, extra: Record<string, unknown> = {}) => ({ scope: 'store', scopeRef: STORE, priceMinor, mrpMinor: 10_000, costMinor: 7_000, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: today, ...extra });
    const set = (id: string, body: Record<string, unknown>, who = 'u-mgr') => req('POST', `/v1/prices/list/p-tea/entries/${id}`, body, who);
    // A lower floor, a higher MRP or a lower cost sent with it changes nothing: head office's own figures decide.
    expect(codeOf(await set('e-floor', entry(8_500, { marginFloorBps: 0 })))).toBe('price_below_floor');
    expect(codeOf(await set('e-mrp', entry(10_500, { mrpMinor: 12_000 })))).toBe('price_above_mrp');
    expect(codeOf(await set('e-cost', entry(8_000, { costMinor: 1_000, marginFloorBps: 0 })))).toBe('price_below_floor');
    expect(codeOf(await set('e-cost2', entry(6_900, { costMinor: 1_000, marginFloorBps: 0 })))).toBe('price_below_cost');
    // A first price passes; a later one within the set size passes; one beyond it needs a second person (OB-291).
    await ok(set('e-1', entry(8_800)), 'first price');
    await ok(set('e-2', entry(9_000, { effectiveFrom: '2030-01-01' })), 'within the size');
    const big = await set('e-3', entry(10_000, { effectiveFrom: '2030-02-01' }));
    expect(codeOf(big)).toBe('price_change_needs_second_person');
    expect((big.body as { error: { whatHappened: string } }).error.whatHappened).toContain('more than the 10.00% or ₹50.00 a single person may make (OB-291)');
    const ask = { kind: 'price_list_entry', subjectRef: 'p-tea/e-3', details: { ...entry(10_000, { effectiveFrom: '2030-02-01' }), productId: 'p-tea', entryId: 'e-3' }, valueMinor: 10_000 };
    const approvalId = await approvedRequestId(h, T, 'u-mgr', 'u-owner', ask);
    const landed = await ok(set('e-3', { ...entry(10_000, { effectiveFrom: '2030-02-01' }), approvalId }), 'approved');
    expect(landed.body).toMatchObject({ approvedBy: 'u-owner', version: 3 });

    const audited = await trail('price.list_entry');
    expect(audited.map((a) => a.after?.['entryId'])).toEqual(['e-1', 'e-2', 'e-3']);
    expect(audited[2]).toMatchObject({ actorId: 'u-mgr', after: { priceMinor: '10000', effectiveFrom: '2030-02-01', approvedBy: 'u-owner' }, approvalId });
    // The basis on the later day names the price in force for the scope.
    expect((await ok(req('GET', '/v1/prices/list/p-tea/basis', undefined, 'u-mgr', { scope: 'store', scopeRef: STORE, on: '2030-02-02' }), 'later basis')).body).toMatchObject({ currentPriceMinor: 10_000 });
  });
});
