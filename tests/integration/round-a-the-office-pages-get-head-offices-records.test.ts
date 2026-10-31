import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { STORE_RULES } from '../support/store-rules';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { makeEvent } from '../../packages/contracts/src/event';
import { tradingMonthIn, shopDateIn } from '../../packages/calendar/src/shop-clock';
import { financeAdapter, eInvoiceAdapter, eWayBillAdapter } from '../../services/api/src/adapters';
import { TALLY_OUTBOX_STREAM } from '../../services/api/src/finance-bridge-adapters';
import type { IrnRequest } from '../../packages/e-invoice/src/index';

/**
 * **Round A (screen gap audit, 31 Oct 2026) — the office pages that were empty forever now carry head office's own records,
 * on the REAL store computer (`startEdge`) pulling its setup from the REAL head office (the API harness, in memory and —
 * with DATABASE_URL — on real PostgreSQL).**
 *
 *   • Products and pricing: the category register and the product master head office holds (the prices already set are
 *     read item by item through the relay — not carried in the pack, which stays small);
 *   • Expiry and recalls: this store's batches on hand with their expiry and unit (a kg batch in grams), a batch with no
 *     expiry counted, and every recall — an open one blocks its batch;
 *   • Finance: this month as head office holds it — closed and SIGNED by a named person — and the month's daily Tally files
 *     in their states; no ledger side (the page refuses to close on one side and says why);
 *   • Reports: the list of what the shop records — the same list head office's own report catalogue reads;
 *   • GST reconciliation: every e-invoice and e-way bill in head office's queue categories, a portal disagreement included.
 * With the cable OUT and after a cold restart each page still shows the store computer's copy, with when head office sent
 * it. And each page's data reaches ONLY a person who may open that page (SEC-1): a cashier gets none of them.
 */

