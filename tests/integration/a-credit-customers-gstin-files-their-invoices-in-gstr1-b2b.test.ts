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
 * **OB-416 (owner, option A, 27 Oct 2026, in writing · A5 · M22) — the customer's GSTIN on a credit account.** On the real
 * head-office API (in memory and, with DATABASE_URL, on real PostgreSQL):
 *   • the person who manages B2B accounts records the customer's GSTIN and the legal name under it, with a reason — checked
 *     for length, shape, check character and State code; a bad one is refused BY NAME and nothing is recorded; a cashier
 *     cannot set it; no credit account → refused;
 *   • the record is an append-only fact naming who, when, why and the GSTIN it superseded, and it is in the M34 audit trail;
 *     a re-sent change collapses (no second fact, no second audit record);
 *   • a tax invoice issued while the GSTIN is on record prints the buyer (GSTIN, name, State) and files invoice-by-invoice in
 *     GSTR-1's B2B section under that GSTIN (and the GSTN file's `ctin`); a customer with none files B2C rate-wise, as before;
 *   • after a change and a restart, the earlier invoice still names (and files under) the GSTIN it was issued with (OB-415);
 *     the next invoice takes the new one.
 * Every GSTIN here is synthetic ("ZZZZZ9999Z" is no real PAN) with a valid check character.
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
// A restart builds a new head office over the SAME durable records: the event store and the gap-free number series.
type Durable = { readonly store: EventStore; readonly numberSeries: NumberSeriesStore };
const backings: { name: string; harness: (durable?: Durable) => ApiHarness & { durable: Durable } }[] = [{
  name: 'the in-memory event store',
  harness: (d) => { const durable = d ?? { store: new InMemoryEventStore(), numberSeries: new InMemoryNumberSeriesStore() }; return Object.assign(apiHarness(durable), { durable }); },
}];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: (d) => { const sql = pgPoolClient(pool!); const durable = d ?? { store: new SqlEventStore(sql), numberSeries: new SqlNumberSeriesStore(sql) }; return Object.assign(apiHarness({ ...durable, idempotency: new SqlIdempotencyStore(sql) }), { durable }); } });

/** Synthetic, valid-shaped GSTINs (Tamil Nadu 33, Kerala 32) — no real business. */
const GSTIN_TN = '33ZZZZZ9999Z1ZF';
const GSTIN_TN_NEW = '33ZZZZZ8888Z1ZL';
const STORE_GSTIN = '33AABCS1429B1Z1';
const PERIOD = shopMonthIn(new Date().toISOString());
const LINES = [{ lineId: 'l1', productId: 'p1', description: 'Rice 25kg', qty: 10, unitPriceMinor: 10_000, taxRateBps: 500 }];

interface Refusal { error: { code: string; whatHappened: string; wasItSaved: string } }
interface Gstr1 { documentCount: number; totalTaxMinor: number; b2b: { recipientGstin: string; invoiceNumber: string; invoiceValueMinor: number; rateLines: { rateBps: number; taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number }[] }[]; b2c: { rateBps: number; taxableMinor: number }[] }

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

