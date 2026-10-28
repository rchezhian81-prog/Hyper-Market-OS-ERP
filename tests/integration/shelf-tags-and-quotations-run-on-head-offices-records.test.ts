import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { createShelfTagsSession } from '../../apps/web-erp/src/shelf-tags-session';
import { createQuotationsSession } from '../../apps/web-erp/src/quotations-session';
import { httpQuotations } from '../../edge/store-edge/src/quotations-at-lane';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { SignedPack } from '../../services/catalogue/src/pack';

/**
 * **Shelf tags (OB-505 · B3) and retail quotations (OB-506 · M12-FR-02) on head office's real routes — in memory and, with
 * DATABASE_URL, on real PostgreSQL with a cold restart.**
 *   • SHELF TAGS: products published with their MRP, net quantity and Tamil name, priced and packed for the tills; the page's
 *     session prints the tags from the signed pack (the till's price, ₹ per kg / litre, the MRP, Rule 9 heights) and refuses
 *     the one whose net quantity no price divides by, by name. A person without the pack read is refused by head office (403).
 *   • QUOTATIONS: the manager makes one on the page's session (counted items from the pack, a promised price); a cashier may
 *     not make or convert one (403); the store computer may convert but never make or void (403). The till keys the number:
 *     the box converts it for the till's bill, the till rings the quoted price with the quotation as evidence — lowered, or
 *     RAISED above the till's price (owner, 28 Oct 2026), and a line quoted above its MRP refused in words, not rung — and
 *     the bill pays. Head office banks the bill and explains each quoted price from its own quotation record (informational,
 *     never an unapproved price change). The same bill asking again gets its lines; another bill is told which bill has it; a voided quotation is refused.
 *     After a cold restart the quotation is still rung up on that bill and still refused to any other.
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
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

const STORE = 'store-1';
const AS_OF = '2030-06-01';
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASHIER = 'u-cash'; const BOX = 'u-box';
type Res = { status: number; body: unknown };

/** A browser's same-origin fetch (or the box's to head office), answered by the harness as one person. */
function asPerson(get: () => ApiHarness, tenantId: string, userId: string, branchId?: string): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://screen.local');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const r = await get().request({
      method: (init?.method ?? 'GET') as 'GET', path: url.pathname, userId, tenantId, ...(branchId === undefined ? {} : { branchId }),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      ...(headers['idempotency-key'] === undefined ? {} : { idempotencyKey: headers['idempotency-key'] }),
      ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
    });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

