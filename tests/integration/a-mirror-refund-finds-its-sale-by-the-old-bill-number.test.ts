import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { STREAM } from '../../services/api/src/adapters';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { PAID_ON_OLD_ERP_WORDS } from '../../packages/tender/src/paid-on-old-erp';
import { oldErpBillRepeatedWords } from '../../packages/tender/src/old-erp-bill-number';
import { prepareTillBox, signInTill, managerApprovesOn } from '../support/till-operator';

/**
 * **OB-264 (owner, 20 Oct 2026, "Key old bill number") — the old ERP's bill number keyed on every mirror sale travels to
 * the store computer and head office, is never keyed twice, and is how a mirror refund finds its sale.** From the till's
 * own model through a real store computer to head office, in memory and, with DATABASE_URL, on real PostgreSQL (head
 * office restarted cold: a fresh process over the same database).
 *
 *   the box: mirror pilot + guest sales only → sale 1, old bill "OLD/4471", saved with it → the SAME old bill keyed on a
 *   second basket (typed in small letters) is refused before the disk, in words naming the new bill that holds it; the
 *   basket stays and is saved under its own number "OLD/4472" → both reach head office with their numbers → the box and
 *   head office restart cold → the box still refuses "OLD/4471" again (its register is rebuilt from its own disk) → the
 *   customer brings the old bill back: the till finds sale 1 by "OLD/4471" on the box (offline: the line is cut), the
 *   manager approves with their own PIN, refunded "Paid on old system" → line back: the refund reaches head office
 *   EXACTLY ONCE, the sale relayed again is already banked → the day book lists the old bill numbers beside its
 *   vouchers → a number that is not one (a phone number) sent straight to head office is not kept, and the bill says so.
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
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => h },
];
if (DATABASE_URL !== undefined) {
  const onPg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL, head office restarted cold', harness: onPg, restart: () => onPg() });
}

const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];
const PACK = {
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
};
const DAY_D = '2026-10-05';
const ON_DAY_D = new Date(`${DAY_D}T05:00:00.000Z`);

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
const savedFetch = globalThis.fetch;
afterEach(async () => {
  vi.useRealTimers();
  globalThis.fetch = savedFetch;
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe.each(backings)('OB-264 — a mirror refund finds its sale by the old bill number — on $name', ({ harness, restart }) => {
  it('the old bill number: on the sale, never keyed twice (across a restart), finds the sale offline for the refund, at head office once', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-box', 'store_computer', ['store-1']);
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-lanecash', 'cashier');
    await h.provisionRole(T, 'u-acct', 'accountant');
    let online = true;
    globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
        token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    let n = 0;
    const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown) =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}-${randomUUID()}` }), ...(body === undefined ? {} : { body }) });
    const banked = async (): Promise<Record<string, unknown>[]> => (await h.store.readStream(T, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as Record<string, unknown>);

    const dir = await mkdtemp(join(tmpdir(), 'sre-old-bill-'));
    dirs.push(dir);
    const ready = await prepareTillBox({ dir, key: TEST_PACK_KEY, people: PEOPLE, pack: PACK });
    const startBox = async (): Promise<EdgeProcess> => {
      const edge = (await startEdge({
        EDGE_DATA_DIR: dir, EDGE_TENANT_ID: T, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
        EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }),
        EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1', ...ready,
      }, () => {}))!;
      stops.push(() => edge.stop());
      return edge;
    };
    const stopBox = async (edge: EdgeProcess): Promise<void> => { await edge.stop(); stops.splice(0); };
    const onDisk = async (edge: EdgeProcess): Promise<Record<string, unknown>[]> => (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as Record<string, unknown> : {}));

    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(ON_DAY_D);
    let edge = await startBox();
    const tillOn = async (box: EdgeProcess) => { const t = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: box.lane!.port, mirrorPilot: true, guestSalesOnly: true }); await signInTill(t, 'u-lanecash'); return t; };
    let till = await tillOn(edge);
    const at = (): string => new Date().toISOString();

    // ── Sale 1: 2 × dal, old bill "OLD/4471", saved WITH it.
    till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500, qty: 2 });
    const r1 = await till.nextReceipt();
    expect(await till.tenderPaidOnOldErp(`S-${r1}`, r1, at(), 'OLD/4471')).toBe(r1);
    till.newSale();
    expect((await onDisk(edge))[0]).toMatchObject({ id: `S-${r1}`, oldErpBillNumber: 'OLD/4471', tenders: [{ kind: 'paid_on_old_erp' }] });

    // ── The SAME old bill on another basket (typed in small letters): refused before the disk, naming new bill r1.
    till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500, qty: 1 });
    const typedAgain = till.readOldBill(' old/4471 ');
    expect(typedAgain).toEqual({ ok: true, value: 'OLD/4471' });
    const r2 = await till.nextReceipt();
    await expect(till.tenderPaidOnOldErp(`S-${r2}`, r2, at(), 'OLD/4471')).rejects.toMatchObject({ name: 'LocalCommitRefusedError', laneMessage: oldErpBillRepeatedWords('OLD/4471', r1) });
    expect(await onDisk(edge)).toHaveLength(1);
    // The basket is still on the till; keyed with its own old bill it is saved (a fresh bill number: the first was spent).
    expect(till.payableMinor()).toBe(10_500);
    const r3 = await till.nextReceipt();
    expect(await till.tenderPaidOnOldErp(`S-${r3}`, r3, at(), 'OLD/4472')).toBe(r3);
    till.newSale();
    expect((await onDisk(edge)).map((s) => s['oldErpBillNumber'])).toEqual(['OLD/4471', 'OLD/4472']);
    expect((await edge.syncOnce!()).dead).toBe(0);
    expect((await banked()).map((s) => [s['saleId'], s['oldErpBillNumber']])).toEqual([[`S-${r1}`, 'OLD/4471'], [`S-${r3}`, 'OLD/4472']]);

    // ── Both restart cold, and the line is cut: the box rebuilds its register from its own disk — "OLD/4471" is still held.
    online = false;
    await stopBox(edge);
    h = restart(h);
    edge = await startBox();
    till = await tillOn(edge);
    till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500, qty: 1 });
    const r4 = await till.nextReceipt();
    await expect(till.tenderPaidOnOldErp(`S-${r4}`, r4, at(), 'OLD/4471')).rejects.toMatchObject({ laneMessage: oldErpBillRepeatedWords('OLD/4471', r1) });
    till.newSale();
    expect(await onDisk(edge)).toHaveLength(2);

    // ── The customer brings the old bill back. Offline, the till finds sale 1 by "OLD/4471" on the box.
    expect(await till.lookupRefundByOldBill('OLD/9999')).toBeNull();
    const bill = (await till.lookupRefundByOldBill('old/4471'))!;
    expect(bill.sale).toMatchObject({ saleId: `S-${r1}`, number: r1, totalMinor: 21_000 });
    expect(bill.returnable).toEqual([expect.objectContaining({ productId: 'P1', returnableMinor: 2 })]);
    // The refund rules as today: a second person approves (threshold 0), with their own PIN; within the bill.
    expect(bill.needsApproval(10_500)).toBe(true);
    const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: `S-${r1}`, valueMinor: 10_500, reason: 'damaged' });
    const rn = await till.nextReceipt();
    const refunded = await bill.submit({
      returnId: `RT-${rn}`, number: rn, reasonCode: 'damaged',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: 10_500, refundTender: 'paid_on_old_erp', approval,
    });
    expect(refunded).toMatchObject({ kind: 'settled', refundMinor: 10_500, laneMessage: PAID_ON_OLD_ERP_WORDS.refundDone });
    // Half came back: the number is still held by sale 1, and the till still finds it for what is left.
    const again = (await till.lookupRefundByOldBill('OLD/4471'))!;
    expect(again.sale.saleId).toBe(`S-${r1}`);
    expect(again.maxRefundMinor).toBe(10_500);

    // ── The line comes back: the refund reaches head office EXACTLY ONCE; sale 1 relayed again is already banked.
    online = true;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(((await call('GET', `/v1/sales/S-${r1}/returnable`, 'u-owner')).body as { refundableMinor: number }).refundableMinor).toBe(10_500);
    const first = (await onDisk(edge))[0]!;
    const relayed = await h.raw({ method: 'POST', path: '/v1/sales', token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: `again-${randomUUID()}`, body: toCloudSale(first, 0, 'store-1', 'lane-1') });
    expect((relayed.body as { alreadyBanked?: boolean }).alreadyBanked, JSON.stringify([relayed.status, relayed.body])).toBe(true);
    expect((await banked()).filter((s) => s['oldErpBillNumber'] === 'OLD/4471')).toHaveLength(1);
    const returns = (await h.store.readStream(T, STREAM.returns, { type: 'ReturnRecorded' })).map((e) => e.event.payload as { returnId: string });
    expect(returns.filter((r) => r.returnId === `RT-${rn}`)).toHaveLength(1);

    // ── The day book: each voucher lists the old bill numbers behind it — the sales' own, the refund's from sale 1.
    expect((await call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP)).status).toBeLessThan(300);
    const posted = await call('POST', `/v1/finance/day-book/${DAY_D}/post`, 'u-acct');
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    const book = (await call('GET', `/v1/finance/day-book/${DAY_D}`, 'u-acct')).body as { journals: { kind: string; oldErpBills?: { sourceId: string; oldErpBillNumber: string }[] }[] };
    const oldOf = (kind: string) => book.journals.find((j) => j.kind === kind)?.oldErpBills;
    expect(oldOf('sale')).toEqual([{ sourceId: `S-${r1}`, oldErpBillNumber: 'OLD/4471' }, { sourceId: `S-${r3}`, oldErpBillNumber: 'OLD/4472' }]);
    expect(oldOf('tender:paid_on_old_erp')).toEqual(oldOf('sale'));
    expect(oldOf('refund:paid_on_old_erp')).toEqual([{ sourceId: `RT-${rn}`, oldErpBillNumber: 'OLD/4471' }]);

    // ── Head office keeps an old bill number only in its checked form: a phone number sent straight to it is not kept.
    const stray = { ...toCloudSale({ ...first, id: 'S-STRAY', number: 'STRAY1' }, 0, 'store-1', 'lane-1'), oldErpBillNumber: '9876543210' };
    const sent = await h.raw({ method: 'POST', path: '/v1/sales', token: TEST_IDP.issue({ sub: 'u-box', tenantId: T, branchId: 'store-1' }), idempotencyKey: `stray-${randomUUID()}`, body: stray });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const kept = (await banked()).find((s) => s['saleId'] === 'S-STRAY')!;
    expect(kept['oldErpBillNumber']).toBeUndefined();
    expect(kept['oldErpBillNumberIgnored']).toEqual({ why: 'not_an_old_bill_number' });
    expect(JSON.stringify(kept)).not.toContain('9876543210');
  }, 120_000);
});
