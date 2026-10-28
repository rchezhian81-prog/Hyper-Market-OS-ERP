import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { onThePriceList, harnessPriceList } from '../support/b2b-price-on-record';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { InMemoryNumberSeriesStore, SqlNumberSeriesStore, type NumberSeriesStore } from '../../packages/persistence/src/number-series-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopDateIn, shopMonthIn } from '../../packages/calendar/src/shop-clock';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM } from '../../services/api/src/adapters';

/**
 * **OB-432 (owner, option A, 28 Oct 2026, in writing) — B2CS State-wise and B2CL in the GSTN GSTR-1 file.** On the real
 * head-office API (in memory and, with DATABASE_URL, on real PostgreSQL), a Tamil Nadu store (33) has a month of:
 *   • till sales (18% ghee, over the counter);
 *   • a B2C tax invoice from the business desk delivered inside Tamil Nadu (5% rice, CGST + SGST);
 *   • a B2C tax invoice delivered to Kerala (32) UNDER the ₹1,00,000 line (5% rice, IGST);
 *   • a B2C tax invoice delivered to Kerala OVER the line (an 18% television of ₹1,18,000, IGST).
 * Then: the document file's B2CS rows carry `pos` and are grouped by supply type, State and rate; the large Kerala invoice is
 * in B2CL (invoice-wise, `pos` 32) and not in B2CS; the till file's B2CS is INTRA with the store's State; the two files'
 * tax together equals the month's GST return, and the close's Output GST still agrees with the books. A hand-entered B2C
 * supply that charged IGST with no State stops the file by name. Customers here have no GSTIN; the store's is synthetic.
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
type Durable = { readonly store: EventStore; readonly numberSeries: NumberSeriesStore };
const backings: { name: string; harness: () => ApiHarness }[] = [{
  name: 'the in-memory event store',
  harness: () => apiHarness({ store: new InMemoryEventStore(), numberSeries: new InMemoryNumberSeriesStore() } satisfies Durable),
}];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), numberSeries: new SqlNumberSeriesStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

const STORE_GSTIN = '33AABCS1429B1Z1';
const PERIOD = shopMonthIn(new Date().toISOString());
const TODAY = shopDateIn(new Date().toISOString());
const RANGE = { from: `${PERIOD}-01`, to: `${PERIOD}-31` };
const FP = `${PERIOD.slice(5, 7)}${PERIOD.slice(0, 4)}`;
const RICE = { lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 };
const TV = { lineId: 'l1', productId: 'p2', description: 'Television 55in', qty: 1, unitPriceMinor: 10_000_000, taxRateBps: 1800 };

interface Refusal { error: { code: string; whatHappened: string; wasItSaved: string } }
interface Invoice { number: string; buyer?: unknown; grossMinor: number; gst: { deliveryStateCode: string; cgstMinor: number; sgstMinor: number; igstMinor: number } }
interface B2cs { sply_ty: string; pos: string; typ: string; rt: number; txval: number; camt: number; samt: number; iamt: number }
interface GstnFile { b2b: unknown[]; b2cl: { pos: string; inv: { inum: string; idt: string; val: number; itms: { num: number; itm_det: { rt: number; txval: number; iamt: number } }[] }[] }[]; b2cs: B2cs[]; hsn: { data: { txval: number; camt: number; samt: number; iamt: number }[] } }
interface Evidence { checks: { name: string; leftMinor: number; rightMinor: number }[]; notChecked: string[] }

const paise = (r: number) => Math.round(r * 100);

describe.each(backings)('OB-432 — B2C supplies State-wise in B2CS, large inter-State ones in B2CL — on $name', ({ harness }) => {
  it('till sales, an intra-State desk invoice and two Kerala invoices either side of the line file in the right sections; the close\'s Output GST still agrees', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    await h.enableFeature(t, 'b2b');
    await h.provisionRole(t, 'u-acct', 'accountant');
    await h.provisionRole(t, 'u-cash', 'cashier');
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    // The store (GSTIN 33, Tamil Nadu), rice at 5% and a television at 18% in the published catalogue, both in stock.
    await ok(call('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' }), 'company');
    await ok(call('POST', `/v1/org/gst-registrations/${STORE_GSTIN}`, 'u-owner', { companyId: 'SRE', legalName: 'SRE Hyper Market Private Limited' }), 'GST registration');
    await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: STORE_GSTIN, placeOfBusiness: '12 Main Road\n\nTiruppur 641601, Tamil Nadu' }), 'store');
    const at = new Date().toISOString();
    await h.store.append(t, STREAM.catalogue, makeEvent({
      id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: at, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
      payload: { snapshot: { tenantId: t, version: 1, builtAt: at, products: [
        { productId: 'p1', sku: 'p1', name: 'Rice 25kg', unitPriceMinor: 10_000, taxBps: 500, hsnCode: '1006', status: 'active', uom: 'ea' },
        { productId: 'p2', sku: 'p2', name: 'Television 55in', unitPriceMinor: 10_000_000, taxBps: 1800, hsnCode: '8528', status: 'active', uom: 'ea' },
      ], barcodes: [] } },
    }));
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rice-in', productId: 'p1', locationId: 'S1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: at, enteredBy: 'u-owner' }), 'rice stock');
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'tv-in', productId: 'p2', locationId: 'S1', kind: 'received', quantityMinor: 5, uom: 'ea', occurredAt: at, enteredBy: 'u-owner' }), 'tv stock');

    // Three credit customers with no GSTIN (they file B2C): each quoted, ordered, delivered and invoiced.
    const invoiceFor = async (customerId: string, lines: unknown[], dispatched: number, deliveryStateCode?: string) => {
      await ok(setApprovedCreditLimit(h, t, 'u-owner', customerId, { creditLimitMinor: 50_000_000, paymentTermsDays: 30 }, { checker: 'u-acct' }), `${customerId} terms`);
      await ok(call('POST', `/v1/b2b/documents/${customerId}/quotations/q1`, 'u-owner', { lines: await onThePriceList(harnessPriceList(h, t), customerId, lines) }), `${customerId} quote`);
      await ok(call('POST', `/v1/b2b/documents/${customerId}/orders/so1`, 'u-owner', { fromQuotationId: 'q1', locationId: 'S1' }), `${customerId} order`);
      await ok(call('POST', `/v1/b2b/documents/${customerId}/challans/dc1`, 'u-owner', { fromOrderId: 'so1', dispatched: { l1: dispatched } }), `${customerId} challan`);
      return (await ok(call('POST', `/v1/b2b/documents/${customerId}/invoices/inv1`, 'u-owner', { fromOrderId: 'so1', ...(deliveryStateCode === undefined ? {} : { deliveryStateCode }) }), `${customerId} invoice`)).body as Invoice;
    };
    const local = await invoiceFor('CUSTA', [RICE], 2); // ₹200 + ₹5 CGST + ₹5 SGST, Tamil Nadu
    const keralaSmall = await invoiceFor('CUSTB', [RICE], 3, '32'); // ₹300 + ₹15 IGST, Kerala
    const keralaLarge = await invoiceFor('CUSTC', [TV], 1, '32'); // ₹1,00,000 + ₹18,000 IGST = ₹1,18,000, Kerala
    expect(local.buyer).toBeUndefined();
    expect(local.gst).toMatchObject({ deliveryStateCode: '33', cgstMinor: 500, sgstMinor: 500, igstMinor: 0 });
    expect(keralaSmall.gst).toMatchObject({ deliveryStateCode: '32', igstMinor: 1_500, cgstMinor: 0 });
    expect(keralaLarge).toMatchObject({ grossMinor: 11_800_000, gst: { deliveryStateCode: '32', igstMinor: 1_800_000 } });

    // Till sales over the counter: ghee at 18%, ₹118 and ₹236 (the GST is inside the price).
    const sell = (saleId: string, total: number) => call('POST', '/v1/sales', 'u-cash', {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-cash', locationId: 'S1', tradingDay: TODAY, committedAt: new Date().toISOString(),
      totalMinor: total, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p-ghee', quantityMinor: 1, uom: 'each', unitPriceMinor: total, lineTotalMinor: total, hsnCode: '040590', taxRateBps: 1800 }],
      tenders: [{ kind: 'cash', amountMinor: total }],
    });
    for (const [id, total] of [['T1', 11_800], ['T2', 23_600]] as const) expect((await sell(id, total)).status).toBe(202);

    // ── The document file: B2CS State-wise with pos; the large Kerala invoice in B2CL only.
    const fileRes = await call('GET', '/v1/finance/gstr1/export', 'u-acct', undefined, { ...RANGE, gstin: STORE_GSTIN, fp: FP });
    expect(fileRes.status, JSON.stringify(fileRes.body)).toBe(200);
    const file = fileRes.body as GstnFile;
    expect(file.b2b).toEqual([]);
    expect(file.b2cl).toEqual([{ pos: '32', inv: [{ inum: keralaLarge.number, idt: `${TODAY.slice(8, 10)}-${TODAY.slice(5, 7)}-${TODAY.slice(0, 4)}`, val: 118_000, itms: [{ num: 1, itm_det: { rt: 18, txval: 100_000, iamt: 18_000 } }] }] }]);
    expect(file.b2cs).toEqual([
      { sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 5, txval: 300, camt: 0, samt: 0, iamt: 15 },
      { sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 5, txval: 200, camt: 5, samt: 5, iamt: 0 },
    ]);
    expect(file.b2cs.some((r) => r.rt === 18)).toBe(false); // the B2CL invoice is not also in B2CS
    const docTax = file.b2cl.flatMap((b) => b.inv.flatMap((i) => i.itms)).reduce((s, it) => s + paise(it.itm_det.iamt), 0) + file.b2cs.reduce((s, r) => s + paise(r.camt + r.samt + r.iamt), 0);
    expect(docTax).toBe(file.hsn.data.reduce((s, r) => s + paise(r.camt + r.samt + r.iamt), 0));
    expect(docTax).toBe(500 + 500 + 1_500 + 1_800_000);

    // ── The till file: over the counter is the store's own State — INTRA, pos 33; no B2CL.
    const tillRes = await call('POST', '/v1/finance/gstr1/from-sales/table-12', 'u-acct', { ...RANGE, annualTurnoverMinor: 6_000_000_000, gstin: STORE_GSTIN, fp: FP });
    expect(tillRes.status, JSON.stringify(tillRes.body)).toBe(200);
    const till = (tillRes.body as { gstn: { b2cs: B2cs[]; b2cl?: unknown } }).gstn;
    expect(till.b2cs).toEqual([{ sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 18, txval: 300, camt: 27, samt: 27, iamt: 0 }]);
    expect(till.b2cl).toBeUndefined();
    const tillTax = till.b2cs.reduce((s, r) => s + paise(r.camt + r.samt + r.iamt), 0);

    // ── The month-end close: the books' output GST still agrees with the GST return — and with the two files together.
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP), 'mapping');
    await ok(call('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-acct', {}), 'day book');
    await ok(call('POST', '/v1/finance/b2b/post', 'u-owner', {}), 'B2B posting run');
    const ev = (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as Evidence;
    const gst = ev.checks.find((c) => c.name === `Output GST for ${PERIOD}`);
    expect(gst, JSON.stringify(ev)).toMatchObject({ leftMinor: 1_807_900, rightMinor: 1_807_900 });
    expect(docTax + tillTax).toBe(gst!.rightMinor);
  }, 120_000);

  it('a hand-entered B2C supply that charged IGST with no State stops the file by name — never guessed; with its State it files', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    const date = `${PERIOD}-05`;
    const igstLine = { hsnCode: '100610', quantityMinor: 1000, uom: 'kg', taxableMinor: 10_000, rateBps: 500, cgstMinor: 0, sgstMinor: 0, igstMinor: 500 };
    const record = (id: string, body: Record<string, unknown>) => h.request({ method: 'POST', path: `/v1/finance/outward-supplies/${id}`, userId: 'u-owner', tenantId: t, idempotencyKey: `o-${id}`, body: { documentDate: date, supplyType: 'b2c', annualTurnoverMinor: 6_000_000_000, lines: [igstLine], ...body } });
    expect((await record('HAND-B2C-1', {})).status).toBe(201);
    const exportIt = () => h.request({ method: 'GET', path: '/v1/finance/gstr1/export', userId: 'u-owner', tenantId: t, query: { ...RANGE, gstin: STORE_GSTIN, fp: FP } });
    const refused = await exportIt();
    expect(refused.status).toBe(422);
    expect((refused.body as Refusal).error).toMatchObject({ code: 'gstr1_place_of_supply_not_judged', wasItSaved: 'not_saved' });
    expect((refused.body as Refusal).error.whatHappened).toContain('invoice HAND-B2C-1 (unregistered buyer)');
    expect((refused.body as Refusal).error.whatHappened).toContain('no place of supply is recorded');

    // A till fold asked to treat the counter sales as inter-State has no State to name either — refused by name too.
    const h2 = harness();
    const t2 = randomUUID();
    await h2.seedOwner(t2, 'u-owner');
    await h2.provisionRole(t2, 'u-cash', 'cashier');
    await h2.request({ method: 'POST', path: '/v1/sales', userId: 'u-cash', tenantId: t2, idempotencyKey: 'sale-1', body: {
      saleId: 'X1', receiptNumber: 'R-X1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: TODAY, committedAt: new Date().toISOString(), totalMinor: 10_500, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'p1', quantityMinor: 1, uom: 'each', unitPriceMinor: 10_500, lineTotalMinor: 10_500, hsnCode: '100610', taxRateBps: 500 }], tenders: [{ kind: 'cash', amountMinor: 10_500 }],
    } });
    const tillRefused = await h2.request({ method: 'POST', path: '/v1/finance/gstr1/from-sales/table-12', userId: 'u-owner', tenantId: t2, idempotencyKey: 'fs-1', body: { ...RANGE, annualTurnoverMinor: 6_000_000_000, placeOfSupply: 'inter_state', gstin: STORE_GSTIN, fp: FP } });
    expect(tillRefused.status, JSON.stringify(tillRefused.body)).toBe(422);
    expect((tillRefused.body as Refusal).error).toMatchObject({ code: 'gstr1_place_of_supply_not_judged', wasItSaved: 'not_saved' });
    expect((tillRefused.body as Refusal).error.whatHappened).toContain('till sales under HSN 100610 at 5%');

    // The same hand entry with its State (Kerala) files as an INTER B2CS row with pos 32.
    const h3 = harness();
    const t3 = randomUUID();
    await h3.seedOwner(t3, 'u-owner');
    expect((await h3.request({ method: 'POST', path: '/v1/finance/outward-supplies/HAND-B2C-2', userId: 'u-owner', tenantId: t3, idempotencyKey: 'o-2', body: { documentDate: date, supplyType: 'b2c', placeOfSupplyStateCode: '32', annualTurnoverMinor: 6_000_000_000, lines: [igstLine] } })).status).toBe(201);
    const ok = (await h3.request({ method: 'GET', path: '/v1/finance/gstr1/export', userId: 'u-owner', tenantId: t3, query: { ...RANGE, gstin: STORE_GSTIN, fp: FP } })).body as GstnFile;
    expect(ok.b2cl).toEqual([]);
    expect(ok.b2cs).toEqual([{ sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 5, txval: 100, camt: 0, samt: 0, iamt: 5 }]);
  }, 60_000);
});
