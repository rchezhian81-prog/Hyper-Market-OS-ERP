import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { addTillPeople, signInTill, managerApprovesOn } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **An EXCHANGE at the till, from the lane to head office's books, on the REAL cloud over REAL PostgreSQL through the
 * REAL box (SP-9b-ii · W12 · M13-FR-03 · M08-FR-01 · M23 · §28 · P-02 · hard rules #1 #2 #10).**
 *
 * Two bills sold and banked. The customer brings one back and takes a DEARER tin: the till credits the bill's own price,
 * rings the replacement like any sale, collects the ₹60 difference in cash — no manager, nothing leaves the shop. The
 * other customer takes a CHEAPER tin: the shop owes ₹40, so at this shop's threshold a manager approves (not the
 * cashier). Each exchange is two documents on the box's own logs — the credit first, then the replacement sale paid
 * with `exchange_credit` — relayed by the two existing pipelines. Head office then: banks both replacement sales with
 * their exchange-credit tenders; records both credits as the returning half of an exchange (no governance exception —
 * the judged money is the balance, never the credit); folds them into the register (nothing left to return on either
 * bill); puts the returned tins back on THIS store's shelf and takes the replacements off it; and posts a day book
 * where the exchange credit clears and every journal balances. A retry of the same exchange refunds and sells ONCE.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const KEY = ['till', 'exchanges', 'on', 'the', 'real', 'stack', 'key'].join('-').padEnd(48, '0');
const COMPANY = 'C1';
const STORE = 'S1';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const MANAGER = 'u-manager';
const CASHIER = 'u-meena';
const ACCT = 'u-acct';
const BOX = 'u-box';
const GHEE = { productId: 'p-ghee', barcode: '8901234567890', price: 64_000, name: 'Amul Ghee Gold 1L' };          // ₹640
const PREMIUM = { productId: 'p-premium', barcode: '8901234500002', price: 70_000, name: 'Amul Ghee Gold 1L premium' }; // ₹700 — dearer
const SMALL = { productId: 'p-small', barcode: '8901234500003', price: 60_000, name: 'Amul Ghee Gold 900ml' };     // ₹600 — cheaper
const OPENING = 5;

interface Reply { readonly status: number; readonly body: unknown }

