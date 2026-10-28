import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { decide } from '../support/approval-request';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { createQuotationsSession } from '../../apps/web-erp/src/quotations-session';
import { httpQuotations } from '../../edge/store-edge/src/quotations-at-lane';
import { billVoidRecorder, QUOTATION_FREED_EVENT } from '../../edge/store-edge/src/bill-void-at-lane';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { SignedPack } from '../../services/catalogue/src/pack';
import type { DurableLog } from '../../edge/store-edge/src/durability';

/**
 * **Round 8 · R8-B — retail quotations, by the owner's decisions of 28 Oct 2026, on head office's real routes — in memory and,
 * with DATABASE_URL, on real PostgreSQL with a cold restart.**
 *   • OB-525: head office reads each product's floor ITSELF when a quotation is issued (its buying cost at the store, lifted by
 *     the store's margin floor). The page sends no floor and no cost; a line below its floor is refused until a second person
 *     approves exactly that quotation (maker-checker) — the page keeps its number, asks, and makes it again with the approval.
 *     A product never received at a cost is "floor not known", said on the answer.
 *   • OB-523: the cashier rings the quotation up, then CANCELS the whole bill at the till with a reason. The store computer
 *     keeps each line's void and the quotation's release on its disk while head office is out of reach, then sends them
 *     ONCE; head office frees the quotation (a compensating fact: who cancelled the bill, why, at which till) and a later bill
 *     rings it up. A re-send is the same release; another bill's release, another store's computer and a cashier are refused.
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
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASHIER = 'u-cash'; const BOX = 'u-box'; const BOX2 = 'u-box-2';
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

/** The box's fsync'd device-events log, in memory for the suite. */
const memoryLog = (): DurableLog & { records: string[] } => {
  const records: string[] = [];
  return { records, capacityBytes: 1e9, usedBytes: async () => 0, append: async (r) => { records.push(r); } };
};

interface Q { quotationId: string; state: string; convertedSaleId?: string; releases?: { saleId: string; freedBy: string; reason: string; laneId: string; relayedBy: string }[]; floorNotKnown?: string[] }

