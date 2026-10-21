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
import { bootPos } from '../../apps/pos/src/browser-entry';
import { TaxInvoiceRefusedError } from '../../apps/pos/src/session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { STREAM } from '../../services/api/src/adapters';
import { prepareTillBox, signInTill, signInAtLane, receiptNumberAt, operatorHeader, pinOf } from '../support/till-operator';

/**
 * **OB-271 (owner, 21 Oct 2026) — real trading, from the shop's setup at head office, through a real store computer and the
 * till's own model, to head office: in memory AND on real PostgreSQL, the box and head office each restarted COLD.**
 *
 *   head office: the GST registration (legal name, GSTIN) and the store with its address → the store pack's
 *   `policies.taxInvoice` (OB-257 `shop`) — read back after a cold restart;
 *   the box, `EDGE_REAL_TRADING=1`, with that identity: a till sale is the Rule 46 tax invoice; a record posted straight to
 *   the socket with a line that has no HSN is refused BEFORE the box's disk; a card payment carries the machine's approval
 *   number — required, never card data — on the attempt and on the sale, and reaches head office with it; a refund to the
 *   card is DONE on the machine: its reference and a manager's PIN are recorded (once) and reach head office's evidence;
 *   after a cold restart of the box the day's list still has every number;
 *   and a box set for the mirror pilot AND real trading refuses to start.
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
const CATALOGUE: CatalogueSnapshot = {
  tenantId: 't', version: 1, builtAt: new Date().toISOString(),
  products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active', hsnCode: '071360' }],
  barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
};

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe.each(backings)('OB-271 — a real-trading bill is a tax invoice from the shop\'s setup to head office — on $name', ({ harness, restart }) => {
  it('the identity reaches the pack; a bill missing a field is refused before the disk; the machine\'s numbers reach head office; across cold restarts', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', [STORE]);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-lanecash', 'cashier');
    let n = 0;
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string): Promise<Record<string, unknown>> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body as Record<string, unknown>; };

    // ── Head office: the shop's GST registration and the store, WITH its address (what `shop` records, plus the address).
    await ok(call('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: LEGAL }), 'company');
    await ok(call('POST', `/v1/org/gst-registrations/${GSTIN}`, 'u-owner', { companyId: 'SRE', legalName: LEGAL }), 'registration');
    await ok(call('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE', gstin: GSTIN, address: `${ADDRESS[0]}\n\n${ADDRESS[1]}` }), 'store');
    await ok(call('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 }), 'settings');
    h = restart(h); // ── head office COLD ────────────────────────────────────────────────────────────────────────────
    const served = await h.request({ method: 'GET', path: `/v1/store-packs/${STORE}`, userId: 'u-box', tenantId: T, branchId: STORE });
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const policies = JSON.parse(JSON.stringify(served.body).match(/"policies":(\{[^{}]*"taxInvoice":\{[^{}]*\}[^{}]*\})/)?.[1] ?? '{}') as { taxInvoice?: unknown };
    expect(policies.taxInvoice).toEqual({ legalName: LEGAL, gstin: GSTIN, address: ADDRESS });

    // ── The store computer, in real trading, with that identity in its pack; head office reached through a stand-in fetch.
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
    const dir = await mkdtemp(join(tmpdir(), 'sre-real-trading-'));
    dirs.push(dir);
    const PACK = {
      policies: { storeId: STORE, branchId: STORE, branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', taxInvoice: policies.taxInvoice },
      servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
      lossPreventionRules: [],
    };
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    const startBox = async (extra: Record<string, string> = {}): Promise<EdgeProcess | undefined> => {
      const edge = await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: STORE }),
        EDGE_REAL_TRADING: '1', ...ready, ...extra,
      }, () => {});
      if (edge !== undefined) stops.push(() => edge.stop());
      return edge;
    };

    // Mirror and real trading together: the box does not start, and says why (exit 78).
    const before = process.exitCode;
    expect(await startBox({ EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1' })).toBeUndefined();
    expect(process.exitCode).toBe(78);
    process.exitCode = before;

    let edge = (await startBox())!;
    const till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, catalogue: CATALOGUE, realTrading: true, taxInvoice: PACK.policies.taxInvoice as never, refundPolicy: { approvalThresholdMinor: 1_000_000 } });
    await signInTill(till, 'u-lanecash');

    // ── A record posted straight to the socket, its line with no HSN: refused BEFORE the box's disk (the till's rule, again).
    const token = await signInAtLane(edge.lane!.port, 'u-mgr');
    const number = await receiptNumberAt(edge.lane!.port, token);
    const raw = await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        id: `S-${number}`, number, laneId: 'lane-1', cashierId: 'u-mgr', tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(),
        lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 10_500, taxRateBps: 500 }],
        tenders: [{ kind: 'cash', amount: { minor: 10_500, currency: 'INR' }, status: 'settled' }], total: 10_500, netMinor: 10_000, taxMinor: 500, currency: 'INR',
      }),
    })).json() as { committed: boolean; refusedBecause?: string; laneMessage?: string };
    expect(raw).toMatchObject({ committed: false, refusedBecause: 'tax_invoice_incomplete', laneMessage: expect.stringContaining('an item has no HSN code') });
    expect(await readLog(edge.log.path)).toHaveLength(0);

    // ── The till: the shop's GSTIN missing would refuse before the disk (its own check); with it, a card sale.
    const noGstin = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, catalogue: CATALOGUE, realTrading: true, taxInvoice: { legalName: LEGAL, gstin: '', address: ADDRESS } });
    await signInTill(noGstin, 'u-lanecash');
    noGstin.scanBarcode('8901234567890');
    const n0 = await noGstin.nextReceipt();
    await expect(noGstin.tenderCash(`S-${n0}`, n0, new Date().toISOString())).rejects.toBeInstanceOf(TaxInvoiceRefusedError);
    expect(await readLog(edge.log.path)).toHaveLength(0);
    await signInTill(till, 'u-lanecash');

    till.scanBarcode('8901234567890');
    const started = await till.startCardPayment('card');
    expect(started).toMatchObject({ ok: true, state: 'asked' });
    // Approved with no number, or with a card number: refused, nothing recorded — the payment still waits for its answer.
    expect(await till.answerCardPayment(started.attemptId!, 'approved')).toMatchObject({ ok: false, refusedBecause: 'machine_ref_missing' });
    const card = ['4111', '1111', '1111', '1111'].join('');
    expect(await till.answerCardPayment(started.attemptId!, 'approved', undefined, card)).toMatchObject({ ok: false, refusedBecause: 'machine_ref_looks_like_card' });
    expect(await till.answerCardPayment(started.attemptId!, 'approved', undefined, 'a1b2c3')).toMatchObject({ ok: true, state: 'approved', machineRef: 'A1B2C3' });
    const r1 = await till.nextReceipt();
    // A tender carrying a different number than the box recorded is refused before the disk.
    await expect(till.tenderCardOrUpi({ saleId: `S-${r1}`, receiptNumber: r1, atIsoUtc: new Date().toISOString(), kind: 'card', outcome: 'approved', ref: started.attemptId!, machineRef: 'ZZZZ99' }))
      .rejects.toMatchObject({ laneMessage: expect.stringContaining('approval number on the bill is not the one recorded') });
    await till.tenderCardOrUpi({ saleId: `S-${r1}`, receiptNumber: r1, atIsoUtc: new Date().toISOString(), kind: 'card', outcome: 'approved', ref: started.attemptId!, machineRef: 'A1B2C3' });
    const invoice = till.taxInvoice();
    if (!invoice.ok) throw new Error(invoice.why);
    expect(invoice.lines.join('\n')).toEqual(expect.stringContaining('Paid: Card (approval A1B2C3)'));
    const [onDisk] = (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as { tenders: unknown[] } : { tenders: [] }));
    expect(onDisk!.tenders).toEqual([expect.objectContaining({ kind: 'card', ref: started.attemptId, machineRef: 'A1B2C3' })]);
    for (const file of [edge.log.path, join(dir, 'payment-attempts.log')]) expect((await readLog(file)).map((r) => (r.ok ? r.record : '')).join('\n')).not.toContain(card);
    expect((await edge.syncOnce!()).dead).toBe(0);

    // ── The refund to the card: pending until DONE on the machine; recorded with the machine's reference and a manager.
    const bill = (await till.lookupRefund(r1))!;
    const rn = await till.nextReceipt();
    const refunded = await bill.submit({ returnId: `RT-${rn}`, number: rn, reasonCode: 'damaged', lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }], refundMinor: 10_500, refundTender: 'card' });
    expect(refunded).toMatchObject({ kind: 'pending', refundMinor: 10_500 });
    // A cashier cannot approve it for themselves; the manager can, for exactly this refund and amount.
    expect(await till.approveAtTill({ managerId: 'u-lanecash', pin: pinOf('u-lanecash'), kind: 'card_refund_on_machine', billRef: `RT-${rn}`, valueMinor: 10_500, reason: 'seen on the slip' })).toMatchObject({ approved: false, refusedBecause: 'self_approval' });
    const approval = await till.approveAtTill({ managerId: 'u-mgr', pin: pinOf('u-mgr'), kind: 'card_refund_on_machine', billRef: `RT-${rn}`, valueMinor: 10_500, reason: 'seen on the slip' });
    if (!approval.approved) throw new Error(approval.laneMessage);
    // The wrong amount does not match the refund the box holds; the right one is recorded once.
    expect(await till.recordCardRefundOnMachine({ returnId: `RT-${rn}`, refundMinor: 9_000, refundTender: 'card', machineRef: 'R98765', approval })).toMatchObject({ ok: false, refusedBecause: 'card_refund_not_here' });
    expect(await till.recordCardRefundOnMachine({ returnId: `RT-${rn}`, refundMinor: 10_500, refundTender: 'card', machineRef: 'R98765', approval })).toMatchObject({ ok: true });
    expect(await till.recordCardRefundOnMachine({ returnId: `RT-${rn}`, refundMinor: 10_500, refundTender: 'card', machineRef: 'R98765', approval })).toMatchObject({ ok: false, refusedBecause: 'card_refund_already_recorded' });

    // ── The line is cut; the box and head office both restart cold; the day's list still has every number.
    online = false;
    await edge.stop();
    stops.splice(0);
    h = restart(h);
    edge = (await startBox())!;
    online = true;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const lane = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, catalogue: CATALOGUE, realTrading: true, taxInvoice: PACK.policies.taxInvoice as never });
    await signInTill(lane, 'u-lanecash');
    const day = await lane.cardPayments();
    expect(day?.paid).toEqual([expect.objectContaining({ kind: 'card', amountMinor: 10_500, machineRef: 'A1B2C3', saleId: `S-${r1}` })]);
    expect(day?.refundsOnMachine).toEqual([expect.objectContaining({ returnId: `RT-${rn}`, kind: 'card', amountMinor: 10_500, machineRef: 'R98765', approvedBy: 'u-mgr', by: 'u-lanecash' })]);

    // ── Head office has the sale with the machine's number, and the refund done on the machine with its reference.
    expect(await ok(call('GET', `/v1/sales/S-${r1}`, 'u-owner'), 'sale')).toMatchObject({ banked: true });
    const banked = (await h.store.readStream(T, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as { saleId?: string; tenders?: unknown[] });
    expect(banked.find((s) => s.saleId === `S-${r1}`)?.tenders).toEqual([expect.objectContaining({ kind: 'card', amountMinor: 10_500, machineRef: 'A1B2C3' })]);
    const activity = await ok(call('GET', '/v1/loss-prevention/activity', 'u-owner', undefined, { day: new Date().toISOString().slice(0, 10) }), 'activity');
    expect(activity['cardRefundsOnMachine']).toEqual([expect.objectContaining({ kind: 'card_refund_on_machine', billRef: `RT-${rn}`, machineRef: 'R98765', refundTender: 'card', valueMinor: 10_500, approvedBy: 'u-mgr' })]);
    // Not counted as a void, a no-sale or a discount by the loss-prevention rules.
    expect((activity['voids'] as unknown[]).length + (activity['noSales'] as unknown[]).length + (activity['overrides'] as unknown[]).length).toBe(0);
  }, 120_000);
});
