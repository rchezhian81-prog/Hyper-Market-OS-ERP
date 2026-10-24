import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { issueTillPins, signInTill, signInAtLane, operatorHeader, receiptNumberAt } from '../support/till-operator';
import { ownerApprovedSettingOn } from '../support/owner-approved-setting';

/**
 * **OB-288 till side — the till trades on head office's new catalogue rules with the network CUT, through a REAL store
 * computer, across a COLD RESTART of the box, and head office books what it sent exactly once.** In memory (head office
 * behind a fetch shim) and, with DATABASE_URL, on real PostgreSQL through the production API over HTTP:
 *
 *   • head office sets the shop's state (owner-approved, OB-348) and the delivery-fee product (OB-299), defines an own-
 *     barcode bundle (OB-306) and publishes the signed pack; the box takes the pack and the store setup, and serves the till
 *     the shop's state, the fee product and the bundle;
 *   • with the network down, the real `bootPos` till rings two combos (exploded on the record from the pack's definition)
 *     and a bill marked for delivery (the fee line, paid in full); a liquor line posted to the box is refused before its
 *     disk in the state's words (B17);
 *   • the box is stopped and started on the same disk: both bills are still there, still unsent;
 *   • the line comes back: head office takes stock off each COMPONENT (never the combo), and books ONE delivery order, paid
 *     at the till — a resend books nothing twice.
 */

const OWNER = 'u-owner';
const STORE = 'S1';
const LANE = 'lane-1';
const CASHIER = 'u-meena';
const TODAY = new Date().toISOString().slice(0, 10);
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };

/** An EAN-13 with its correct check digit. */
const ean = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const CODE = { combo: ean('890100000001'), rice: ean('890100000002') };

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  readonly url: string;
  request(r: { method: 'GET' | 'POST' | 'PUT'; path: string; userId: string; body?: unknown; idempotencyKey?: string }): Promise<Reply>;
  grant(user: string, role: string, scope?: readonly string[] | 'all'): Promise<void>;
  fetchFor(saved: typeof globalThis.fetch, isCut: () => boolean): typeof globalThis.fetch;
}
const branchOf = (user: string): string | undefined => (user === 'u-box' || user === CASHIER ? STORE : undefined);

