import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { setApprovedCreditLimit } from '../support/approved-credit-limit';
import { onThePriceList, harnessPriceList } from '../support/b2b-price-on-record';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { InMemoryNumberSeriesStore, SqlNumberSeriesStore, type NumberSeriesStore } from '../../packages/persistence/src/number-series-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { shopMonthIn } from '../../packages/calendar/src/shop-clock';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **OB-426 (option B) · OB-427 (option A) · OB-428 (option A) — owner, 27 Oct 2026, in writing.** On the real head-office API
 * (in memory and, with DATABASE_URL, on real PostgreSQL), a store in Tamil Nadu (33) and a credit customer whose GSTIN is
 * from Kerala (32):
 *   • a tax invoice with the delivery State left blank takes the GSTIN's State — IGST, said as from the GSTIN; the person
 *     invoicing names Tamil Nadu on the next — CGST + SGST;
 *   • the GSTIN is removed with a reason (who, when, why, the GSTIN removed — append-only, in the audit trail, by whoever
 *     manages B2B accounts); removing again, or for a customer with none, is refused by name; the next invoice files B2C
 *     and its blank State is the store's own again;
 *   • the GSTN GSTR-1 file carries each B2B invoice's `pos` and `rchrg` ("N"); a hand-entered B2B invoice with IGST and no
 *     State is refused by name, never guessed;
 *   • after a restart the issued invoices are unchanged, and a GSTIN recorded again after the removal is a new fact.
 * Every GSTIN here is synthetic with a valid check character.
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
const backings: { name: string; harness: (durable?: Durable) => ApiHarness & { durable: Durable } }[] = [{
  name: 'the in-memory event store',
  harness: (d) => { const durable = d ?? { store: new InMemoryEventStore(), numberSeries: new InMemoryNumberSeriesStore() }; return Object.assign(apiHarness(durable), { durable }); },
}];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: (d) => { const sql = pgPoolClient(pool!); const durable = d ?? { store: new SqlEventStore(sql), numberSeries: new SqlNumberSeriesStore(sql) }; return Object.assign(apiHarness({ ...durable, idempotency: new SqlIdempotencyStore(sql) }), { durable }); } });

const GSTIN_KL = '32ZZZZZ9999Z1ZH';
const STORE_GSTIN = '33AABCS1429B1Z1';
const PERIOD = shopMonthIn(new Date().toISOString());
const RANGE = { from: `${PERIOD}-01`, to: `${PERIOD}-31` };
const FP = `${PERIOD.slice(5, 7)}${PERIOD.slice(0, 4)}`;
const LINES = [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 }];

interface Refusal { error: { code: string; whatHappened: string; wasItSaved: string } }
interface Invoice { number: string; buyer?: { gstin: string }; gst: { placeOfSupply: string; deliveryStateCode: string; basis: string; cgstMinor: number; sgstMinor: number; igstMinor: number } }
interface GstnFile { b2b: { ctin: string; inv: { inum: string; pos: string; rchrg: string; inv_typ: string; itms: { itm_det: { camt: number; samt: number; iamt: number } }[] }[] }[]; b2cs: { txval: number }[] }

