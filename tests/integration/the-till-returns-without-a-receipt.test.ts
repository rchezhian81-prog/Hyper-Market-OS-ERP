import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **A return WITHOUT a receipt, from the till to head office's books, on the REAL cloud over REAL PostgreSQL through the
 * REAL box (SP-9b-i · W12 · M13-FR-01 · M13-FR-03 · M08-FR-01 · §28 · P-08).**
 *
 * The owner sets the shop's no-receipt cap at head office. The box pulls head office's catalogue and serves the till;
 * the till is GIVEN the cap and the threshold the box's store pack carries. A cashier takes a return with no bill:
 * the item is named from the lane's catalogue, the amount is bounded by the cap, a manager approves. The return lands
 * on the box's disk and queue first (hard rule #1), then reaches head office's own no-receipt route, which RE-CHECKS
 * the cap, the approver and the stock location, records the return on its register, puts the resold unit back on
 * THIS shop's shelf (F17 — not on a location named after the lane), and shows a breach as a visible exception.
 *
 * It also proves the two honest limits: a retry of the same return never refunds twice (RR-F03), and a lane whose
 * pack carries a WIDER cap than head office's has its over-cap return recorded AND flagged — never lost, never silent.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const KEY = ['till', 'returns', 'without', 'a', 'receipt', 'key'].join('-').padEnd(48, '0');
const COMPANY = 'C1';
const STORE = 'S1';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const MANAGER = 'u-manager';  // store_manager: approves at the lane
const CASHIER = 'u-meena';    // cashier: takes the return
const BOX = 'u-box';          // the store computer's sync identity
const PRODUCT = 'p-ghee';
const BARCODE = '8901234567890';
const PRICE = 64_000;         // ₹640.00 shelf price, GST inside
const HEAD_OFFICE_CAP = 100_000;  // ₹1,000 — the owner's cap at head office
const LANE_CAP = 150_000;         // ₹1,500 — a WIDER cap in this box's pack file (the recorded limitation: the box does not pull head office's cap yet)

interface Reply { readonly status: number; readonly body: unknown }