async function setUp(cloud: Cloud): Promise<void> {
  const ok = async (method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, what: string): Promise<Reply> => {
    const r = await cloud.request({ method, path, userId: OWNER, body, idempotencyKey: `k-${what}` });
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r;
  };
  await ok('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'org-c1');
  await ok('POST', `/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }, 'org-s1');
  await ok('POST', `/v1/stores/${STORE}/settings`, SETTINGS, 'settings');
  await cloud.grant('u-box', 'store_computer', [STORE]);
  await cloud.grant(CASHIER, 'cashier', [STORE]);
  // OB-348: the shop's state — the co-owner asks, the owner approves (never the maker). OB-299: the fee product.
  expect((await ownerApprovedSettingOn(cloud as never, 'store.state', { value: 'TN' }, OWNER)).status).toBe(200);
  for (const [hsn, bps] of [['1006', 0], ['0713', 500], ['1507', 500], ['2106', 1200], ['996813', 1800]] as const) {
    await ok('POST', `/v1/catalogue/tax-classes/${hsn}/rates/2017-07-01`, { rateBps: bps }, `tax-${hsn}`);
  }
  const product = async (id: string, name: string, taxClass: string, priceMinor: number, code?: string) => {
    await ok('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass, lifecycle: 'active', handling: 'ambient' }, categories: [GROCERY] }, `publish-${id}`);
    await ok('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor, mrpMinor: priceMinor, costMinor: Math.floor(priceMinor / 2), marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }, `price-${id}`);
    if (code !== undefined) await ok('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }, `barcode-${id}`);
  };
  await product('p-dal', 'Toor dal 1kg', '0713', 12_000);
  await product('p-oil', 'Groundnut oil 1L', '1507', 20_000);
  await product('p-combo', 'Festival combo', '2106', 45_000, CODE.combo);
  await product('p-rice', 'Ponni rice 5kg', '1006', 40_000, CODE.rice);
  await product('p-del', 'Home delivery', '996813', 3_000);
  for (const [productId, qty] of [['p-dal', 20], ['p-oil', 10], ['p-rice', 10]] as const) {
    await ok('POST', '/v1/inventory/movements', { movementId: `r-${productId}`, productId, locationId: STORE, kind: 'received', quantityMinor: qty, uom: 'each', occurredAt: AT, enteredBy: OWNER, unitCostMinor: 1_000 }, `rx-${productId}`);
  }
  await ok('POST', '/v1/catalogue/bundles/p-combo', { components: [{ productId: 'p-dal', quantityMinor: 2 }, { productId: 'p-oil', quantityMinor: 1 }], reason: 'festival pack' }, 'bundle');
  await ok('PUT', '/v1/platform/setup/delivery.till_fee_product', { value: 'p-del' }, 'fee-product');
  await ok('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AT }, 'pack');
}

async function tradeOfflineAndSync(cloud: Cloud): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-till-side-'));
  const saved = globalThis.fetch;
  let cut = false;
  globalThis.fetch = cloud.fetchFor(saved, () => cut);
  const edges: EdgeProcess[] = [];
  const boot = async (): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE,
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: cloud.url, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: cloud.tenant, branchId: STORE }),
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE,
    }, () => {}))!;
    edges.push(edge);
    return edge;
  };
  try {
    await issueTillPins(dir, TEST_PACK_KEY, [CASHIER]);
    const edge = await boot();
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
    // What the box serves the till: the shop's state, the fee product and the bundle in the signed pack.
    const html = await (await saved(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const catalogue = JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot;
    const lane = JSON.parse(/<script>window\.posLane = ([\s\S]*?);<\/script>/.exec(html)![1]!) as { shopState: string | null; tillDeliveryFeeProductId: string | null };
    expect(lane).toMatchObject({ shopState: 'TN', tillDeliveryFeeProductId: 'p-del' });
    expect(catalogue.bundles?.map((b) => [b.bundleProductId, b.components])).toEqual([['p-combo', [{ productId: 'p-dal', quantityMinor: 2 }, { productId: 'p-oil', quantityMinor: 1 }]]]);

    // ── THE NETWORK IS CUT ─────────────────────────────────────────────────────────────────────────────────────────
    cut = true;
    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port, shopState: lane.shopState!, tillDeliveryFeeProductId: lane.tillDeliveryFeeProductId! });
    await signInTill(till, CASHIER);
    const combo = await till.nextReceipt();
    till.scanBarcode(CODE.combo);
    till.scanBarcode(CODE.combo);
    expect(till.payableMinor()).toBe(90_000);
    await till.tenderCash(`S-${combo}`, combo, new Date().toISOString());
    till.newSale();
    const delivered = await till.nextReceipt();
    till.scanBarcode(CODE.rice);
    expect(till.deliverThisBill()).toMatchObject({ ok: true, feeMinor: 3_000 });
    expect(till.isForDelivery()).toBe(true);
    expect(till.payableMinor()).toBe(43_000); // paid in full, the fee included
    await till.tenderCash(`S-${delivered}`, delivered, new Date().toISOString());
    // B17: a liquor line (an alcoholic-drink HSN the box's catalogue does not even hold) posted straight to the box.
    const token = await signInAtLane(edge.lane!.port, CASHIER);
    const liquor = await (await saved(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ id: 'S-LIQ', number: await receiptNumberAt(edge.lane!.port, token), laneId: LANE, cashierId: CASHIER, tradingDay: TODAY, committedAt: new Date().toISOString(),
        lines: [{ productId: 'p-beer', quantityMinor: 1, uom: 'ea', unitPriceMinor: 15_000, lineTotalMinor: 15_000, hsnCode: '2203' }], tenders: [{ kind: 'cash', amount: { minor: 15_000, currency: 'INR' }, status: 'settled' }], total: 15_000 }),
    })).json() as { committed: boolean; refusedBecause?: string; laneMessage?: string };
    expect(liquor).toMatchObject({ committed: false, refusedBecause: 'liquor_not_sold' });
    expect(liquor.laneMessage).toMatch(/TASMAC/);

    const onDisk = async (e: EdgeProcess) => (await readLog(e.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
    const check = (records: Record<string, unknown>[]): void => {
      expect(records.map((r) => r['id'])).toEqual([`S-${combo}`, `S-${delivered}`]);
      const comboLines = records[0]!['lines'] as Record<string, unknown>[];
      expect(comboLines.map((l) => l['bundle'])).toEqual([0, 1].map(() => ({ bundleProductId: 'p-combo', version: 1, components: [{ productId: 'p-dal', quantityMinor: 2, uom: 'ea' }, { productId: 'p-oil', quantityMinor: 1, uom: 'ea' }] })));
      expect(records[1]!['delivery']).toEqual({ requested: true, feeProductId: 'p-del', feeMinor: 3_000 });
    };
    check(await onDisk(edge));

    // ── A COLD RESTART of the store computer, still offline: the same disk, a new process ─────────────────────────
    await edge.stop();
    edges.splice(0);
    const back = await boot();
    check(await onDisk(back));
    expect(back.outbox.unsentCount()).toBe(2);

    // ── THE LINE COMES BACK ────────────────────────────────────────────────────────────────────────────────────────
    cut = false;
    expect(await back.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const onHand = async (productId: string): Promise<number> =>
      ((await cloud.request({ method: 'GET', path: `/v1/inventory/availability?productId=${productId}`, userId: OWNER })).body as { rows: { locationId: string; onHandMinor: number }[] })
        .rows.filter((r) => r.locationId === STORE).reduce((n, r) => n + r.onHandMinor, 0);
    expect(await onHand('p-dal')).toBe(20 - 4);
    expect(await onHand('p-oil')).toBe(10 - 2);
    expect(await onHand('p-combo')).toBe(0);
    expect(await onHand('p-rice')).toBe(10 - 1);
    const order = await cloud.request({ method: 'GET', path: `/v1/orders/till-S-${delivered}`, userId: OWNER });
    expect(order.status, JSON.stringify(order.body)).toBe(200);
    expect(order.body).toMatchObject({ state: 'confirmed' });
    // Nothing is left to send; a resend of the bill books nothing twice.
    expect(await back.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const record = (await onDisk(back))[1]!;
    const again = await cloud.request({ method: 'POST', path: '/v1/sales', userId: CASHIER, idempotencyKey: `resend-${delivered}`, body: {
      saleId: record['id'], receiptNumber: record['number'], laneId: LANE, locationId: STORE, cashierId: CASHIER, tradingDay: record['tradingDay'], committedAt: record['committedAt'],
      totalMinor: record['total'], currency: 'INR', packVersion: 1, lines: record['lines'], tenders: [{ kind: 'cash', amountMinor: record['total'] }], delivery: record['delivery'],
    } });
    expect(again.body).toMatchObject({ delivery: { outcome: 'already_booked', orderId: `till-S-${delivered}` } });
  } finally {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('OB-288 till side — the till trades head office\'s rules offline through the box (memory)', () => {
  it('bundles exploded, a delivery bill paid in full, liquor refused by the state; a cold restart; head office books it once', async () => {
    const h = apiHarness();
    const tenant = randomUUID();
    const cloud: Cloud = {
      tenant, url: 'https://cloud.example.test',
      request: ({ method, path, userId, body, idempotencyKey }) => {
        const [bare, qs] = path.split('?');
        const b = branchOf(userId);
        return h.raw({
          method, path: bare!, query: Object.fromEntries(new URLSearchParams(qs ?? '')),
          token: TEST_IDP.issue({ sub: userId, tenantId: tenant, ...(b === undefined ? {} : { branchId: b }) }),
          ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
      },
      grant: (user, role, scope) => h.provisionRole(tenant, user, role, scope),
      fetchFor: (saved, isCut) => (async (url: string, init: RequestInit = {}): Promise<Response> => {
        if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
        if (isCut()) throw new Error('network down');
        const hdr = (init.headers ?? {}) as Record<string, string>;
        const u = new URL(url);
        const res = await h.raw({
          method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
          token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
        });
        return new Response(JSON.stringify(res.body), { status: res.status });
      }) as unknown as typeof globalThis.fetch,
    };
    await h.seedOwner(tenant, OWNER);
    await h.enableFeature(tenant, 'delivery');
    await setUp(cloud);
    await tradeOfflineAndSync(cloud);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('OB-288 till side — the same on real PostgreSQL, over HTTP', () => {
  let real: RealCloud;
  let cloud: Cloud;
  beforeAll(async () => {
    real = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: TEST_PACK_KEY });
    cloud = {
      tenant: real.tenantId, url: real.baseUrl,
      request: async ({ method, path, userId, body, idempotencyKey }) => {
        const b = branchOf(userId);
        return real.request({ method, path, userId, ...(b === undefined ? {} : { branchId: b }), ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      },
      grant: (user, role, scope) => real.grant(user, role, undefined, scope),
      fetchFor: (saved, isCut) => (async (url: string, init?: RequestInit): Promise<Response> => {
        if (String(url).startsWith(real.baseUrl) && isCut()) throw new Error('network down');
        return saved(url, init);
      }) as unknown as typeof globalThis.fetch,
    };
    await setUp(cloud);
  }, 180_000);
  afterAll(async () => { await real?.stop(); });

  it('bundles exploded, a delivery bill paid in full, liquor refused by the state; a cold restart; head office books it once', async () => {
    await tradeOfflineAndSync(cloud);
  }, 180_000);
});