const S1 = 'S1';
const OTHER = 'S2';
type Body = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const c of cleanups.splice(0).reverse()) await c();
});
const SETTINGS = { tradingDayCutoff: '02:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'S1-BACK' };
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function cloudAndBox(harness: () => ApiHarness) {
  const h = harness();
  const T = randomUUID();
  let n = 0;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `ra-${n++}` }), ...(body === undefined ? {} : { body }) });
  const ok = async (p: Promise<{ status: number; body: unknown }>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-box', 'store_computer', [S1]);
  await h.provisionRole(T, 'u-mgr', 'store_manager', [S1]);
  await h.provisionRole(T, 'u-acct', 'accountant', 'all');
  await h.provisionRole(T, 'u-cash', 'cashier', [S1]);
  for (const [id, body] of [['C1', { kind: 'company', name: 'SRE Retail' }], [S1, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }], [OTHER, { kind: 'branch', name: 'Second Store', parentId: 'C1', companyId: 'C1' }]] as const) {
    await ok(call('POST', `/v1/org/nodes/${id}`, 'u-owner', body), `org ${id}`);
  }
  await ok(call('POST', `/v1/stores/${S1}/settings`, 'u-owner', SETTINGS), 'settings');
  await ok(call('POST', `/v1/stores/${S1}/rules`, 'u-owner', STORE_RULES), 'rules');

  // ── Products: two products in two departments, published through head office's own product route.
  await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', 'u-owner', { rateBps: 500 }), 'tax 1006');
  await ok(call('POST', '/v1/catalogue/tax-classes/0401/rates/2017-07-01', 'u-owner', { rateBps: 0 }), 'tax 0401');
  await ok(call('POST', '/v1/catalogue/products/p-rice/publish', 'u-owner', {
    product: { sku: 'RICE-LOOSE', name: 'Ponni rice (loose)', baseUom: 'kg', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', mrpHistory: [{ value: { minor: 7_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }] },
    categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
  }), 'publish rice');
  await ok(call('POST', '/v1/catalogue/products/p-milk/publish', 'u-owner', {
    product: { sku: 'MILK-500', name: 'Toned milk 500 ml', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0401', lifecycle: 'active' },
    categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
  }), 'publish milk');

  // Their shelf prices at this store, and the catalogue head office publishes for the tills (the box's product names and units).
  const today = shopDateIn(new Date().toISOString());
  await ok(call('POST', '/v1/prices/list/p-milk/entries/e1', 'u-owner', { scope: 'store', scopeRef: S1, priceMinor: 2_800, mrpMinor: 3_000, costMinor: 2_200, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: today }), 'milk price');
  await ok(call('POST', '/v1/prices/list/p-rice/entries/e1', 'u-owner', { scope: 'store', scopeRef: S1, priceMinor: 6_200, mrpMinor: 7_000, costMinor: 4_800, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: today }), 'rice price');
  await ok(call('POST', '/v1/catalogue/pack', 'u-owner', { storeId: S1, asOf: today }), 'catalogue pack');

  // ── Batches: received at this store's floor and back store (one batch across both), one at ANOTHER store, one with no
  //    expiry on record; a recall on a milk batch.
  const now = new Date().toISOString();
  const recv = (movementId: string, productId: string, locationId: string, quantityMinor: number, uom: string, batchId: string, expiry?: string) =>
    ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId, productId, locationId, kind: 'received', quantityMinor, uom, batchId, ...(expiry === undefined ? {} : { expiry }), occurredAt: now, enteredBy: 'u-owner' }), movementId);
  await recv('m-rice-1', 'p-rice', S1, 2_500, 'kg', 'RICE-B1', inDays(10));
  await recv('m-milk-1', 'p-milk', S1, 12, 'ea', 'MILK-B7', inDays(2));
  await recv('m-milk-2', 'p-milk', 'S1-BACK', 8, 'ea', 'MILK-B7', inDays(2));
  await recv('m-milk-3', 'p-milk', S1, 5, 'ea', 'MILK-B8', inDays(5));
  await recv('m-milk-4', 'p-milk', S1, 3, 'ea', 'MILK-NODATE');
  await recv('m-other', 'p-milk', OTHER, 40, 'ea', 'MILK-ELSEWHERE', inDays(1));
  await ok(call('POST', '/v1/quality/recalls/MILK-B8', 'u-owner', { reason: 'Supplier notice: seal failure on this batch' }), 'recall');

  // ── Finance: this month closed at head office and SIGNED by the chartered accountant; two daily Tally files, one posted
  //    and one dead-lettered (head office's own lifecycle and outbox records, as the close route and the outbox write them).
  const period = tradingMonthIn(now, { timeZone: 'Asia/Kolkata', tradingDayCutoff: SETTINGS.tradingDayCutoff });
  await financeAdapter({ store: h.store, now: () => now }).markClosed(T, period, 'u-ca');
  const posting = (day: string, state: string, extra: Record<string, unknown> = {}) => ({
    postingId: `tally-day:${day}:1`, idempotencyKey: `tally-${day}-1`, period, journalRef: `tally-day:${day}:1`, debitMinor: 150_000, creditMinor: 150_000,
    state, attempts: 1, queuedAt: now, day, sequence: 1, journalIds: [`je-${day}`], ...extra,
  });
  for (const [i, p] of [posting(`${period}-01`, 'posted', { postedAt: now }), posting(`${period}-02`, 'dead_lettered', { lastFailure: 'no Tally ledger named for account 4100', deadLetteredAt: now })].entries()) {
    await h.store.append(T, TALLY_OUTBOX_STREAM, makeEvent({ id: `tally-${i}`, type: 'TallyOutboxFact', occurredAt: now, idempotencyKey: `tally-fact-${T}-${i}`, source: 'test', payload: { change: 'queued', posting: p, by: 'system:tally-outbox', at: now } }));
  }

  // ── GST: an e-invoice registered with the IRP, one the portal now disagrees with, and an e-way bill still unknown.
  const einv = eInvoiceAdapter({ store: h.store, now: () => now });
  const request = { version: '1.1' } as unknown as IrnRequest;
  await einv.recordSubmit(T, 'INV-1', request, now);
  await einv.recordResponse(T, 'INV-1', { state: 'registered', irn: 'IRN-0001', detail: 'registered with the IRP' } as never, now);
  await einv.recordSubmit(T, 'INV-2', request, now);
  await einv.recordResponse(T, 'INV-2', { state: 'registered', irn: 'IRN-0002', detail: 'registered with the IRP' } as never, now);
  await einv.recordMismatch(T, 'INV-2', { observedState: 'cancelled', note: 'the IRP now says this IRN was cancelled', observedAt: now } as never, now);
  const ewb = eWayBillAdapter({ store: h.store, now: () => now });
  await ewb.recordSubmit(T, 'MOVE-1', { version: '1.0' } as never, now);
  await ewb.recordResponse(T, 'MOVE-1', { state: 'pending_unknown', detail: 'the portal did not answer' } as never, now);

  const dir = await mkdtemp(join(tmpdir(), 'sre-round-a-box-'));
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const net = { up: true };
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
    if (!net.up) throw new Error('ECONNREFUSED');
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const u = new URL(url);
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { date: new Date().toUTCString() } });
  }) as unknown as typeof globalThis.fetch;
  const start = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_SCREEN_TRUST_FORWARDED_USER: '1', EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: S1,
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: S1 }),
    }, () => {}))!;
    cleanups.push(async () => { await edge.stop(); });
    return edge;
  };
  return { h, T, call, ok, net, start, period };
}