describe.each(backings)('shelf tags and quotations on head office\'s records — on $name', ({ harness, restart }) => {
  it('tags printed from the tills\' pack; a quotation made, rung up at the till once, and kept across a cold restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MANAGER, 'store_manager', [STORE]);
    await h.provisionRole(T, CASHIER, 'cashier', [STORE]);
    await h.provisionRole(T, BOX, 'store_computer', [STORE]);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(req('POST', '/v1/catalogue/tax-classes/07139010/rates/2017-07-01', { rateBps: 500 }), 'tax');
    const items = [
      ['p-dal', 'DAL-500', 'Toor dal 500 g', '8901000000019', '500 g', 7_200, 8_000, 'துவரம் பருப்பு'],
      ['p-oil', 'OIL-1L', 'Groundnut oil 1 L', '8901000000026', '1 L', 19_000, 21_000, undefined],
      ['p-ghee', 'GHEE-JAR', 'Ghee jar', '8901000000040', 'one jar', 60_000, 65_000, undefined], // a net quantity no price divides by
      ['p-rice', 'RICE-25', 'Ponni rice 25 kg', '8901000000033', '25 kg', 145_000, 150_000, undefined],
    ] as const;
    for (const [id, sku, name, code, net, price, mrp, ta] of items) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '07139010', lifecycle: 'draft', safety: { netQuantity: net }, mrpHistory: [{ value: { minor: mrp, currency: 'INR' }, effectiveFrom: '2030-01-01' }] }, categories: [GROCERY] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: mrp, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
      if (ta !== undefined) await ok(req('POST', `/v1/catalogue/products/${id}/content`, { nameTa: ta, reason: 'Tamil name for the shelf tag' }), `tamil ${id}`);
    }
    // R9-A · OB-532: the rice and the dal came into the store at a cost (opening stock), so head office knows their floors —
    // a product never received at a cost would need the OWNER's approval to be quoted.
    await ok(req('POST', '/v1/inventory/goods-receipt/opening-quoted', { warehouseId: STORE, receivedOnDate: '2030-01-02', currency: 'INR', lines: [
      { lineId: 'L1', productId: 'p-rice', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 130_000, currency: 'INR' }, condition: 'good' },
      { lineId: 'L2', productId: 'p-dal', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 6_000, currency: 'INR' }, condition: 'good' },
      // OB-545: the oil (quoted above the till price) and the ghee (quoted above its MRP) have known floors too, so what this
      // test proves is the quoted-price rule, not the no-floor approval (OB-532).
      { lineId: 'L3', productId: 'p-oil', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 17_000, currency: 'INR' }, condition: 'good' },
      { lineId: 'L4', productId: 'p-ghee', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 55_000, currency: 'INR' }, condition: 'good' },
    ] }), 'opening stock');
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish the pack');
    const pack = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;
    const oilInPack = pack.snapshot.products.find((p) => p.productId === 'p-oil')!;

    // ── SHELF TAGS: from the pack the tills charge from, each lawful or refused by name.
    const tags = createShelfTagsSession({ viewer: { userId: MANAGER, permissions: ['catalogue.pack.read'] }, fetch: asPerson(() => h, T, MANAGER, STORE) });
    const sheet = await tags.prepare({ codes: '8901000000019\nOIL-1L\np-rice\nGHEE-JAR', language: 'both', templateId: 'shelf-70x38' });
    expect(sheet.result, JSON.stringify(sheet)).toBe('ok');
    if (sheet.result !== 'ok') return;
    expect(sheet.value.packVersion).toBe(pack.snapshot.version);
    const byId = new Map(sheet.value.tags.map((t) => [t.productId, t]));
    expect(byId.get('p-dal')).toMatchObject({ sellingPriceMinor: 7_200, mrpMinor: 8_000, nameTa: 'துவரம் பருப்பு', unitPrice: { unitPriceMinor: 14_400, per: 'kg' }, netQuantity: '500 g' });
    expect(byId.get('p-oil')).toMatchObject({ sellingPriceMinor: oilInPack.unitPriceMinor, unitPrice: { unitPriceMinor: oilInPack.unitPriceMinor, per: 'l' } });
    expect(byId.get('p-rice')?.unitPrice).toEqual({ unitPriceMinor: 5_800, per: 'kg', exempt: false });
    expect(byId.get('p-dal')?.heights.letters.valid).toBe(true);
    expect(sheet.value.refused.map((r) => [r.code, r.refusal])).toEqual([['GHEE-JAR', 'no_net_quantity']]);
    // Head office refuses the pack read to someone without it (the session's own gate is only a shape).
    const outsider = createShelfTagsSession({ viewer: { userId: 'u-nobody', permissions: ['catalogue.pack.read'] }, fetch: asPerson(() => h, T, 'u-nobody') });
    const refused = await outsider.prepare({ codes: 'p-dal', language: 'en', templateId: '' });
    expect(refused).toMatchObject({ result: 'refused', status: 403 });

    // ── QUOTATIONS: made on the page by the manager.
    let n = 0;
    const numbers = ['48151623', '48151624'];
    const page = createQuotationsSession({ viewer: { userId: MANAGER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, MANAGER, STORE), newNumber: () => numbers[n++]!, now: () => '2030-06-01T06:00:00.000Z' });
    const rice = await page.line({ code: 'RICE-25', qty: '2', priceRupees: '1380' });
    const dal = await page.line({ code: '8901000000019', qty: '3', priceRupees: '' });
    // OB-506 (owner, 28 Oct 2026): oil quoted ABOVE the till's ₹190 (within its ₹210 MRP); ghee quoted ABOVE its ₹650 MRP.
    const oil = await page.line({ code: 'OIL-1L', qty: '1', priceRupees: '200' });
    const ghee = await page.line({ code: 'GHEE-JAR', qty: '1', priceRupees: '700' });
    expect(rice.result === 'ok' && dal.result === 'ok' && oil.result === 'ok' && ghee.result === 'ok').toBe(true);
    if (rice.result !== 'ok' || dal.result !== 'ok' || oil.result !== 'ok' || ghee.result !== 'ok') return;
    expect(oilInPack).toMatchObject({ unitPriceMinor: 19_000, mrpMinor: 21_000 });
    const made = await page.make({ storeId: STORE, customerRef: 'Murugan Stores', validUntil: '2099-12-31', approvalId: '', lines: [rice.value, dal.value, oil.value, ghee.value] });
    expect(made, JSON.stringify(made)).toMatchObject({ result: 'ok', value: { quotationId: '48151623', totalMinor: 2 * 138_000 + 3 * 7_200 + 20_000 + 70_000 } });
    const second = await page.make({ storeId: STORE, customerRef: 'Selvi', validUntil: '2099-12-31', approvalId: '', lines: [dal.value] });
    expect(second.result).toBe('ok');
    // Who may do what, at head office: a cashier neither makes nor converts; the store computer converts only.
    const convertBody = { saleId: 'B-x', laneId: 'lane-1', cashierId: CASHIER };
    expect((await req('POST', '/v1/pos/quotations/48151623/convert', convertBody, CASHIER)).status).toBe(403);
    expect((await req('POST', '/v1/pos/quotations/99999999', { storeId: STORE, customerRef: 'x', currency: 'INR', validUntil: '2099-12-31', lines: [{ lineId: 'l1', productId: 'p-dal', description: 'd', unitPriceMinor: 1, quantityMinor: 1, uom: 'ea', taxBps: 0 }] }, BOX)).status).toBe(403);
    expect((await req('POST', '/v1/pos/quotations/48151624/withdraw', { reason: 'x' }, BOX)).status).toBe(403);
    expect((await req('GET', '/v1/pos/quotations', undefined, BOX)).status).toBe(403);

    // ── At the till: the number keyed; the store computer converts it under its own credential; the till rings it.
    const box = httpQuotations({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    const written: Record<string, unknown>[] = [];
    const till = bootPos({
      laneId: 'lane-1', cashierId: CASHIER, tradingDay: AS_OF, catalogue: pack.snapshot,
      quotationsPort: { convert: (i) => box.convert({ quotationNumber: i.quotationNumber, billRef: i.billRef, laneId: 'lane-1', cashierId: CASHIER }) },
      durable: async (_id, record) => { written.push(JSON.parse(record) as Record<string, unknown>); return { committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }; },
    });
    const rung = await till.ringQuotationAtTill('48151623');
    expect(rung, JSON.stringify(rung)).toMatchObject({ ok: true, quotationId: '48151623' });
    expect(rung.added?.map((a) => [a.description, a.qty, a.unitPriceMinor, a.at])).toEqual([['Ponni rice 25 kg', 2, 138_000, 'quoted'], ['Toor dal 500 g', 3, 7_200, 'same'], ['Groundnut oil 1 L', 1, 20_000, 'quoted_higher']]);
    // The ghee quoted above its MRP is refused in words and never rung.
    expect(rung.notAdded?.map((x) => [x.productId, x.refusedBecause])).toEqual([['p-ghee', 'quoted_above_mrp']]);
    expect(rung.notAdded?.[0]?.laneMessage).toBe('NOT rung — the quoted price ₹700.00 is above this item\'s MRP ₹650.00 — a customer is never charged above the MRP. Ask the office to correct the quotation.');
    const bill = till.currentBillRef();
    expect(till.payableMinor()).toBe(2 * 138_000 + 3 * 7_200 + 20_000);
    // The same bill asking again (a lost answer) gets its lines; another bill is told which bill has it.
    expect((await box.convert({ quotationNumber: '48151623', billRef: bill, laneId: 'lane-1', cashierId: CASHIER })).converted).toBe(true);
    const other = await box.convert({ quotationNumber: '48151623', billRef: 'B-another', laneId: 'lane-2', cashierId: CASHIER });
    expect(other).toMatchObject({ converted: false, refusedBecause: 'already_converted', laneMessage: `Quotation 48151623 was already rung up on bill ${bill}. A quotation becomes one bill — nothing was rung.` });
    await till.tenderCash('S-Q-1', 'R-Q-1', `${AS_OF}T07:00:00.000Z`);
    const lines = (written[0] as { lines: { productId: string; unitPriceMinor: number; priceOverride?: Record<string, unknown> }[] }).lines;
    expect(lines.find((l) => l.productId === 'p-rice')).toMatchObject({ unitPriceMinor: 138_000, priceOverride: { fromUnitPriceMinor: 145_000, approvedBy: 'quotation 48151623', activityId: 'quotation:48151623', quotationId: '48151623' } });
    expect(lines.find((l) => l.productId === 'p-oil')).toMatchObject({ unitPriceMinor: 20_000, priceOverride: { fromUnitPriceMinor: 19_000, approvedBy: 'quotation 48151623', activityId: 'quotation:48151623', quotationId: '48151623' } });
    expect(lines.some((l) => l.productId === 'p-ghee')).toBe(false);
    // Head office banks the bill and explains each quoted price from ITS OWN quotation record — informational, naming the
    // quotation; never a material "check the lane" price difference, and nothing above the MRP.
    // (The store computer sends it in the cloud's shape — its own `toCloudSale`, which carries each line as the till wrote it.)
    const banked = await ok(req('POST', '/v1/sales', toCloudSale(written[0], pack.snapshot.version, STORE, 'lane-1'), BOX), 'bank the quotation bill');
    const findings = (banked.body as { exceptions: { kind: string; severity: string; productId?: string; detail: string }[] }).exceptions;
    const priced = findings.filter((e) => e.kind === 'price_differs_from_catalogue' || e.kind === 'sold_above_mrp').map((e) => [e.productId, e.kind, e.severity]);
    expect(priced, JSON.stringify(findings)).toEqual(expect.arrayContaining([['p-rice', 'price_differs_from_catalogue', 'informational'], ['p-oil', 'price_differs_from_catalogue', 'informational']]));
    expect(priced).toHaveLength(2);
    expect(findings.find((e) => e.productId === 'p-oil' && e.kind === 'price_differs_from_catalogue')!.detail).toBe('OIL-1L was charged at 20000, the price quotation 48151623 promised (the catalogue says 19000)');
    expect(findings.filter((e) => e.productId === 'p-oil').map((e) => e.kind), JSON.stringify(findings)).toEqual(['price_differs_from_catalogue']);

    // A voided quotation is refused at the till — kept on record, with its reason.
    expect((await page.void('48151624', 'customer bought elsewhere')).result).toBe('ok');
    expect(await box.convert({ quotationNumber: '48151624', billRef: 'B-v', laneId: 'lane-1', cashierId: CASHIER })).toMatchObject({ converted: false, refusedBecause: 'quotation_withdrawn' });
    expect(await box.convert({ quotationNumber: '11111111', billRef: 'B-v', laneId: 'lane-1', cashierId: CASHIER })).toMatchObject({ converted: false, refusedBecause: 'no_such_quotation' });

    // ── Cold restart: the quotation is still on that bill, still refused to any other, and the voided one still on record.
    h = restart(h);
    const listed = await page.list('');
    expect(listed.result).toBe('ok');
    if (listed.result !== 'ok') return;
    const byNumber = new Map(listed.value.quotations.map((q) => [q.quotationId, q]));
    expect(byNumber.get('48151623')).toMatchObject({ state: 'converted', convertedSaleId: bill });
    expect(byNumber.get('48151624')).toMatchObject({ state: 'withdrawn', withdrawReason: 'customer bought elsewhere' });
    expect((await box.convert({ quotationNumber: '48151623', billRef: 'B-after-restart', laneId: 'lane-1', cashierId: CASHIER })).converted).toBe(false);
    expect((await box.convert({ quotationNumber: '48151623', billRef: bill, laneId: 'lane-1', cashierId: CASHIER })).converted).toBe(true);
  }, 60_000);
});
