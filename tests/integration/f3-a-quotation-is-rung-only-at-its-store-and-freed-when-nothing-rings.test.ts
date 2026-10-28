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
import { httpQuotations } from '../../edge/store-edge/src/quotations-at-lane';
import { billVoidRecorder, QUOTATION_FREED_EVENT } from '../../edge/store-edge/src/bill-void-at-lane';
import { httpTransport } from '../../edge/sync-agent/src/http-transport';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { SignedPack } from '../../services/catalogue/src/pack';
import type { DurableLog } from '../../edge/store-edge/src/durability';

/**
 * **Follow-ups to OB-506, on head office's real routes and the store computer's real relay — in memory and, with DATABASE_URL,
 * on real PostgreSQL with a cold restart.**
 *   • A quotation made for store-1 cannot be rung up by store-2's computer (head office refuses, the till says so in English
 *     and Tamil, nothing is converted); store-1's computer still rings it up.
 *   • A quotation the till could ring NOTHING of (here: an item this pack has no barcode for) is freed again at once: the store
 *     computer keeps the release ("nothing could be rung") while head office is out of reach and sends it ONCE; head office
 *     frees the quotation and it is rung up again. A quotation with at least one line rung stays converted, as before.
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
const memoryLog = (): DurableLog & { records: string[] } => {
  const records: string[] = [];
  return { records, capacityBytes: 1e9, usedBytes: async () => 0, append: async (r) => { records.push(r); } };
};
interface Q { quotationId: string; state: string; convertedSaleId?: string; releases?: { saleId: string; freedBy: string; reason: string; laneId: string; relayedBy: string }[] }

describe.each(backings)('quotations: rung only at their store, and freed when nothing rings — on $name', ({ harness, restart }) => {
  it('store-2 refused · nothing rung → freed offline, sent once, rung again · one line rung → stays converted; across a cold restart', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MANAGER, 'store_manager', [STORE]);
    await h.provisionRole(T, BOX, 'store_computer', [STORE]);
    await h.provisionRole(T, BOX2, 'store_computer', ['store-2']);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER, branchId?: string): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(branchId === undefined ? {} : { branchId }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };

    await ok(req('POST', '/v1/catalogue/tax-classes/07139010/rates/2017-07-01', { rateBps: 500 }), 'tax');
    // Rice has a barcode; flour has none in the pack, so the till cannot ring a quoted flour line.
    for (const [id, sku, name, code, price, mrp, cost] of [['p-rice', 'RICE-25', 'Ponni rice 25 kg', '8901000000033', 145_000, 150_000, 140_000], ['p-flour', 'FLOUR-1', 'Wheat flour 1 kg', undefined, 6_000, 6_500, 5_000]] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '07139010', lifecycle: 'draft', safety: { netQuantity: '1 pack' }, mrpHistory: [{ value: { minor: mrp, currency: 'INR' }, effectiveFrom: '2030-01-01' }] }, categories: [GROCERY] }), `publish ${id}`);
      await ok(req('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: mrp, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: '2030-01-01' }), `price ${id}`);
      if (code !== undefined) await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }), `barcode ${id}`);
      await ok(req('POST', `/v1/inventory/goods-receipt/opening-${id}`, { warehouseId: STORE, receivedOnDate: '2030-01-02', currency: 'INR', lines: [{ lineId: 'L1', productId: id, orderedMinor: 50, countedMinor: 50, uom: 'ea', unitCost: { minor: cost, currency: 'INR' }, condition: 'good' }] }), `opening ${id}`);
    }
    await ok(req('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AS_OF }), 'publish the pack');
    const pack = (await req('GET', '/v1/catalogue/pack')).body as SignedPack;

    // The manager quotes for store-1, at the till's own prices (no floor crossed): one of flour only, one of rice and flour.
    const quote = async (quotationId: string, lines: unknown[]): Promise<void> => {
      await ok(req('POST', `/v1/pos/quotations/${quotationId}`, { storeId: STORE, customerRef: 'Murugan Stores', currency: 'INR', validUntil: '2099-12-31', lines }, MANAGER, STORE), `quote ${quotationId}`);
    };
    const FLOUR = { lineId: 'l1', productId: 'p-flour', description: 'Wheat flour 1 kg', unitPriceMinor: 6_000, quantityMinor: 10, uom: 'ea', taxBps: 500 };
    const RICE = { lineId: 'l2', productId: 'p-rice', description: 'Ponni rice 25 kg', unitPriceMinor: 145_000, quantityMinor: 2, uom: 'ea', taxBps: 500 };
    await quote('11111111', [FLOUR]);
    await quote('22222222', [FLOUR, RICE]);
    const listed = async (hh: ApiHarness): Promise<Map<string, Q>> => new Map(((await hh.request({ method: 'GET', path: '/v1/pos/quotations', userId: OWNER, tenantId: T })).body as { quotations: Q[] }).quotations.map((q) => [q.quotationId, q]));

    // ── Another store: store-2's computer asks head office for store-1's quotation — refused, said, nothing converted.
    const box2 = httpQuotations({ baseUrl: 'https://head-office.test', token: 'box-2-token', fetch: asPerson(() => h, T, BOX2, 'store-2') });
    const till2 = bootPos({
      laneId: 'lane-9', cashierId: CASHIER, tradingDay: AS_OF, catalogue: pack.snapshot,
      quotationsPort: { convert: (i) => box2.convert({ quotationNumber: i.quotationNumber, billRef: i.billRef, laneId: 'lane-9', cashierId: CASHIER }) },
      durable: async () => ({ committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }),
    });
    const elsewhere = await till2.ringQuotationAtTill('22222222');
    expect(elsewhere).toMatchObject({ ok: false, refusedBecause: 'quotation_for_another_store', laneMessage: expect.stringMatching(/made for another store/), laneMessageTa: expect.stringMatching(/வேறு கடைக்காக/) });
    expect(till2.basket()).toEqual([]);
    const direct = await req('POST', '/v1/pos/quotations/22222222/convert', { saleId: 'B-store-2-x' }, BOX2, 'store-2');
    expect(direct.status).toBe(403);
    expect((direct.body as { error: { code: string } }).error.code).toBe('quotation_for_another_store');
    expect((await listed(h)).get('22222222')).toMatchObject({ state: 'issued' });

    // ── Store-1's till, through its own store computer; head office is out of reach for the queue (nothing sent yet).
    const box = httpQuotations({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    const log = memoryLog();
    const outbox = new SyncOutbox();
    const recordBillVoid = billVoidRecorder({ tenantId: T, keys: new Set(), log, outbox, now: () => new Date().toISOString(), tradingDayOf: () => AS_OF });
    const till = bootPos({
      laneId: 'lane-1', cashierId: CASHIER, tradingDay: AS_OF, catalogue: pack.snapshot,
      quotationsPort: { convert: (i) => box.convert({ quotationNumber: i.quotationNumber, billRef: i.billRef, laneId: 'lane-1', cashierId: CASHIER }) },
      tillActivityPost: (body) => recordBillVoid({ laneId: 'lane-1', cashierId: CASHIER, via: 'pin', body }),
      durable: async () => ({ committed: true, durable: true, detail: 'double', laneMessage: 'Sale complete.' }),
    });
    const firstBill = till.currentBillRef();
    const nothing = await till.ringQuotationAtTill('11111111');
    expect(nothing, JSON.stringify(nothing)).toMatchObject({ ok: true, quotationId: '11111111', added: [], quotationFreed: true, laneMessage: expect.stringMatching(/STILL OPEN/) });
    expect(nothing.notAdded?.map((n) => n.productId)).toEqual(['p-flour']);
    expect(till.basket()).toEqual([]);
    expect(till.currentBillRef()).not.toBe(firstBill);
    expect(outbox.pending().map((i) => i.event.type)).toEqual([QUOTATION_FREED_EVENT]);
    // Head office converted it before the till tried a line; the release has not reached it yet — a try now is said, not rung.
    expect((await listed(h)).get('11111111')).toMatchObject({ state: 'converted', convertedSaleId: firstBill });
    expect(await till.ringQuotationAtTill('11111111')).toMatchObject({ ok: false, refusedBecause: 'already_converted' });

    // ── The line is back: the queue is sent ONCE through the sync agent's own transport; head office frees it, reason on record.
    const transport = httpTransport({ baseUrl: 'https://head-office.test', token: 'box-token', fetch: asPerson(() => h, T, BOX, STORE) });
    const sendQueue = async (): Promise<void> => {
      for (const item of outbox.pending()) {
        const sent = await transport.send(item.event);
        expect(sent.status, `${item.event.type}: ${JSON.stringify(sent)}`).toBe('accepted');
        outbox.acknowledge(item.key);
      }
    };
    await sendQueue();
    expect(outbox.pending()).toEqual([]);
    const freed = (await listed(h)).get('11111111')!;
    expect(freed).toMatchObject({ state: 'issued', releases: [{ saleId: firstBill, freedBy: CASHIER, reason: 'nothing could be rung', laneId: 'lane-1', relayedBy: BOX }] });
    expect(freed.convertedSaleId).toBeUndefined();
    // A re-send of the same release (the queue's replay after a lost answer) is the same release.
    const freeEvent = log.records.map((r) => JSON.parse(r) as { type: string }).find((e) => e.type === QUOTATION_FREED_EVENT)!;
    expect((await transport.send(freeEvent as never)).status).toBe('accepted');
    expect((await listed(h)).get('11111111')!.releases).toHaveLength(1);

    // ── Rung again: converted to the new bill — and, nothing ringing again, freed again on its own release.
    const secondBill = till.currentBillRef();
    expect((await till.ringQuotationAtTill('11111111')).quotationFreed).toBe(true);
    await sendQueue();
    const twice = (await listed(h)).get('11111111')!;
    expect(twice.state).toBe('issued');
    expect(twice.releases?.map((r) => r.saleId)).toEqual([firstBill, secondBill]);

    // ── At least one line rung: the rice rings, the flour is listed — the quotation stays converted on this bill, nothing queued.
    const riceBill = till.currentBillRef();
    const some = await till.ringQuotationAtTill('22222222');
    expect(some).toMatchObject({ ok: true, quotationId: '22222222' });
    expect(some.quotationFreed).toBeUndefined();
    expect(some.added?.map((a) => a.qty)).toEqual([2]);
    expect(some.notAdded?.map((n) => n.productId)).toEqual(['p-flour']);
    expect(outbox.pending()).toEqual([]);
    expect(till.quotationsOnBill()).toEqual(['22222222']);
    expect((await listed(h)).get('22222222')).toMatchObject({ state: 'converted', convertedSaleId: riceBill });

    // ── Cold restart: the releases are on record; the second quotation stays on its bill.
    h = restart(h);
    const after = await listed(h);
    expect(after.get('11111111')).toMatchObject({ state: 'issued' });
    expect(after.get('11111111')!.releases?.map((r) => r.reason)).toEqual(['nothing could be rung', 'nothing could be rung']);
    expect(after.get('22222222')).toMatchObject({ state: 'converted', convertedSaleId: riceBill });
  }, 120_000);
});