const screen = async (edge: EdgeProcess, path: string, global: string, user: string): Promise<{ status: number; data: Body | undefined; html: string }> => {
  const res = await savedFetch(`http://127.0.0.1:${edge.screens!.port}${path}`, { headers: { 'x-sre-user': user } });
  const html = await res.text();
  const m = new RegExp(`<script>window\\.${global} = ([\\s\\S]*?);</script>`).exec(html);
  return { status: res.status, data: m === null ? undefined : JSON.parse(m[1]!) as Body, html };
};
const storeCopy = (html: string): Body | null | undefined => {
  const m = /<script>window\.storeCopy = ([\s\S]*?);<\/script>/.exec(html);
  return m === null ? undefined : JSON.parse(m[1]!) as Body | null;
};

const backings = useBackings();

describe.each(backings)('Round A: the office pages get head office\'s records through the store computer — head office on $name', ({ harness }) => {
  it('products, expiry and recalls, the month, the reports list and the GST queue reach their pages; offline the copy stays and says its age; nobody sees a page they may not open', async () => {
    const c = await cloudAndBox(harness);
    const first = await c.start();
    expect(await first.refreshStorePack!()).toMatchObject({ status: 'updated' });

    const look = async (edge: EdgeProcess) => {
      // ── Products and pricing (the manager): head office's category register and product master.
      const cat = await screen(edge, '/catalogue/', GLOBAL_FOR.catalogue, 'u-mgr');
      expect(cat.status).toBe(200);
      expect((cat.data!['categories'] as { categoryId: string; name: string }[]).map((x) => [x.categoryId, x.name])).toEqual([['dairy', 'Dairy'], ['grocery', 'Grocery']]);
      const master = cat.data!['products'] as { productId: string; sku: string; baseUom: string; primaryCategoryId: string; mrpHistory?: unknown[] }[];
      expect(master.map((p) => [p.productId, p.sku, p.baseUom, p.primaryCategoryId])).toEqual([['p-milk', 'MILK-500', 'ea', 'dairy'], ['p-rice', 'RICE-LOOSE', 'kg', 'grocery']]);
      expect(master.find((p) => p.productId === 'p-rice')!.mrpHistory).toEqual([{ value: { minor: 7_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }]);
      // The prices already set are NOT in the pack (they are read through the relay, item by item): the page is told so.
      expect(cat.data!['priceEntries']).toBeUndefined();

      // ── Expiry and recalls (the manager): this store's batches only, one row per product and batch, in smallest steps.
      const exp = await screen(edge, '/expiry/', GLOBAL_FOR.expiry, 'u-mgr');
      expect(exp.status).toBe(200);
      const batches = exp.data!['batches'] as { batchId: string; productId: string; qty: number; uom?: string; expiry: string; state: string; recallBlocked?: boolean }[];
      expect(batches.map((b) => [b.batchId, b.productId, b.qty, b.uom, b.expiry, b.state, b.recallBlocked === true])).toEqual([
        ['MILK-B7', 'p-milk', 20, 'ea', inDays(2), 'on_hand', false], // floor 12 + back store 8, one row
        ['MILK-B8', 'p-milk', 5, 'ea', inDays(5), 'on_hand', true], // recalled: blocked
        ['RICE-B1', 'p-rice', 2_500, 'kg', inDays(10), 'on_hand', false], // 2.500 kg, in grams
      ]);
      expect(batches.some((b) => b.batchId === 'MILK-ELSEWHERE')).toBe(false); // another store's stock is not this store's list
      expect(exp.data!['batchesWithoutExpiry']).toBe(1); // MILK-NODATE: counted, never given a date
      expect(exp.data!['productUnits']).toMatchObject({ 'p-rice': 'kg', 'p-milk': 'ea' });
      const recalls = exp.data!['recalls'] as { recallId: string; batchId: string; productId: string; reason: string; startedBy: string; closure?: unknown }[];
      expect(recalls.map((r) => [r.recallId, r.batchId, r.productId, r.startedBy, r.closure === undefined])).toEqual([['recall-MILK-B8', 'MILK-B8', 'p-milk', 'u-owner', true]]);
      expect(typeof exp.data!['copyReceivedAt']).toBe('string');

      // ── Finance (the accountant, company-wide): the month closed and signed at head office; its Tally files; no ledger side.
      const fin = await screen(edge, '/finance/', GLOBAL_FOR.finance, 'u-acct');
      expect(fin.status).toBe(200);
      expect(fin.data!['periodState']).toMatchObject({ period: c.period, closed: true, signedBy: 'u-ca' });
      expect(typeof (fin.data!['periodState'] as Body)['closedAt']).toBe('string');
      expect((fin.data!['postings'] as { postingId: string; state: string; debitMinor: number }[]).map((p) => [p.postingId, p.state, p.debitMinor]))
        .toEqual([[`tally-day:${c.period}-01:1`, 'posted', 150_000], [`tally-day:${c.period}-02:1`, 'dead_lettered', 150_000]]);
      expect(fin.data!['ledger']).toBeUndefined();

      // ── Reports (the manager): what the shop records, as head office's own catalogue reads it — never an empty list.
      const rep = await screen(edge, '/reporting/', GLOBAL_FOR.reporting, 'u-mgr');
      expect(rep.status).toBe(200);
      expect(rep.data!['records']).toEqual(expect.arrayContaining(['sales_rung_at_the_till', 'cost_prices_on_the_catalogue', 'departments_on_the_catalogue', 'the_boxs_own_outbox']));

      // ── GST reconciliation (the manager): head office's queue, the portal's disagreement surfaced as it was observed.
      const gst = await screen(edge, '/gst-reconciliation/', GLOBAL_FOR['gst-reconciliation'], 'u-mgr');
      expect(gst.status).toBe(200);
      expect((gst.data!['rows'] as { documentType: string; id: string; category: string; number?: string; mismatch?: { observedState: string } }[]).map((r) => [r.documentType, r.id, r.category, r.number ?? null, r.mismatch?.observedState ?? null])).toEqual([
        ['e_invoice', 'INV-1', 'registered', 'IRN-0001', null],
        ['e_invoice', 'INV-2', 'mismatch', 'IRN-0002', 'cancelled'],
        ['e_way_bill', 'MOVE-1', 'unknown', null, null],
      ]);

      // ── Every page says how old the store computer's copy is (P-08).
      for (const html of [cat.html, exp.html, fin.html, rep.html, gst.html]) {
        const copy = storeCopy(html);
        expect(copy).toMatchObject({ shownAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/) as unknown });
        expect(typeof (copy as Body)['ageMinutes']).toBe('number');
      }

      // ── SEC-1: a page's data reaches only a person who may open that page.
      for (const [path, global] of [['/finance/', GLOBAL_FOR.finance], ['/expiry/', GLOBAL_FOR.expiry], ['/reporting/', GLOBAL_FOR.reporting], ['/gst-reconciliation/', GLOBAL_FOR['gst-reconciliation']]] as const) {
        const refused = await screen(edge, path, global, 'u-cash');
        expect(refused.status, path).toBe(403);
        expect(refused.data, path).toBeUndefined();
        expect(refused.html, path).not.toContain('IRN-0001');
        expect(refused.html, path).not.toContain('tally-day');
      }
      // The accountant reads the month but not the GST queue or the recalls (not their word).
      expect((await screen(edge, '/gst-reconciliation/', GLOBAL_FOR['gst-reconciliation'], 'u-acct')).status).toBe(403);
      expect((await screen(edge, '/expiry/', GLOBAL_FOR.expiry, 'u-acct')).status).toBe(403);
    };

    await look(first);

    // ── THE CABLE IS CUT; COLD RESTART: every page still shows the store computer's copy, and says when it came.
    c.net.up = false;
    await first.stop(); cleanups.pop();
    const offline = await c.start();
    expect(await offline.refreshStorePack!()).toMatchObject({ status: 'offline' });
    await look(offline);
  }, 120_000);
});