describeOrSkip('the till returns without a receipt — cap, item, manager at the lane; re-checked, registered and re-shelved at head office, on the REAL stack (SP-9b-i)', () => {
  let cloud: RealCloud;
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(MANAGER, 'store_manager');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(BOX, 'cashier');
    expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'setup-tz-utc')).status).toBe(200);
    await ok(call('POST', `/v1/org/nodes/${COMPANY}`, OWNER, { kind: 'company', name: 'SRE Retail' }, `org-${COMPANY}`), 201);
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: COMPANY, companyId: COMPANY }, `org-${STORE}`), 201);
    await publishCatalogue();
  }, 60_000);
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
  const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

  async function publishCatalogue(): Promise<void> {
    await ok(call('POST', '/v1/catalogue/tax-classes/0405/rates/2017-07-01', OWNER, { rateBps: 1200 }, 'tax-0405'), 201);
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
      product: { sku: 'GHEE-1L', name: 'Amul Ghee Gold 1L', baseUom: 'ea', primaryCategoryId: 'dairy', taxClass: '0405', lifecycle: 'active' },
      categories: [{ categoryId: 'dairy', name: 'Dairy', parentId: null }],
    }, `publish-${PRODUCT}`), 201);
    await ok(call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: PRICE, mrpMinor: 70_000, costMinor: 50_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
    }, `price-${PRODUCT}`), 201);
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/barcodes/${BARCODE}`, OWNER, { kind: 'ean' }, `barcode-${PRODUCT}`), 201);
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1'), 201);
  }

  /** A store box: its pack file carries the store it belongs to AND the service policy (the lane's cap); head office is live. */
  async function startBox(): Promise<EdgeProcess> {
    const dataDir = await mkdtemp(join(tmpdir(), 'sre-till-no-receipt-'));
    dirs.push(dataDir);
    const packFile = join(dataDir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
      servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: LANE_CAP, agentAuthorityMinor: 0, compensationCapMinor: 0 },
      lossPreventionRules: [],
    }), 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    }, () => {}))!;
    edges.push(edge);
    return edge;
  }
  /** One global exactly as the box injects it into the served till page. */
  async function servedGlobal<T>(edge: EdgeProcess, name: string): Promise<T | undefined> {
    const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const match = new RegExp(`<script>window\\.${name} = ([\\s\\S]*?);</script>`).exec(html);
    return match === null ? undefined : JSON.parse(match[1]!) as T;
  }

  interface Availability { rows: { locationId: string; onHandMinor: number }[] }
  const onHandAt = async (locationId: string): Promise<number> =>
    ((await ok(call('GET', `/v1/inventory/availability?productId=${PRODUCT}`, OWNER), 200)) as unknown as Availability).rows.find((r) => r.locationId === locationId)?.onHandMinor ?? 0;

  it('owner sets the cap → the box serves head office\'s catalogue and the pack\'s policy → the till takes a no-receipt return (manager, under the cap) → disk + queue → head office registers it, re-shelves the unit at THIS store, flags nothing; a retry refunds once; a lane-cap return above head office\'s cap is recorded AND flagged (P-08)', async () => {
    // ── 1. The owner's cap, at head office (M13-FR-01). Owner-only.
    expect(codeOf(await call('POST', '/v1/pos/no-receipt-cap', MANAGER, { capMinor: HEAD_OFFICE_CAP }, 'cap-by-manager'))).toBe('forbidden');
    await ok(call('POST', '/v1/pos/no-receipt-cap', OWNER, { capMinor: HEAD_OFFICE_CAP }, 'cap-1'), 200);
    expect(await ok(call('GET', '/v1/pos/no-receipt-cap', OWNER), 200)).toMatchObject({ capMinor: HEAD_OFFICE_CAP, isSet: true });
    expect(await onHandAt(STORE)).toBe(0);

    // ── 2. The box pulls head office's catalogue and serves the till with it AND with the pack's refund policy.
    const edge = await startBox();
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    const catalogue = await servedGlobal<CatalogueSnapshot>(edge, 'posCatalogue');
    expect(catalogue?.products.map((p) => p.productId)).toEqual([PRODUCT]);
    const policy = await servedGlobal<{ approvalThresholdMinor: number; noReceiptCapMinor: number }>(edge, 'posRefundPolicy');
    expect(policy).toEqual({ approvalThresholdMinor: 0, noReceiptCapMinor: LANE_CAP });

    // ── 3. The till — the real `bootPos`, exactly as the served page boots it (catalogue, lane, policy, this box's socket).
    const till = bootPos({ laneId: LANE, catalogue: catalogue!, lanePort: edge.lane!.port, refundPolicy: policy! });
    till.signIn(CASHIER);
    const desk = till.noReceiptReturn();
    expect(desk).not.toBeNull();
    expect(desk!.capMinor).toBe(LANE_CAP);
    // The item is named from head office's catalogue, by the barcode the customer's tin carries.
    expect(desk!.findProduct(BARCODE)).toEqual({ productId: PRODUCT, name: 'Amul Ghee Gold 1L', uom: 'ea' });
    expect(desk!.findProduct('0000000000000')).toBeNull();

    const draft = (returnId: string, number: string, refundMinor: number, over: Record<string, unknown> = {}) => ({
      returnId, number, reasonCode: 'damaged',
      lines: [{ productId: PRODUCT, uom: 'ea', quantityMinor: 1, disposition: 'resell' as const }],
      refundMinor, refundTender: 'cash' as const,
      approval: { by: MANAGER, reason: 'checked the goods' },
      ...over,
    });

    // Without a manager, nothing happens — not on disk, not in the queue (§28).
    expect((await desk!.submit(draft('RT-NR-0', 'RT-0000', 50_000, { approval: undefined }))).kind).toBe('approval_required');
    // The cashier cannot approve their own.
    expect((await desk!.submit(draft('RT-NR-0', 'RT-0000', 50_000, { approval: { by: CASHIER, reason: 'mine' } }))).kind).toBe('approval_required');
    expect(await readLog(edge.returnsLog.path)).toHaveLength(0);

    // ── 4. The return: ₹500 back in cash for one tin, approved by the manager. Settled at the lane = on THIS box's disk.
    const first = await desk!.submit(draft('RT-NR-1', 'RT-0001', 50_000));
    expect(first.kind).toBe('settled');
    // The same return again: refunded ONCE (RR-F03) — the reused id is a conflict, never a second payout.
    expect((await desk!.submit(draft('RT-NR-1', 'RT-0001', 50_000))).kind).toBe('conflict');
    // And one the LANE's pack allows (₹1,200 < ₹1,500) but head office's cap does not (> ₹1,000): the lane settles it —
    // its policy is the one it was given — and head office must then SAY so, not lose it.
    expect((await desk!.submit(draft('RT-NR-2', 'RT-0002', 120_000))).kind).toBe('settled');
    // Above even the lane's cap: refused before anything is written.
    expect((await desk!.submit(draft('RT-NR-3', 'RT-0003', 160_000))).kind).toBe('invalid');

    const onDisk = await readLog(edge.returnsLog.path);
    expect(onDisk.map((r) => (r.ok ? (JSON.parse(r.record) as { returnId: string }).returnId : 'unreadable'))).toEqual(['RT-NR-1', 'RT-NR-2']);
    expect(onDisk[0]?.ok === true ? JSON.parse(onDisk[0].record) : undefined).toMatchObject({
      noReceipt: true, originalSaleId: null, laneId: LANE, processedBy: CASHIER, approvedBy: MANAGER, refundMinor: 50_000, refundTender: 'cash',
      lines: [{ productId: PRODUCT, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
    });
    expect(edge.returnsOutbox.unsentCount()).toBe(2);

    // ── 5. The line is up: one pass sends both; head office re-checks each on its OWN no-receipt route.
    const sync = await edge.syncOnce!();
    expect(sync).toMatchObject({ dead: 0, remaining: 0 });
    expect(sync.sent).toBeGreaterThanOrEqual(2);
    expect(edge.returnsOutbox.unsentCount()).toBe(0);

    // The register: both recorded; exactly one flagged — the one above HEAD OFFICE's cap, with the reason named.
    const report = await ok(call('GET', '/v1/pos/no-receipt-returns', OWNER), 200) as { count: number; flaggedCount: number; totalRefundedMinor: number };
    expect(report).toMatchObject({ count: 2, flaggedCount: 1, totalRefundedMinor: 170_000 });
    const exceptions = await ok(call('GET', '/v1/pos/return-governance-exceptions', OWNER), 200) as {
      count: number; exceptions: { returnId: string; originalSaleId: string | null; noReceipt?: boolean; governanceFlags: string[] }[];
    };
    expect(exceptions.count).toBe(1);
    expect(exceptions.exceptions[0]).toMatchObject({ returnId: 'RT-NR-2', originalSaleId: null, noReceipt: true, governanceFlags: ['no_receipt_over_cap'] });

    // ── 6. Stock (M08-FR-01 · F17): both resold tins are back on THIS store's shelf — not at a location named after the lane.
    expect(await onHandAt(STORE)).toBe(2);
    expect(await onHandAt(LANE)).toBe(0);

    // ── 7. A second pass sends nothing more: the returns are delivered, not re-sent (idempotent, §31.1).
    expect(await edge.syncOnce!()).toMatchObject({ sent: 0, dead: 0, remaining: 0 });
    expect((await ok(call('GET', '/v1/pos/no-receipt-returns', OWNER), 200) as { count: number }).count).toBe(2);
  }, 90_000);
});