describeOrSkip('the till exchanges goods — credit at the bill\'s own price, the replacement rung like any sale, the difference settled; both documents reach head office, the register, the shelf and the day book (SP-9b-ii)', () => {
  let cloud: RealCloud;
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(MANAGER, 'store_manager');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(BOX, 'store_computer'); // OB-36 "A": the store computer's own role
    await cloud.grant(ACCT, 'accountant');
    expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'setup-tz-utc')).status).toBe(200);
    await ok(call('POST', `/v1/org/nodes/${COMPANY}`, OWNER, { kind: 'company', name: 'SRE Retail' }, `org-${COMPANY}`), 201);
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: COMPANY, companyId: COMPANY }, `org-${STORE}`), 201);
    await publishCatalogue();
  }, 90_000);
  afterAll(async () => { await cloud?.stop(); });
  afterEach(async () => {
    for (const edge of edges.splice(0)) await edge.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<Reply>, expected: number): Promise<Record<string, unknown>> => {
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(expected);
    return r.body as Record<string, unknown>;
  };

  async function publishCatalogue(): Promise<void> {
    await ok(call('POST', '/v1/catalogue/tax-classes/0405/rates/2017-07-01', OWNER, { rateBps: 1200 }, 'tax-0405'), 201);
    for (const [i, p] of [GHEE, PREMIUM, SMALL].entries()) {
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/publish`, OWNER, {
        product: { sku: p.productId.toUpperCase(), name: p.name, baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0405', lifecycle: 'active' },
        categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
      }, `publish-${p.productId}`), 201);
      await ok(call('POST', `/v1/prices/list/${p.productId}/entries/e1`, OWNER, {
        scope: 'store', scopeRef: STORE, priceMinor: p.price, mrpMinor: p.price + 10_000, costMinor: 50_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
      }, `price-${p.productId}`), 201);
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/barcodes/${p.barcode}`, OWNER, { kind: 'ean' }, `barcode-${p.productId}`), 201);
      // Opening stock on the floor — what the till sells from and what a resold return comes back to.
      expect((await call('POST', '/v1/inventory/movements', OWNER, {
        movementId: `mv-open-${i}`, productId: p.productId, locationId: STORE, kind: 'received', quantityMinor: OPENING, uom: 'ea',
        occurredAt: `${today}T00:30:00.000Z`, enteredBy: OWNER, unitCostMinor: 50_000,
      }, `mv-open-${i}`)).status).toBe(202);
    }
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1'), 201);
  }

  /** A store box: its pack file names the store and a service policy with threshold 0 (every refunded balance needs a manager). */
  async function startBox(): Promise<EdgeProcess> {
    const dataDir = await mkdtemp(join(tmpdir(), 'sre-till-exchanges-'));
    dirs.push(dataDir);
    const packFile = join(dataDir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
      servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
      lossPreventionRules: [],
    }), 'utf8');
    // The pack also names the cashier with till authority, and her till PIN is issued on this box (ADR-0020).
    await addTillPeople(packFile, dataDir, KEY, [{ userId: CASHIER, displayName: 'Meena' }, { userId: MANAGER, displayName: 'Manager', manager: true }]);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    }, () => {}))!;
    edges.push(edge);
    return edge;
  }
  async function servedGlobal<T>(edge: EdgeProcess, name: string): Promise<T | undefined> {
    const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const match = new RegExp(`<script>window\\.${name} = ([\\s\\S]*?);</script>`).exec(html);
    return match === null ? undefined : JSON.parse(match[1]!) as T;
  }

  interface Availability { rows: { locationId: string; onHandMinor: number }[] }
  const onHandAt = async (productId: string, locationId: string): Promise<number> =>
    ((await ok(call('GET', `/v1/inventory/availability?productId=${productId}`, OWNER), 200)) as unknown as Availability).rows.find((r) => r.locationId === locationId)?.onHandMinor ?? 0;
  const banked = async (saleId: string): Promise<boolean> => (await call('GET', `/v1/sales/${saleId}`, OWNER)).status === 200;

  it('two bills banked → a dearer swap paid ₹60 in cash (no manager) → a cheaper swap with ₹40 back (manager, not the cashier; retry once) → both halves reach head office → register, shelf and day book agree', async () => {
    // ── 1. The box pulls head office's catalogue; the till boots from exactly what the served page carries.
    const edge = await startBox();
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    const catalogue = (await servedGlobal<CatalogueSnapshot>(edge, 'posCatalogue'))!;
    expect(catalogue.products.map((p) => p.productId).sort()).toEqual([GHEE.productId, PREMIUM.productId, SMALL.productId].sort());
    const policy = (await servedGlobal<{ approvalThresholdMinor: number; noReceiptCapMinor: number }>(edge, 'posRefundPolicy'))!;
    expect(policy.approvalThresholdMinor).toBe(0);
    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port, refundPolicy: policy });
    await signInTill(till, CASHIER);

    // ── 2. Two customers buy a tin of ghee each, by barcode, in cash. Banked at head office.
    // Every document number comes from this box (audit PF-04).
    const bills: string[] = [];
    for (const saleId of ['S-1', 'S-2']) {
      till.scanBarcode(GHEE.barcode);
      expect(till.payableMinor()).toBe(GHEE.price);
      bills.push(await till.tenderCash(saleId, await till.nextReceipt(), new Date().toISOString()));
      till.newSale();
    }
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(await banked('S-1')).toBe(true);
    expect(await banked('S-2')).toBe(true);
    expect(await onHandAt(GHEE.productId, STORE)).toBe(OPENING - 2);

    // ── 3. Exchange A: the first customer wants the DEARER tin. Rung first, like any sale; the bill found by its receipt.
    till.scanBarcode(PREMIUM.barcode);
    const billA = (await till.lookupRefund(bills[0]!))!;
    const back = [{ productId: GHEE.productId, uom: 'ea', quantityMinor: 1, disposition: 'resell' as const }];
    const quoteA = billA.exchange.quote(back);
    // ₹640 credited at the bill's own price against ₹700 rung → the customer pays ₹60; nothing leaves the shop → no manager.
    expect(quoteA).toMatchObject({ ok: true, returnedValueMinor: GHEE.price, replacementTotalMinor: PREMIUM.price, balance: 'top_up', balanceMinor: 6_000, appliedMinor: GHEE.price, needsApproval: false });
    const [creditA, replacementA] = [await till.nextReceipt(), await till.nextReceipt()];
    const a = await billA.exchange.complete({
      exchangeId: 'X-1', number: creditA, reasonCode: 'wrong_item', returnLines: back,
      replacementSaleId: 'S-X1', replacementReceipt: replacementA, settlement: { topUp: { kind: 'cash' } },
    });
    expect(a).toMatchObject({ kind: 'done', balance: 'top_up', balanceMinor: 6_000, refundStatus: 'settled', number: creditA, replacementReceipt: replacementA });
    till.newSale();

    // ── 4. Exchange B: the second customer wants the CHEAPER tin — the shop owes ₹40. At threshold 0 that needs a manager,
    //      a DIFFERENT person from the cashier (§28). Refused without, refused self-approved; nothing written either time.
    till.scanBarcode(SMALL.barcode);
    const billB = (await till.lookupRefund(bills[1]!))!;
    const quoteB = billB.exchange.quote(back);
    expect(quoteB).toMatchObject({ ok: true, balance: 'refund', balanceMinor: 4_000, appliedMinor: SMALL.price, needsApproval: true });
    const [creditB, replacementB] = [await till.nextReceipt(), await till.nextReceipt()];
    const drafted = (over: Record<string, unknown> = {}) => ({
      exchangeId: 'X-2', number: creditB, reasonCode: 'wrong_item', returnLines: back,
      replacementSaleId: 'S-X2', replacementReceipt: replacementB, settlement: { refundTender: 'cash' as const }, ...over,
    });
    expect((await billB.exchange.complete(drafted())).kind).toBe('approval_required');
    expect((await billB.exchange.complete(drafted({ approval: { by: CASHIER, reason: 'mine' } }))).kind).toBe('approval_required');
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);
    // A manager's name typed in is not an approval any more (ADR-0021): the store computer refuses it, nothing written.
    const typed = await billB.exchange.complete(drafted({ approval: { by: MANAGER, reason: 'checked the goods' } }));
    expect(typed.kind).not.toBe('done');
    expect(typed.laneMessage).toMatch(/needs a manager's approval on this till/);
    expect(await readLog(edge.returnsLog.path)).toHaveLength(1);
    // The manager approves with their own PIN, for this bill and this ₹40 — then it goes through.
    const approval = await managerApprovesOn(till, MANAGER, { kind: 'exchange_refund', billRef: 'S-2', valueMinor: 4_000, reason: 'checked the goods' });
    const b = await billB.exchange.complete(drafted({ approval }));
    expect(b).toMatchObject({ kind: 'done', balance: 'refund', balanceMinor: 4_000, refundStatus: 'settled' });
    till.newSale();
    // The same exchange again: the credit is refused as a reused id (RR-F03) BEFORE any sale half — refunded and sold once.
    till.scanBarcode(SMALL.barcode);
    expect((await billB.exchange.complete(drafted({ approval }))).kind).toBe('conflict');
    till.newSale();

    // ── 5. On the box's disk: two credits (tender "exchange", each naming its replacement) and two replacement sales
    //      (each paid with exchange credit, A also with ₹60 cash). Queued on the two existing pipelines.
    const credits = (await readLog(edge.returnsLog.path)).map((r) => (r.ok ? JSON.parse(r.record) as Record<string, unknown> : {}));
    expect(credits.map((c) => c['returnId'])).toEqual(['X-1', 'X-2']);
    expect(credits[0]).toMatchObject({ originalSaleId: 'S-1', refundTender: 'exchange', refundMinor: GHEE.price, processedBy: CASHIER, exchange: { replacementSaleId: 'S-X1', replacementTotalMinor: PREMIUM.price, appliedMinor: GHEE.price, balance: 'top_up', balanceMinor: 6_000, topUpTenders: [{ kind: 'cash', amountMinor: 6_000 }] } });
    expect(credits[1]).toMatchObject({ originalSaleId: 'S-2', refundTender: 'exchange', refundMinor: GHEE.price, approvedBy: MANAGER, exchange: { replacementSaleId: 'S-X2', replacementTotalMinor: SMALL.price, appliedMinor: SMALL.price, balance: 'refund', balanceMinor: 4_000, balanceTender: 'cash' } });
    const sales = (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as Record<string, unknown> : {}));
    expect(sales.map((s) => s['id'])).toEqual(['S-1', 'S-2', 'S-X1', 'S-X2']);
    expect(sales[2]).toMatchObject({ total: PREMIUM.price, tenders: [{ kind: 'exchange_credit', amount: { minor: GHEE.price } }, { kind: 'cash', amount: { minor: 6_000 } }] });
    expect(sales[3]).toMatchObject({ total: SMALL.price, tenders: [{ kind: 'exchange_credit', amount: { minor: SMALL.price } }] });

    // ── 6. One pass to head office: both credits and both replacement sales land; nothing dead, nothing left.
    const sync = await edge.syncOnce!();
    expect(sync).toMatchObject({ dead: 0, remaining: 0 });
    expect(sync.sent).toBeGreaterThanOrEqual(4);
    expect(await banked('S-X1')).toBe(true);
    expect(await banked('S-X2')).toBe(true);
    // The register: nothing is left to return on either bill — the exchange's credit counts as the return it is.
    for (const saleId of ['S-1', 'S-2']) {
      const returnable = await ok(call('GET', `/v1/sales/${saleId}/returnable`, OWNER), 200) as { lines?: { productId: string; returnableMinor: number }[]; returnable?: { productId: string; returnableMinor: number }[] };
      const lines = returnable.lines ?? returnable.returnable ?? [];
      expect(lines.find((l) => l.productId === GHEE.productId)?.returnableMinor).toBe(0);
    }
    // No governance exception: the money judged is the BALANCE — ₹0 and ₹60 in; ₹40 out with a manager who holds the authority.
    expect((await ok(call('GET', '/v1/pos/return-governance-exceptions', OWNER), 200) as { count: number }).count).toBe(0);

    // ── 7. The shelf (M08-FR-01 · P-02): the two returned tins are back ON THIS STORE's stock; the replacements left it.
    expect(await onHandAt(GHEE.productId, STORE)).toBe(OPENING);        // 5 − 2 sold + 2 back
    expect(await onHandAt(PREMIUM.productId, STORE)).toBe(OPENING - 1);
    expect(await onHandAt(SMALL.productId, STORE)).toBe(OPENING - 1);
    expect(await onHandAt(GHEE.productId, LANE)).toBe(0);

    // ── 8. The books (M23): the accountant posts the day — the exchange credit clears, every journal balances, no exception.
    await ok(call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP, 'map-1'), 200);
    const dayPost = await call('POST', `/v1/finance/day-book/${today}/post`, ACCT, {}, `day-${today}`);
    expect(dayPost.status, JSON.stringify(dayPost.body)).toBeLessThan(300);
    const day = dayPost.body as { journals: { kind: string; lines: { debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(day.exceptions).toEqual([]);
    expect(day.journals.map((j) => j.kind)).toEqual(expect.arrayContaining(['sale', 'tender:cash', 'tender:exchange_credit']));
    for (const j of day.journals) {
      const debit = j.lines.reduce((s, l) => s + l.debitMinor, 0);
      const credit = j.lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(debit, j.kind).toBe(credit);
    }
  }, 120_000);
});
