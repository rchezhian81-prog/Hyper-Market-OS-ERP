import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { GLOBAL_FOR } from '../../edge/store-edge/src/screen-data';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { TaxInvoiceRefusedError } from '../../apps/pos/src/session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { STREAM } from '../../services/api/src/adapters';
import { prepareTillBox, signInTill, pinOf } from '../support/till-operator';

/**
 * **OB-271 follow-ups — real trading (switched OFF during the mirror pilot, OB-248), from head office's catalogue through a
 * real store computer and the till's own model back to head office: in memory AND on real PostgreSQL, head office and the
 * box each restarted COLD.**
 *
 *   • head office publishes an item with its HSN code; the STORE PACK it serves carries the HSN on each product, so a box
 *     trading from its pack file (no signed price list pulled) gives the till a catalogue WITH the HSN: the real-trading
 *     bill is a tax invoice; an item with no HSN is refused before the disk (the A1 checker's words);
 *   • two card payments with the machine's approval numbers; an EXCHANGE whose difference goes back to the card: the
 *     replacement is charged its rounded bill (OB-279 · OB-285 — never above it), and the refund is DONE on the machine with
 *     its reference and a manager's PIN (before: it stayed "pending" — the box refused to record it);
 *   • the manager's day close on the box lists both payments with their approval numbers and the refund done on the
 *     machine — after the box restarts cold too; a box in the mirror pilot lists nothing of the kind;
 *   • head office's settlement review ticks the payment on the machine's slip by its APPROVAL NUMBER, matches the slip's
 *     refund against it, and keeps the payment with no slip line as an exception.
 *
 * Synthetic data only (hard rule #7).
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
  const onPg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL, head office restarted cold', harness: onPg, restart: () => onPg() });
}

const STORE = 'store-1';
const GSTIN = '33AABCS1429B1Z1';
const LEGAL = 'SRE Hyper Market Private Limited';
const ADDRESS = ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'];
const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];
const DAL = { productId: 'P1', sku: 'DAL', name: 'Toor dal 1kg', barcode: '8901234567890', price: 10_500, hsn: '071360' };
const SUGAR = { productId: 'P3', sku: 'SUGAR', name: 'Sugar 500g', barcode: '8901234567892', price: 5_000, hsn: '170199' };
const OLD = { productId: 'P2', name: 'Old pack item', barcode: '8901234567891' };

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A screen's payload as the box served it, read out of the page. */
const served = async <T>(edge: EdgeProcess, screen: 'pos' | 'manager'): Promise<T> => {
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/${screen}/`)).text();
  const m = new RegExp(`<script>window\\.${GLOBAL_FOR[screen]} = ([\\s\\S]*?);</script>`).exec(html);
  expect(m, `the ${screen} screen was served no data`).not.toBeNull();
  return JSON.parse(m![1]!) as T;
};
interface CardDay { paid: { kind: string; amountMinor: number; machineRef: string | null; saleId: string | null }[]; refundsOnMachine: { returnId: string; amountMinor: number; machineRef: string | null; approvedBy: string | null }[]; paidTotalMinor: number }

describe.each(backings)('OB-271 follow-ups — HSN from the pack file, the card day on the manager\'s close, the exchange refund on the machine, settlement by approval number — on $name', ({ harness, restart }) => {
  it('from head office\'s catalogue to the till and the box, and back to head office\'s settlement review, across cold restarts', async () => {
    let h = harness();
    const T = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', [STORE]);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-lanecash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };

    // ── Head office: the shop, and two items published with their HSN codes (the tax class is the HSN).
    await ok(call('PUT', '/v1/platform/setup/locale.time_zone', 'u-owner', { value: 'UTC' }), 'time zone');
    await ok(call('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: LEGAL }), 'company');
    await ok(call('POST', `/v1/org/gst-registrations/${GSTIN}`, 'u-owner', { companyId: 'SRE', legalName: LEGAL }), 'registration');
    await ok(call('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: GSTIN, placeOfBusiness: `${ADDRESS[0]}\n\n${ADDRESS[1]}` }), 'store');
    await ok(call('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 }), 'settings');
    for (const p of [DAL, SUGAR]) {
      await ok(call('POST', `/v1/catalogue/tax-classes/${p.hsn}/rates/2017-07-01`, 'u-owner', { rateBps: 500 }), `tax ${p.hsn}`);
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/publish`, 'u-owner', {
        product: { sku: p.sku, name: p.name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: p.hsn, lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      }), `publish ${p.productId}`);
      await ok(call('POST', `/v1/prices/list/${p.productId}/entries/e1`, 'u-owner', { scope: 'store', scopeRef: STORE, priceMinor: p.price, mrpMinor: p.price, costMinor: Math.round(p.price * 0.8), marginFloorBps: 0, currency: 'INR', effectiveFrom: today }), `price ${p.productId}`);
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/barcodes/${p.barcode}`, 'u-owner', { kind: 'ean' }), `barcode ${p.productId}`);
    }
    await ok(call('POST', '/v1/catalogue/pack', 'u-owner', { storeId: STORE, asOf: today }), 'catalogue pack');
    h = restart(h); // ── head office COLD ────────────────────────────────────────────────────────────────────────────
    const storePack = await h.request({ method: 'GET', path: `/v1/store-packs/${STORE}`, userId: 'u-box', tenantId: T, branchId: STORE });
    expect(storePack.status, JSON.stringify(storePack.body)).toBe(200);
    const sections = (storePack.body as { sections: { products: Record<string, unknown>[]; policies: { taxInvoice?: unknown } } }).sections;
    // OB-271 · A1: the store pack's products carry the HSN head office published.
    expect(sections.products.map((p) => [p['productId'], p['hsnCode']])).toEqual(expect.arrayContaining([[DAL.productId, DAL.hsn], [SUGAR.productId, SUGAR.hsn]]));
    expect(sections.policies.taxInvoice).toEqual({ legalName: LEGAL, gstin: GSTIN, placeOfBusiness: ADDRESS });

    // ── The store computer trades from its PACK FILE (no signed price list pulled): head office's products, plus one from an
    // older pack that carries no HSN. Head office is reached through a stand-in fetch.
    let online = true;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: STORE }), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    const dir = await mkdtemp(join(tmpdir(), 'sre-real-trading-follow-ups-'));
    dirs.push(dir);
    const PACK = {
      policies: { storeId: STORE, branchId: STORE, branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', taxInvoice: sections.policies.taxInvoice },
      servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
      lossPreventionRules: [],
      products: [
        ...sections.products,
        { productId: OLD.productId, name: OLD.name, categoryId: 'grocery', unitPriceMinor: 2_000, uom: 'ea', barcodes: [OLD.barcode], availableMinor: 5, taxBps: 500, status: 'active' },
      ],
    };
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    const startBox = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: STORE }),
        EDGE_REAL_TRADING: '1', ...ready,
      }, () => {}))!;
      stops.push(() => edge.stop());
      return edge;
    };
    let edge = await startBox();

    // ── The till's catalogue, as the box serves it from the pack file: WITH each HSN; the older item without one.
    const catalogue = await served<CatalogueSnapshot & { products: { productId: string; hsnCode?: string }[] }>(edge, 'pos');
    expect(catalogue.products.find((p) => p.productId === DAL.productId)?.hsnCode).toBe(DAL.hsn);
    expect(catalogue.products.find((p) => p.productId === SUGAR.productId)?.hsnCode).toBe(SUGAR.hsn);
    expect(catalogue.products.find((p) => p.productId === OLD.productId)).not.toHaveProperty('hsnCode');
    const till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, catalogue, realTrading: true, taxInvoice: PACK.policies.taxInvoice as never, refundPolicy: { approvalThresholdMinor: 1_000_000 } });
    await signInTill(till, 'u-lanecash');

    // The item with no HSN: the real-trading bill is refused before the disk, in the A1 checker's words.
    till.scanBarcode(OLD.barcode);
    const r0 = await till.nextReceipt();
    await expect(till.tenderCash(`S-${r0}`, r0, new Date().toISOString())).rejects.toBeInstanceOf(TaxInvoiceRefusedError);
    await expect(till.tenderCash(`S-${r0}`, r0, new Date().toISOString())).rejects.toMatchObject({ laneMessage: expect.stringContaining('an item has no HSN code') });
    expect(await readLog(edge.log.path)).toHaveLength(0);
    till.newSale();

    // ── Two card payments, each with the machine's approval number; the HSN from the pack file on the tax invoice.
    const cardSale = async (code: string, machineRef: string): Promise<string> => {
      till.newSale();
      till.scanBarcode(code);
      const started = await till.startCardPayment('card');
      expect(await till.answerCardPayment(started.attemptId!, 'approved', undefined, machineRef)).toMatchObject({ ok: true, machineRef });
      const r = await till.nextReceipt();
      await till.tenderCardOrUpi({ saleId: `S-${r}`, receiptNumber: r, atIsoUtc: new Date().toISOString(), kind: 'card', outcome: 'approved', ref: started.attemptId!, machineRef });
      return r;
    };
    const r1 = await cardSale(DAL.barcode, 'A1B2C3');
    const invoice = till.taxInvoice();
    if (!invoice.ok) throw new Error(invoice.why);
    expect(invoice.lines.join('\n')).toContain(`HSN ${DAL.hsn}`);
    const r2 = await cardSale(DAL.barcode, 'Z9Y8X7');

    // ── An EXCHANGE against the first bill: one dal (₹105.00) back, sugar out. Sugar's bill is rounded DOWN (OB-279: CGST
    // and SGST ₹1.19 each round to ₹1) to ₹49.62, so the shop owes the customer ₹55.38 — back to the card.
    till.newSale();
    till.scanBarcode(SUGAR.barcode);
    const bill = (await till.lookupRefund(r1))!;
    const returnLines = [{ productId: DAL.productId, uom: 'ea', quantityMinor: 1, disposition: 'resell' as const }];
    expect(bill.exchange.quote(returnLines)).toMatchObject({ ok: true, returnedValueMinor: 10_500, replacementTotalMinor: 4_962, balance: 'refund', balanceMinor: 5_538 });
    const xn = await till.nextReceipt();
    const rn = await till.nextReceipt();
    const exchanged = await bill.exchange.complete({ exchangeId: `RT-${xn}`, number: xn, reasonCode: 'damaged', returnLines, replacementSaleId: `S-${rn}`, replacementReceipt: rn, settlement: { refundTender: 'card' } });
    expect(exchanged).toMatchObject({ kind: 'done', balance: 'refund', balanceMinor: 5_538, refundStatus: 'pending' });
    // The replacement is charged its bill (₹49.62), paid by the credit — never the lines' ₹50.00.
    const replacement = (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as { id: string; total: number; roundOffMinor?: number; tenders: { kind: string; amount: { minor: number } }[] } : undefined)).find((s) => s?.id === `S-${rn}`);
    expect(replacement).toMatchObject({ total: 4_962, roundOffMinor: -38, tenders: [expect.objectContaining({ kind: 'exchange_credit', amount: expect.objectContaining({ minor: 4_962 }) })] });

    // The difference is DONE on the machine: its reference, a manager's own PIN — recorded once, for exactly that amount.
    const approval = await till.approveAtTill({ managerId: 'u-mgr', pin: pinOf('u-mgr'), kind: 'card_refund_on_machine', billRef: `RT-${xn}`, valueMinor: 5_538, reason: 'seen on the slip' });
    if (!approval.approved) throw new Error(approval.laneMessage);
    expect(await till.recordCardRefundOnMachine({ returnId: `RT-${xn}`, refundMinor: 10_500, refundTender: 'card', machineRef: 'R55555', approval })).toMatchObject({ ok: false, refusedBecause: 'card_refund_not_here' });
    expect(await till.recordCardRefundOnMachine({ returnId: `RT-${xn}`, refundMinor: 5_538, refundTender: 'upi', machineRef: 'R55555', approval })).toMatchObject({ ok: false, refusedBecause: 'card_refund_not_here' });
    expect(await till.recordCardRefundOnMachine({ returnId: `RT-${xn}`, refundMinor: 5_538, refundTender: 'card', machineRef: 'R55555', approval })).toMatchObject({ ok: true });
    expect(await till.recordCardRefundOnMachine({ returnId: `RT-${xn}`, refundMinor: 5_538, refundTender: 'card', machineRef: 'R55555', approval })).toMatchObject({ ok: false, refusedBecause: 'card_refund_already_recorded' });

    // ── The manager's day close on the box: both payments with their approval numbers, and the refund done on the machine.
    const expectDay = (day: CardDay | undefined): void => {
      expect(day?.paid.map((p) => [p.kind, p.amountMinor, p.machineRef, p.saleId])).toEqual([['card', 10_500, 'A1B2C3', `S-${r1}`], ['card', 10_500, 'Z9Y8X7', `S-${r2}`]]);
      expect(day?.paidTotalMinor).toBe(21_000);
      expect(day?.refundsOnMachine).toEqual([expect.objectContaining({ returnId: `RT-${xn}`, amountMinor: 5_538, machineRef: 'R55555', approvedBy: 'u-mgr' })]);
    };
    expectDay((await served<{ cardPayments?: CardDay }>(edge, 'manager')).cardPayments);

    // ── The line is cut; the box and head office both restart COLD; the list is still whole, and everything reaches head office.
    online = false;
    await edge.stop();
    stops.splice(0);
    h = restart(h);
    edge = await startBox();
    expectDay((await served<{ cardPayments?: CardDay }>(edge, 'manager')).cardPayments);
    online = true;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const banked = (await h.store.readStream(T, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as { saleId?: string; totalMinor?: number; tenders?: { kind: string; amountMinor: number }[] });
    expect(banked.find((s) => s.saleId === `S-${rn}`)).toMatchObject({ totalMinor: 4_962, tenders: [expect.objectContaining({ kind: 'exchange_credit', amountMinor: 4_962 })] });
    const activity = await ok(call('GET', '/v1/loss-prevention/activity', 'u-owner', undefined, { day: today }), 'activity');
    expect(activity['cardRefundsOnMachine']).toEqual([expect.objectContaining({ billRef: `RT-${xn}`, machineRef: 'R55555', refundTender: 'card', valueMinor: 5_538, approvedBy: 'u-mgr' })]);

    // ── Head office's settlement review, against the machine's settlement slip typed in as the provider's file: the first
    // payment and its refund are on the slip under the approval number; the second is not.
    await ok(call('POST', '/v1/settlement/batches', 'u-acct', {
      batchId: `SLIP-${today}`, providerId: 'shop-card-machine', currency: 'INR', settlementDate: today,
      lines: [{ id: 'L1', ref: 'A1B2C3', amountMinor: 10_500 }, { id: 'L2', ref: 'R55555', type: 'refund', originalRef: 'A1B2C3', amountMinor: 5_538 }],
      declaredGrossMinor: 4_962, declaredFeesMinor: 0, declaredNetMinor: 4_962,
    }), 'the machine\'s slip');
    h = restart(h); // ── head office COLD again ──────────────────────────────────────────────────────────────────────
    const review = await ok(call('GET', '/v1/settlement/review', 'u-acct', undefined, { date: today, cycleDays: '0' }), 'review') as { matchedCount: number; matchedRefundCount: number; exceptions: { finding: string; ref: string; valueMinor: number }[] };
    expect(review.matchedCount).toBe(1);
    expect(review.matchedRefundCount).toBe(1);
    // The payment with no line on the slip is NOT silently matched — it is an exception by its approval number (P-08).
    expect(review.exceptions.map((e) => [e.ref, e.valueMinor])).toEqual([['Z9Y8X7', 10_500]]);
    expect(review.exceptions.map((e) => e.ref)).not.toContain('A1B2C3');

    // ── A box in the MIRROR pilot (never with real trading): its manager's close carries no card list at all.
    const mdir = await mkdtemp(join(tmpdir(), 'sre-real-trading-follow-ups-mirror-'));
    dirs.push(mdir);
    const mready = await prepareTillBox({ dir: mdir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    const mirror = (await startEdge({
      EDGE_DATA_DIR: mdir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1', ...mready,
    }, () => {}))!;
    stops.push(() => mirror.stop());
    expect(await served<Record<string, unknown>>(mirror, 'manager')).not.toHaveProperty('cardPayments');
  }, 180_000);
});