async function shop(h: ApiHarness, t: string) {
  await h.seedOwner(t, 'u-owner');
  await h.enableFeature(t, 'b2b');
  await h.provisionRole(t, 'u-acct', 'accountant');
  await h.provisionRole(t, 'u-cash', 'cashier');
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>, key?: string) =>
    h.request({ method, path, userId, tenantId: t, ...(method === 'GET' ? {} : { idempotencyKey: key ?? `k-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, label: string) => { const r = await p; expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  return { call, ok };
}
type Shop = Awaited<ReturnType<typeof shop>>;

async function storeReady(h: ApiHarness, t: string, s: Shop) {
  await s.ok(s.call('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' }), 'company');
  await s.ok(s.call('POST', `/v1/org/gst-registrations/${STORE_GSTIN}`, 'u-owner', { companyId: 'SRE', legalName: 'SRE Hyper Market Private Limited' }), 'GST registration');
  await s.ok(s.call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: STORE_GSTIN, placeOfBusiness: '12 Main Road\n\nTiruppur 641601, Tamil Nadu' }), 'store');
  const at = new Date().toISOString();
  await h.store.append(t, STREAM.catalogue, makeEvent({
    id: `pack-${t}-1`, type: 'CataloguePublished', occurredAt: at, idempotencyKey: `catalogue-${t}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: t, version: 1, builtAt: at, products: [{ productId: 'p1', sku: 'p1', name: 'Rice 25kg', unitPriceMinor: 10_000, taxBps: 500, hsnCode: '1006', status: 'active', uom: 'ea' }], barcodes: [] } },
  }));
  await s.ok(s.call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rice-in', productId: 'p1', locationId: 'S1', kind: 'received', quantityMinor: 100, uom: 'ea', occurredAt: at, enteredBy: 'u-owner' }), 'stock');
}
async function customerWithAnOrder(h: ApiHarness, t: string, s: Shop, customerId: string) {
  await s.ok(setApprovedCreditLimit(h, t, 'u-owner', customerId, { creditLimitMinor: 10_000_000, paymentTermsDays: 30 }, { checker: 'u-acct' }), `${customerId} terms`);
  await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/quotations/q1`, 'u-owner', { lines: await onThePriceList(harnessPriceList(h, t), customerId, LINES) }), 'quote');
  await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/orders/so1`, 'u-owner', { fromQuotationId: 'q1', locationId: 'S1' }), 'order');
}
/** Deliver 3 of the 10 and invoice them (₹300 + ₹15 GST), optionally naming the delivery State. */
const deliverAndInvoice = async (s: Shop, customerId: string, n: number, deliveryStateCode?: string) => {
  await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/challans/dc${n}`, 'u-owner', { fromOrderId: 'so1', dispatched: { l1: 3 } }), `challan ${n}`);
  return (await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/invoices/inv${n}`, 'u-owner', { fromOrderId: 'so1', ...(deliveryStateCode === undefined ? {} : { deliveryStateCode }) }), `invoice ${n}`)).body as Invoice;
};
const trail = async (h: ApiHarness, t: string) => (await h.store.readStream(t, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
  .map((e) => e.event.payload as { action: string; actorId: string; objectId: string; reason?: string; before: Record<string, string> | null; after: Record<string, string> | null })
  .filter((a) => a.action.startsWith('b2b.customer_gstin'));

describe.each(backings)('OB-426/427/428 — a credit customer\'s GSTIN State, its removal, and the GSTN file — on $name', ({ harness }) => {
  it('the GSTIN\'s State pre-fills the invoice and decides the split; removed with a reason, the next invoice files B2C; the file carries pos and rchrg; a restart changes nothing issued', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    await storeReady(h, t, s);
    await customerWithAnOrder(h, t, s, 'CUSTK');
    await customerWithAnOrder(h, t, s, 'CUSTX'); // never gives a GSTIN
    await s.ok(s.call('POST', '/v1/b2b/accounts/CUSTK/gstin', 'u-acct', { gstin: GSTIN_KL, legalName: 'Synthetic Caterers', reason: 'GST certificate on file' }), 'gstin');

    // OB-426: blank delivery State → the GSTIN's State (Kerala) → IGST, and the invoice says where the State came from.
    const inv1 = await deliverAndInvoice(s, 'CUSTK', 1);
    expect(inv1.buyer).toMatchObject({ gstin: GSTIN_KL });
    expect(inv1.gst).toMatchObject({ placeOfSupply: 'inter_state', deliveryStateCode: '32', basis: 'customer_gstin_state', igstMinor: 1_500, cgstMinor: 0, sgstMinor: 0 });
    // The person invoicing changes it (the goods went to the customer's Tamil Nadu kitchen) → CGST + SGST.
    const inv2 = await deliverAndInvoice(s, 'CUSTK', 2, '33');
    expect(inv2.gst).toMatchObject({ placeOfSupply: 'intra_state', deliveryStateCode: '33', basis: 'delivery_state', cgstMinor: 750, sgstMinor: 750, igstMinor: 0 });
    // A customer with no GSTIN: blank is still the store's own State, said as assumed (A8, unchanged).
    const plain = await deliverAndInvoice(s, 'CUSTX', 1);
    expect(plain.gst).toMatchObject({ placeOfSupply: 'intra_state', basis: 'store_state_assumed', deliveryStateCode: '33' });

    // OB-427: removing needs a reason; a cashier cannot; a customer with none is refused by name.
    const remove = (customerId: string, body: unknown, userId = 'u-acct', key?: string) => s.call('POST', `/v1/b2b/accounts/${customerId}/gstin/removal`, userId, body, undefined, key);
    expect((await remove('CUSTK', {})).status).toBe(400);
    expect(((await remove('CUSTK', {})).body as Refusal).error.code).toBe('not_readable_as_a_gstin_removal');
    expect((await remove('CUSTK', { reason: 'registration cancelled' }, 'u-cash')).status).toBe(403);
    const none = await remove('CUSTX', { reason: 'registration cancelled' });
    expect(none.status).toBe(409);
    expect((none.body as Refusal).error).toMatchObject({ code: 'no_customer_gstin_to_remove', wasItSaved: 'not_saved' });
    expect((await remove('NOBODY', { reason: 'x' })).status).toBe(404);
    expect((await trail(h, t)).map((a) => a.action)).toEqual(['b2b.customer_gstin.record']);

    const removed = await remove('CUSTK', { reason: 'GST registration cancelled (portal shows Cancelled)' }, 'u-acct', 'remove-1');
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect(removed.body).toMatchObject({ customerId: 'CUSTK', removed: true, removedGstin: GSTIN_KL, legalName: 'Synthetic Caterers', stateCode: '32', removedBy: 'u-acct', reason: 'GST registration cancelled (portal shows Cancelled)', files: 'b2c' });
    expect((removed.body as { removedAt: string }).removedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // A re-sent request (same key) replays; a second removal is refused by name — nothing is left to remove.
    expect((await remove('CUSTK', { reason: 'GST registration cancelled (portal shows Cancelled)' }, 'u-acct', 'remove-1')).status).toBe(201);
    const again = await remove('CUSTK', { reason: 'again' });
    expect(again.status).toBe(409);
    expect((again.body as Refusal).error.code).toBe('no_customer_gstin_to_remove');
    expect((await trail(h, t)).map((a) => [a.action, a.actorId, a.before?.['gstin'] ?? null, a.after])).toEqual([
      ['b2b.customer_gstin.record', 'u-acct', null, { gstin: GSTIN_KL, legalName: 'Synthetic Caterers', stateCode: '32' }],
      ['b2b.customer_gstin.remove', 'u-acct', GSTIN_KL, null],
    ]);
    const read = (await s.call('GET', '/v1/b2b/accounts/CUSTK/gstin', 'u-acct')).body as { current: unknown; files: string; history: { gstin?: string; removedGstin?: string }[] };
    expect(read).toMatchObject({ current: null, files: 'b2c' });
    expect(read.history.map((f) => f.gstin ?? `removed ${f.removedGstin}`)).toEqual([GSTIN_KL, `removed ${GSTIN_KL}`]);
    expect(((await s.call('GET', '/v1/b2b/desk/CUSTK', 'u-acct')).body as { account: { gstin: unknown } }).account.gstin).toBeNull();

    // The next invoice files B2C; its blank State is the store's own again.
    const inv3 = await deliverAndInvoice(s, 'CUSTK', 3);
    expect(inv3.buyer).toBeUndefined();
    expect(inv3.gst).toMatchObject({ placeOfSupply: 'intra_state', basis: 'store_state_assumed' });

    // GSTR-1: the two invoices issued under the GSTIN stay B2B; the third is B2C with the other customer's.
    const ret = (await s.call('GET', '/v1/finance/gstr1/return', 'u-acct', undefined, RANGE)).body as { b2b: { invoiceNumber: string; recipientGstin: string; placeOfSupplyStateCode: string }[]; b2c: { taxableMinor: number }[] };
    expect(ret.b2b.map((i) => [i.invoiceNumber, i.recipientGstin, i.placeOfSupplyStateCode])).toEqual([[inv1.number, GSTIN_KL, '32'], [inv2.number, GSTIN_KL, '33']]);
    expect(ret.b2c).toEqual([expect.objectContaining({ taxableMinor: 60_000 })]);
    // OB-428: the GSTN file carries each B2B invoice's place of supply and reverse-charge flag.
    const file = (await s.call('GET', '/v1/finance/gstr1/export', 'u-acct', undefined, { ...RANGE, gstin: STORE_GSTIN, fp: FP })).body as GstnFile;
    expect(file.b2b).toHaveLength(1);
    expect(file.b2b[0]!.ctin).toBe(GSTIN_KL);
    expect(file.b2b[0]!.inv.map((i) => [i.inum, i.pos, i.rchrg, i.inv_typ, i.itms[0]!.itm_det.iamt, i.itms[0]!.itm_det.camt])).toEqual([
      [inv1.number, '32', 'N', 'R', 15, 0],
      [inv2.number, '33', 'N', 'R', 0, 7.5],
    ]);

    // Restart: the issued invoices are unchanged; a GSTIN recorded again after the removal is a new fact.
    const h2 = harness(h.durable);
    const s2 = await shop(h2, t);
    const doc = async (n: number) => (await s2.call('GET', `/v1/b2b/documents/CUSTK/inv${n}`, 'u-acct')).body as Invoice;
    expect(await doc(1)).toMatchObject({ buyer: { gstin: GSTIN_KL }, gst: { deliveryStateCode: '32', basis: 'customer_gstin_state', igstMinor: 1_500 } });
    expect(await doc(2)).toMatchObject({ buyer: { gstin: GSTIN_KL }, gst: { deliveryStateCode: '33', cgstMinor: 750 } });
    expect((await doc(3)).buyer).toBeUndefined();
    const back = await s2.ok(s2.call('POST', '/v1/b2b/accounts/CUSTK/gstin', 'u-acct', { gstin: GSTIN_KL, legalName: 'Synthetic Caterers', reason: 'registration restored' }), 're-record');
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ gstin: GSTIN_KL, previousGstin: null });
    const history = (await s2.call('GET', '/v1/b2b/accounts/CUSTK/gstin', 'u-acct')).body as { current: { gstin: string }; files: string; history: unknown[] };
    expect(history).toMatchObject({ current: { gstin: GSTIN_KL }, files: 'b2b' });
    expect(history.history).toHaveLength(3);
    expect((await trail(h2, t)).map((a) => a.action)).toEqual(['b2b.customer_gstin.record', 'b2b.customer_gstin.remove', 'b2b.customer_gstin.record']);
    const after = (await s2.call('GET', '/v1/finance/gstr1/export', 'u-acct', undefined, { ...RANGE, gstin: STORE_GSTIN, fp: FP })).body as GstnFile;
    expect(after.b2b[0]!.inv.map((i) => [i.inum, i.pos])).toEqual([[inv1.number, '32'], [inv2.number, '33']]);
  }, 120_000);

  it('a hand-entered B2B invoice that charged IGST files only with its place of supply — without one the file is refused by name', async () => {
    const h = harness();
    const t = randomUUID();
    await h.seedOwner(t, 'u-owner');
    const date = `${PERIOD}-05`;
    const igstLine = { hsnCode: '100610', quantityMinor: 1000, uom: 'kg', taxableMinor: 10_000, rateBps: 500, cgstMinor: 0, sgstMinor: 0, igstMinor: 500 };
    const record = (id: string, body: Record<string, unknown>) => h.request({ method: 'POST', path: `/v1/finance/outward-supplies/${id}`, userId: 'u-owner', tenantId: t, idempotencyKey: `o-${id}`, body: { documentDate: date, supplyType: 'b2b', recipientGstin: GSTIN_KL, annualTurnoverMinor: 6_000_000_000, lines: [igstLine], ...body } });
    expect((await record('HAND-0', { placeOfSupplyStateCode: '99' })).status).toBe(400);
    expect((await record('HAND-1', {})).status).toBe(201);
    const exportIt = () => h.request({ method: 'GET', path: '/v1/finance/gstr1/export', userId: 'u-owner', tenantId: t, query: { ...RANGE, gstin: STORE_GSTIN, fp: FP } });
    const refused = await exportIt();
    expect(refused.status).toBe(422);
    expect((refused.body as Refusal).error).toMatchObject({ code: 'gstr1_place_of_supply_not_judged', wasItSaved: 'not_saved' });
    expect((refused.body as Refusal).error.whatHappened).toContain('invoice HAND-1');
    expect((refused.body as Refusal).error.whatHappened).toContain('no place of supply is recorded');

    const h2 = harness();
    const t2 = randomUUID();
    await h2.seedOwner(t2, 'u-owner');
    const ok = await h2.request({ method: 'POST', path: '/v1/finance/outward-supplies/HAND-2', userId: 'u-owner', tenantId: t2, idempotencyKey: 'o-hand-2', body: { documentDate: date, supplyType: 'b2b', recipientGstin: GSTIN_KL, placeOfSupplyStateCode: '32', annualTurnoverMinor: 6_000_000_000, lines: [igstLine] } });
    expect(ok.status).toBe(201);
    const file = (await h2.request({ method: 'GET', path: '/v1/finance/gstr1/export', userId: 'u-owner', tenantId: t2, query: { ...RANGE, gstin: STORE_GSTIN, fp: FP } })).body as GstnFile;
    expect(file.b2b[0]!.inv[0]).toMatchObject({ inum: 'HAND-2', pos: '32', rchrg: 'N', inv_typ: 'R' });
  }, 60_000);
});