describe.each(backings)('quotations: head office\'s floor, and a cancelled bill frees its quotation — on $name', ({ harness, restart }) => {
  it('OB-525 floor read by head office · OB-523 cancelled at the till offline, sent once, freed, rung up again; across a cold restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MANAGER, 'store_manager', [STORE]);
    await h.provisionRole(T, CASHIER, 'cashier', [STORE]);
    await h.provisionRole(T, BOX, 'store_computer', [STORE]);
    await h.provisionRole(T, BOX2, 'store_computer', ['store-2']);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER, branchId?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(branchId === undefined ? {} : { branchId }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(req('POST', '/v1/catalogue/tax-classes/07139010/rates/2017-07-01', { rateBps: 500 }), 'tax');
    for (const [id, sku, name, code, price, mrp] of [['p-rice', 'RICE-25', 'Ponni rice 25 kg', '8901000000033', 145_000, 150_000], ['p-dal', 'DAL-500', 'Toor dal 500 g', '8901000000019', 7_200, 8_000]] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '07139010', lifecycle: 'draft', safety: { netQuantity: '1 pack' }, mrpHistory: [{ value: { minor: mrp, currency: 'INR' }, effectiveFrom: '2030-01-01' }] }, categories: [GROCERY] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: mrp, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
    }
    // Rice came into the store at ₹1,400.00 a bag (the opening stock, before any cutover GO) — its floor at store-1.
    await ok(req('POST', '/v1/inventory/goods-receipt/opening-rice', { warehouseId: STORE, receivedOnDate: '2030-01-02', currency: 'INR', lines: [{ lineId: 'L1', productId: 'p-rice', orderedMinor: 50, countedMinor: 50, uom: 'ea', unitCost: { minor: 140_000, currency: 'INR' }, condition: 'good' }] }), 'opening rice');
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish the pack');
    const pack = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;

    // ── OB-525: the manager quotes rice at ₹1,380 — below its floor. Head office refuses; the page keeps the number and asks.
    let n = 0;
    const numbers = ['48151623', '99999999'];
    const page = createQuotationsSession({ viewer: { userId: MANAGER, permissions: ['pos.quotation.read', 'pos.quotation.write'] }, fetch: asPerson(() => h, T, MANAGER, STORE), newNumber: () => numbers[n++]!, now: () => '2030-06-01T06:00:00.000Z' });
    const rice = await page.line({ code: 'RICE-25', qty: '2', priceRupees: '1380' });
    const dal = await page.line({ code: '8901000000019', qty: '3', priceRupees: '' });
    if (rice.result !== 'ok' || dal.result !== 'ok') throw new Error('lines');
    const form = { storeId: STORE, customerRef: 'Murugan Stores', validUntil: '2099-12-31', approvalId: '', lines: [rice.value, dal.value] };
    const refused = await page.make(form);
    // R9-A · OB-532: the dal was never received at a cost, so the OWNER's approval is needed (it also stands for the rice).
    expect(refused).toMatchObject({ result: 'refused', status: 422, code: 'quotation_floor_not_known_unapproved' });
    expect(page.needsOwner()).toBe(true);
    expect(page.belowFloor()).toBe('48151623');
    const asked = await page.askApproval();
    expect(asked.result, JSON.stringify(asked)).toBe('ok');
    const requestId = (asked as { value: { requestId: string } }).value.requestId;
    // The manager may not approve their own; the owner (who approves prices) does, in his own session.
    expect((await decide(h, T, MANAGER, requestId)).status).toBe(403);
    expect((await decide(h, T, OWNER, requestId)).status).toBeLessThan(300);
    const made = await page.make({ ...form, approvalId: requestId });
    expect(made, JSON.stringify(made)).toMatchObject({ result: 'ok', value: { quotationId: '48151623', floorNotKnown: ['p-dal'] } }); // dal never received at a cost
    expect(page.belowFloor()).toBeUndefined();

    // ── At the till: rung up through the store computer for this bill.
    const box = httpQuotations({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    const log = memoryLog();
    const outbox = new SyncOutbox();
    const keys = new Set<string>();
    const recordBillVoid = billVoidRecorder({ tenantId: T, keys, log, outbox, now: () => new Date().toISOString(), tradingDayOf: () => AS_OF });
    const till = bootPos({
      laneId: 'lane-1', cashierId: CASHIER, tradingDay: AS_OF, catalogue: pack.snapshot,
      quotationsPort: { convert: (i) => box.convert({ quotationNumber: i.quotationNumber, billRef: i.billRef, laneId: 'lane-1', cashierId: CASHIER }) },
      tillActivityPost: (body) => recordBillVoid({ laneId: 'lane-1', cashierId: CASHIER, via: 'pin', body }),
      durable: async () => ({ committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }),
    });
    expect((await till.ringQuotationAtTill('48151623')).ok).toBe(true);
    const firstBill = till.currentBillRef();
    expect(till.quotationsOnBill()).toEqual(['48151623']);

    // ── The customer walks away: the cashier cancels the whole bill. Head office is out of reach — the box keeps it.
    const cancelled = await till.cancelBillAtTill('customer_left');
    expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ ok: true, linesVoided: 2, quotationsFreed: ['48151623'] });
    expect(till.payableMinor()).toBe(0);
    expect(till.currentBillRef()).not.toBe(firstBill);
    expect(outbox.pending().map((i) => i.event.type)).toEqual(['TillActivityRecorded', 'TillActivityRecorded', QUOTATION_FREED_EVENT]);
    // Nothing has reached head office yet: the quotation is still on the cancelled bill there.
    const listed = async (hh: ApiHarness): Promise<Map<string, Q>> => new Map(((await hh.request({ method: 'GET', path: '/v1/pos/quotations', userId: OWNER, tenantId: T })).body as { quotations: Q[] }).quotations.map((q) => [q.quotationId, q]));
    expect((await listed(h)).get('48151623')).toMatchObject({ state: 'converted', convertedSaleId: firstBill });
    // A later bill cannot ring it while head office still has it on the cancelled bill — said, nothing rung.
    expect(await till.ringQuotationAtTill('48151623')).toMatchObject({ ok: false, refusedBecause: 'already_converted' });

    // ── The line is back: the box's queue is sent ONCE, through the same transport the sync agent uses.
    const transport = httpTransport({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    for (const item of outbox.pending()) {
      const sent = await transport.send(item.event);
      expect(sent.status, `${item.event.type}: ${JSON.stringify(sent)}`).toBe('accepted');
      outbox.acknowledge(item.key);
    }
    const freed = (await listed(h)).get('48151623')!;
    expect(freed).toMatchObject({ state: 'issued', releases: [{ saleId: firstBill, freedBy: CASHIER, reason: 'customer_left', laneId: 'lane-1', relayedBy: BOX }] });
    expect(freed.convertedSaleId).toBeUndefined();
    // Loss prevention holds each cancelled line as a void, with the cashier and the reason.
    const lp = (await h.request({ method: 'GET', path: '/v1/loss-prevention/activity', userId: OWNER, tenantId: T, query: { day: AS_OF } })).body as { voids: unknown[] };
    expect(lp.voids).toHaveLength(2);
    expect(lp.voids).toEqual([expect.objectContaining({ txnId: `${firstBill}:L1`, kind: 'void', cashierId: CASHIER, valueMinor: 2 * 138_000 }), expect.objectContaining({ txnId: `${firstBill}:L2`, kind: 'void', cashierId: CASHIER, valueMinor: 3 * 7_200 })]);

    // A re-send of the same release is the same release (the queue's own replay after a lost answer).
    const freeEvent = log.records.map((r) => JSON.parse(r) as { type: string; payload: Record<string, unknown>; idempotencyKey: string }).find((e) => e.type === QUOTATION_FREED_EVENT)!;
    expect((await transport.send(freeEvent as never)).status).toBe('accepted');
    const freeBody = freeEvent.payload;
    const again = await req('POST', '/v1/pos/quotations/48151623/free/synced', freeBody, BOX, STORE);
    expect(again.body).toMatchObject({ freed: true, alreadyFreed: true });
    expect((await listed(h)).get('48151623')!.releases).toHaveLength(1);

    // ── A later bill rings it up — once.
    expect((await till.ringQuotationAtTill('48151623')).ok).toBe(true);
    const secondBill = till.currentBillRef();
    expect((await listed(h)).get('48151623')).toMatchObject({ state: 'converted', convertedSaleId: secondBill });

    // Refusals at head office: a release naming a bill the quotation is not on; another store's computer; a cashier.
    const wrongBill = await req('POST', '/v1/pos/quotations/48151623/free/synced', { ...freeBody, freeId: 'BV-x-48151623', saleId: 'B-not-this-one' }, BOX, STORE);
    expect(wrongBill.status).toBe(422);
    expect((wrongBill.body as { error: { code: string } }).error.code).toBe('quotation_not_on_this_bill');
    expect((await req('POST', '/v1/pos/quotations/48151623/free/synced', { ...freeBody, freeId: 'BV-y-48151623', saleId: secondBill }, BOX2, 'store-2')).status).toBe(403);
    expect((await req('POST', '/v1/pos/quotations/48151623/free/synced', { ...freeBody, freeId: 'BV-z-48151623', saleId: secondBill }, CASHIER, STORE)).status).toBe(403);
    expect((await req('POST', '/v1/pos/quotations/48151623/free/synced', { ...freeBody, reason: '' }, BOX, STORE)).status).toBe(400);
    expect((await listed(h)).get('48151623')).toMatchObject({ state: 'converted', convertedSaleId: secondBill });

    // ── Cold restart: on the second bill, the first bill's release still on record; the floor's approval spent.
    h = restart(h);
    const after = (await listed(h)).get('48151623')!;
    expect(after).toMatchObject({ state: 'converted', convertedSaleId: secondBill, floorNotKnown: ['p-dal'] });
    expect(after.releases?.map((r) => r.saleId)).toEqual([firstBill]);
    // The same approval cannot make a second quotation (it was spent once).
    const reused = await h.request({ method: 'POST', path: '/v1/pos/quotations/48151699', userId: MANAGER, tenantId: T, branchId: STORE, idempotencyKey: `k-${randomUUID()}`, body: { storeId: STORE, customerRef: 'x', currency: 'INR', validUntil: '2099-12-31', approvalId: requestId, lines: [{ lineId: 'l1', productId: 'p-rice', description: 'r', unitPriceMinor: 100_000, quantityMinor: 1, uom: 'ea', taxBps: 500 }] } });
    expect(reused.status).toBeGreaterThanOrEqual(400);
  }, 120_000);
});