/** The store's GSTIN (Tamil Nadu), rice's HSN in the published catalogue, stock at the store. */
async function storeReady(h: ApiHarness, t: string, s: Awaited<ReturnType<typeof shop>>) {
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

/** A credit customer with an order of 10 rice at 5%, ready to deliver. */
async function customerWithAnOrder(h: ApiHarness, t: string, s: Awaited<ReturnType<typeof shop>>, customerId: string) {
  await s.ok(setApprovedCreditLimit(h, t, 'u-owner', customerId, { creditLimitMinor: 10_000_000, paymentTermsDays: 30 }, { checker: 'u-acct' }), `${customerId} terms`);
  await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/quotations/q1`, 'u-owner', { lines: await onThePriceList(harnessPriceList(h, t), customerId, LINES) }), 'quote');
  await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/orders/so1`, 'u-owner', { fromQuotationId: 'q1', locationId: 'S1' }), 'order');
}
const deliverAndInvoice = async (s: Awaited<ReturnType<typeof shop>>, customerId: string, n: number, qty: number) => {
  await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/challans/dc${n}`, 'u-owner', { fromOrderId: 'so1', dispatched: { l1: qty } }), `challan ${n}`);
  return (await s.ok(s.call('POST', `/v1/b2b/documents/${customerId}/invoices/inv${n}`, 'u-owner', { fromOrderId: 'so1' }), `invoice ${n}`)).body as { number: string; grossMinor: number; buyer?: Record<string, string>; gst?: { placeOfSupply: string } };
};
const trail = async (h: ApiHarness, t: string) => (await h.store.readStream(t, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' }))
  .map((e) => e.event.payload as { action: string; actorId: string; objectId: string; reason?: string; before: Record<string, string> | null; after: Record<string, string> | null })
  .filter((a) => a.action.startsWith('b2b.customer_gstin'));

describe.each(backings)('OB-416 — a credit customer\'s GSTIN files their tax invoices in GSTR-1\'s B2B section — on $name', ({ harness }) => {
  it('a bad GSTIN is refused by name; who may set it is who manages B2B accounts; the record is append-only and audited', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    const set = (customerId: string, body: unknown, userId = 'u-acct', key?: string) => s.call('POST', `/v1/b2b/accounts/${customerId}/gstin`, userId, body, undefined, key);
    const good = { gstin: GSTIN_TN, legalName: 'Synthetic School Trust', reason: 'customer gave their GST certificate' };

    // No credit account yet → refused, nothing recorded.
    const noAccount = await set('CUSTG', good);
    expect(noAccount.status).toBe(404);
    await s.ok(setApprovedCreditLimit(h, t, 'u-owner', 'CUSTG', { creditLimitMinor: 1_000_000 }, { checker: 'u-acct' }), 'terms');

    // Each bad GSTIN refused by name (422), and why — never recorded.
    const typo = await set('CUSTG', { ...good, gstin: '33ZZZZZ9999Z1ZA' });
    expect(typo.status).toBe(422);
    expect((typo.body as Refusal).error).toMatchObject({ code: 'customer_gstin_not_valid', wasItSaved: 'not_saved' });
    expect((typo.body as Refusal).error.whatHappened).toMatch(/check character does not match/);
    const short = await set('CUSTG', { ...good, gstin: '33ZZZZZ9999Z1Z' });
    expect((short.body as Refusal).error).toMatchObject({ code: 'customer_gstin_not_valid' });
    expect((short.body as Refusal).error.whatHappened).toMatch(/15 characters, this is 14/);
    const shape = await set('CUSTG', { ...good, gstin: '3ZZZZZZ9999Z1ZF' });
    expect((shape.body as Refusal).error.whatHappened).toMatch(/does not follow the GSTIN pattern/);
    const state = await set('CUSTG', { ...good, gstin: '99ZZZZZ9999Z1ZX' });
    expect(state.status).toBe(422);
    expect((state.body as Refusal).error).toMatchObject({ code: 'customer_gstin_state_unknown' });
    expect((state.body as Refusal).error.whatHappened).toMatch(/\(99\) are not a GST State code/);
    const noReason = await set('CUSTG', { gstin: GSTIN_TN, legalName: 'Synthetic School Trust' });
    expect(noReason.status).toBe(400);
    expect((noReason.body as Refusal).error.code).toBe('not_readable_as_a_customer_gstin');
    // A cashier does not manage B2B accounts.
    expect((await set('CUSTG', good, 'u-cash')).status).toBe(403);
    const none = (await s.call('GET', '/v1/b2b/accounts/CUSTG/gstin', 'u-acct')).body as { current: unknown; files: string; history: unknown[] };
    expect(none).toMatchObject({ current: null, files: 'b2c', history: [] });
    expect(await trail(h, t)).toEqual([]);

    // Recorded by the accountant: who, when, why; State from the GSTIN; in the audit trail.
    const first = await set('CUSTG', { ...good, gstin: ` ${GSTIN_TN.toLowerCase()} ` }, 'u-acct', 'gstin-first');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ customerId: 'CUSTG', gstin: GSTIN_TN, legalName: 'Synthetic School Trust', stateCode: '33', stateName: 'Tamil Nadu', recordedBy: 'u-acct', previousGstin: null, reason: 'customer gave their GST certificate' });
    expect((first.body as { recordedAt: string }).recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await trail(h, t)).toEqual([expect.objectContaining({ action: 'b2b.customer_gstin.record', actorId: 'u-acct', objectId: 'CUSTG', reason: 'customer gave their GST certificate', before: null, after: { gstin: GSTIN_TN, legalName: 'Synthetic School Trust', stateCode: '33' } })]);

    // The same again changes nothing: no second fact, no second audit record.
    const again = await set('CUSTG', good);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadySet: true, gstin: GSTIN_TN });
    // A re-sent request (same idempotency key) replays.
    expect((await set('CUSTG', { ...good, gstin: ` ${GSTIN_TN.toLowerCase()} ` }, 'u-acct', 'gstin-first')).status).toBe(201);
    expect(await trail(h, t)).toHaveLength(1);

    // A change is a new fact naming the one it superseded — the earlier one is kept.
    const changed = await set('CUSTG', { gstin: GSTIN_TN_NEW, legalName: 'Synthetic School Trust', reason: 'the trust re-registered' }, 'u-owner');
    expect(changed.status).toBe(201);
    expect(changed.body).toMatchObject({ gstin: GSTIN_TN_NEW, previousGstin: GSTIN_TN, recordedBy: 'u-owner' });
    const history = (await s.call('GET', '/v1/b2b/accounts/CUSTG/gstin', 'u-acct')).body as { current: { gstin: string }; files: string; history: { gstin: string }[] };
    expect(history.current.gstin).toBe(GSTIN_TN_NEW);
    expect(history.files).toBe('b2b');
    expect(history.history.map((r) => r.gstin)).toEqual([GSTIN_TN, GSTIN_TN_NEW]);
    expect((await trail(h, t)).map((a) => [a.action, a.actorId, a.before?.['gstin'] ?? null, a.after?.['gstin']])).toEqual([
      ['b2b.customer_gstin.record', 'u-acct', null, GSTIN_TN],
      ['b2b.customer_gstin.change', 'u-owner', GSTIN_TN, GSTIN_TN_NEW],
    ]);
    // The desk shows the GSTIN its next invoice is made out to.
    const desk = (await s.call('GET', '/v1/b2b/desk/CUSTG', 'u-acct')).body as { account: { gstin: { gstin: string; stateName: string } | null } };
    expect(desk.account.gstin).toMatchObject({ gstin: GSTIN_TN_NEW, stateName: 'Tamil Nadu' });
  }, 60_000);

  it('an invoice issued with a GSTIN on record prints the buyer and files B2B under it; without one it files B2C; a change after it and a restart never alter it', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await shop(h, t);
    await storeReady(h, t, s);
    await customerWithAnOrder(h, t, s, 'CUSTG');
    await customerWithAnOrder(h, t, s, 'CUSTX'); // never gives a GSTIN
    await s.ok(s.call('POST', '/v1/b2b/accounts/CUSTG/gstin', 'u-acct', { gstin: GSTIN_TN, legalName: 'Synthetic School Trust', reason: 'GST certificate on file' }), 'gstin');

    // 5 of 10 delivered and invoiced: ₹500 + ₹25 GST (₹12.50 CGST + ₹12.50 SGST, delivered inside Tamil Nadu).
    const inv1 = await deliverAndInvoice(s, 'CUSTG', 1, 5);
    expect(inv1).toMatchObject({ grossMinor: 52_500, buyer: { gstin: GSTIN_TN, legalName: 'Synthetic School Trust', stateCode: '33', stateName: 'Tamil Nadu' }, gst: { placeOfSupply: 'intra_state' } });
    const printed = (await s.call('GET', '/v1/b2b/documents/CUSTG/inv1', 'u-acct')).body as { buyer?: { gstin: string } };
    expect(printed.buyer).toMatchObject({ gstin: GSTIN_TN });
    const plain = await deliverAndInvoice(s, 'CUSTX', 1, 10);
    expect(plain.buyer).toBeUndefined();

    const range = { from: `${PERIOD}-01`, to: `${PERIOD}-31` };
    const ret = (await s.call('GET', '/v1/finance/gstr1/return', 'u-acct', undefined, range)).body as Gstr1;
    expect(ret.b2b).toEqual([{ recipientGstin: GSTIN_TN, invoiceNumber: inv1.number, invoiceDate: expect.any(String), invoiceValueMinor: 52_500, placeOfSupplyStateCode: '33', rateLines: [{ rateBps: 500, taxableMinor: 50_000, cgstMinor: 1_250, sgstMinor: 1_250, igstMinor: 0 }] }]);
    // The customer with no GSTIN files B2C, rate-wise, exactly as before.
    expect(ret.b2c).toEqual([expect.objectContaining({ rateBps: 500, taxableMinor: 100_000, cgstMinor: 2_500, sgstMinor: 2_500 })]);
    expect(ret).toMatchObject({ documentCount: 2, totalTaxMinor: 7_500 });
    const file = (await s.call('GET', '/v1/finance/gstr1/export', 'u-acct', undefined, { ...range, gstin: STORE_GSTIN, fp: `${PERIOD.slice(5, 7)}${PERIOD.slice(0, 4)}` })).body as { b2b: { ctin: string; inv: { inum: string; val: number }[] }[] };
    expect(file.b2b).toEqual([{ ctin: GSTIN_TN, inv: [expect.objectContaining({ inum: inv1.number, val: 525, pos: '33', rchrg: 'N' })] }]); // OB-428

    // The customer's GSTIN changes; head office restarts.
    await s.ok(s.call('POST', '/v1/b2b/accounts/CUSTG/gstin', 'u-acct', { gstin: GSTIN_TN_NEW, legalName: 'Synthetic School Trust', reason: 'the trust re-registered' }), 'change');
    const h2 = harness(h.durable);
    const s2 = await shop(h2, t);
    expect(((await s2.call('GET', '/v1/b2b/accounts/CUSTG/gstin', 'u-acct')).body as { current: { gstin: string } }).current.gstin).toBe(GSTIN_TN_NEW);
    // The invoice already issued keeps the GSTIN it was made out to (OB-415) …
    expect(((await s2.call('GET', '/v1/b2b/documents/CUSTG/inv1', 'u-acct')).body as { buyer: { gstin: string } }).buyer.gstin).toBe(GSTIN_TN);
    // … and the next one takes the new GSTIN.
    const inv2 = await deliverAndInvoice(s2, 'CUSTG', 2, 5);
    expect(inv2.buyer).toMatchObject({ gstin: GSTIN_TN_NEW });
    const after = (await s2.call('GET', '/v1/finance/gstr1/return', 'u-acct', undefined, range)).body as Gstr1;
    expect(after.b2b.map((i) => [i.recipientGstin, i.invoiceNumber])).toEqual([[GSTIN_TN_NEW, inv2.number], [GSTIN_TN, inv1.number]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    expect(after.totalTaxMinor).toBe(10_000);
  }, 90_000);
});
