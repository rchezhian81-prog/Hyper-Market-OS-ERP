import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { bootOwner, forgetfulQueueStore } from '../../apps/owner-app/src/browser-entry';
import { issueTillPins, signInTill } from '../support/till-operator';
import { TEST_IDP } from '../support/api-harness';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { makeTradingDayRule, tradingDateOf } from '../../packages/calendar/src/trading-day';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **OB-39 "B" (owner, 11 Oct 2026) — the margin is costed at head office's AVERAGE BUYING COST per product and store, on the
 * store computer's Today and in head office's profitability report alike; a product with no cost says "margin not known".**
 *
 * Connected: the REAL head-office API over REAL PostgreSQL, the REAL store computer taking its setup from head office, and the
 * till's own session model selling through the box's lane. Head office receives rice twice at two different costs and tomatoes
 * (weighed, in grams — OB-31) twice at two costs per kg; salt arrives with NO cost. The store setup must carry the
 * quantity-weighted average per WHOLE unit for rice and tomato and nothing for salt; the box's Today costs the costed bill
 * at those averages and counts the salt bill as "margin not known"; head office's profitability names salt and refuses a
 * cost and a profit rather than costing it at zero.
 *
 * Synthetic data only (hard rule #7). Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const KEY = ['average', 'buying', 'cost', 'key'].join('-').padEnd(48, '0');
const COMPANY = 'C1';
const STORE = 'S1';
const BACK = 'S1-BACK';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-cash';
const ACCT = 'u-acct';
const RICE = { productId: 'p-rice', barcode: '8901234560011', sku: 'RICE-5KG', name: 'Ponni rice 5kg', uom: 'ea', price: 48_000, mrp: 50_000, listCost: 39_000 };
const TOMATO = { productId: 'p-tomato', barcode: '2100001000007', sku: 'TOM-LOOSE', name: 'Tomato (loose)', uom: 'kg', price: 4_000, mrp: 5_000, listCost: 2_000 };
const SALT = { productId: 'p-salt', barcode: '8901234560035', sku: 'SALT-1KG', name: 'Salt 1kg', uom: 'ea', price: 2_500, mrp: 2_800, listCost: 2_000 };

// The PRICE LIST carries its own cost (option A, not chosen) — deliberately different, so a margin costed from it is caught.
// Two receipts each, at different costs (rice per bag; tomato per kg, counted in grams). Salt arrives with no cost at all.
const RICE_IN = [{ qty: 10, cost: 40_000, at: BACK }, { qty: 30, cost: 44_000, at: STORE }];
const TOM_IN = [{ qty: 10_000, cost: 2_500, at: BACK }, { qty: 5_000, cost: 3_100, at: STORE }];
/** Grams × price per kg ÷ 1000, rounded once — the OB-31 rule, written out so the expectation is independent. */
const perKg = (grams: number, perKgMinor: number): number => Math.round((grams * perKgMinor) / 1000);
// The averages, worked by hand: rice (10×400 + 30×440) ÷ 40 = ₹430; tomato (₹250 + ₹155) ÷ 15 kg = ₹27/kg.
const RICE_AVG = 43_000;
const TOM_AVG = 2_700;

type Reply = { status: number; body: unknown };

describeOrSkip('OB-39 — the margin is costed at the average buying cost (real head office on PostgreSQL + real store computer)', () => {
  let cloud: RealCloud;
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
  }, 120_000);
  afterAll(async () => {
    for (const edge of edges.splice(0)) await edge.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    await cloud?.stop();
  });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<Reply>, what: string): Promise<Record<string, unknown>> => {
    const r = await p;
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body as Record<string, unknown>;
  };

  it('the store setup carries the weighted average per whole unit (none for a product never bought at a cost); the box Today and head office profitability cost at it; an uncosted product reads "margin not known"', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await cloud.grant(BOX, 'store_computer');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(ACCT, 'accountant');
    await ok(call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'tz'), 'time zone');
    await ok(call('POST', `/v1/org/nodes/${COMPANY}`, OWNER, { kind: 'company', name: 'SRE Retail' }, 'org-c'), 'company');
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: COMPANY, companyId: COMPANY }, 'org-s'), 'store');
    await ok(call('POST', `/v1/org/nodes/${BACK}`, OWNER, { kind: 'warehouse', name: 'Back store', parentId: STORE, companyId: COMPANY }, 'org-b'), 'back store');
    await ok(call('POST', `/v1/stores/${STORE}/settings`, OWNER, { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: BACK }, 'settings'), 'store settings');
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax'), 'tax rate');
    for (const p of [RICE, TOMATO, SALT]) {
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/publish`, OWNER, {
        product: { sku: p.sku, name: p.name, baseUom: p.uom, primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      }, `publish-${p.productId}`), `publish ${p.productId}`);
      await ok(call('POST', `/v1/prices/list/${p.productId}/entries/e1`, OWNER, {
        scope: 'store', scopeRef: STORE, priceMinor: p.price, mrpMinor: p.mrp, costMinor: p.listCost, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
      }, `price-${p.productId}`), `price ${p.productId}`);
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/barcodes/${p.barcode}`, OWNER, { kind: p.uom === 'kg' ? 'internal' : 'ean' }, `barcode-${p.productId}`), `barcode ${p.productId}`);
    }
    // The receipts at cost — at the back store and on the floor (both the store's places); salt arrives uncosted.
    const receive = async (id: string, productId: string, locationId: string, qty: number, uom: string, cost?: number): Promise<void> => {
      await ok(call('POST', '/v1/inventory/movements', OWNER, {
        movementId: id, productId, locationId, kind: 'received', quantityMinor: qty, uom, occurredAt: `${today}T00:30:00.000Z`, enteredBy: OWNER,
        ...(cost === undefined ? {} : { unitCostMinor: cost }),
      }, id), `receive ${id}`);
    };
    for (const [i, r] of RICE_IN.entries()) await receive(`rice-in-${i}`, RICE.productId, r.at, r.qty, 'ea', r.cost);
    for (const [i, r] of TOM_IN.entries()) await receive(`tom-in-${i}`, TOMATO.productId, r.at, r.qty, 'kg', r.cost);
    await receive('salt-in', SALT.productId, STORE, 20, 'ea');
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1'), 'catalogue pack');

    // ── The store computer takes ITS setup from head office (OB-26 "A") — and with it the average buying cost.
    const dataDir = await mkdtemp(join(tmpdir(), 'sre-avg-cost-'));
    dirs.push(dataDir);
    await issueTillPins(dataDir, KEY, [CASHIER]);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '20971520',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: BOX, tenantId: cloud.tenantId, branchId: STORE }),
    }, () => {}))!;
    edges.push(edge);
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });

    // The setup the store computer holds, as head office signed it: the averages per whole unit, nothing for salt.
    const pack = (await call('GET', `/v1/store-packs/${STORE}`, BOX)).body as { sections?: { products?: { productId: string; unitCostMinor?: number }[] } };
    const products = new Map((pack.sections?.products ?? []).map((p) => [p.productId, p] as const));
    expect(products.get(RICE.productId)?.unitCostMinor).toBe(RICE_AVG);
    expect(products.get(TOMATO.productId)?.unitCostMinor).toBe(TOM_AVG);
    expect(products.get(SALT.productId)).toBeDefined();
    expect(products.get(SALT.productId)!.unitCostMinor).toBeUndefined();

    // ── Two bills on the till through the box: rice + 1.2 kg tomato (costed); a salt (no cost).
    const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const catalogue = JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot;
    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    await signInTill(till, CASHIER);
    const T0 = Date.now();
    const tradingDay = tradingDateOf(new Date(T0).toISOString(), makeTradingDayRule('00:00'));
    till.scanBarcode(RICE.barcode);
    const tom = till.scanBarcode(TOMATO.barcode);
    till.setQuantity(tom.lineId, 1_200);
    const billA = RICE.price + perKg(1_200, TOMATO.price);
    expect(till.payableMinor()).toBe(billA);
    const ra = await till.nextReceipt();
    expect(await till.tenderCash('A-1', ra, new Date(T0 + 60_000).toISOString())).toBe(ra);
    till.newSale();
    till.scanBarcode(SALT.barcode);
    const rb = await till.nextReceipt();
    expect(await till.tenderCash('A-2', rb, new Date(T0 + 120_000).toISOString())).toBe(rb);
    till.newSale();
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });

    // ── The owner's Today on the box: bill A costed at the averages; bill B "margin not known", naming salt — never ₹0 cost.
    // The screens re-read the box's log on each request (the read lands for the NEXT request): ask twice, as a reload would.
    await (await fetch(`http://127.0.0.1:${edge.screens!.port}/owner/`)).text();
    const ownerHtml = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/owner/`)).text();
    const ownerData = JSON.parse(/<script>window\.ownerData = ([\s\S]*?);<\/script>/.exec(ownerHtml)![1]!) as Parameters<typeof bootOwner>[0];
    const served = ownerData as unknown as { branches: { sales: { saleId: string; cogsMinor: number; netMinor: number }[] }[]; uncostable: { sales: number; products: string[] } };
    const costA = RICE_AVG + perKg(1_200, TOM_AVG);
    expect(served.branches[0]!.sales.map((x) => [x.saleId, x.cogsMinor])).toEqual([['A-1', costA]]);
    expect(served.uncostable).toMatchObject({ sales: 1, products: [SALT.productId] });
    const brief = bootOwner(ownerData, forgetfulQueueStore())!.brief();
    expect(brief.takings).toMatchObject({ bills: 2, takenMinor: billA + SALT.price, marginUnknownBills: 1 });
    expect(brief.kpis).toMatchObject({ cogsMinor: costA, marginMinor: served.branches[0]!.sales[0]!.netMinor - costA });
    expect(brief.headline).toMatch(/1 bill \(₹25\.00\) whose margin is not known — products with no cost/);

    // ── Head office's profitability: the same averages; with salt sold and never costed, cost and profit are NOT AVAILABLE,
    //    naming salt — never costed at zero.
    await ok(call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP, 'map'), 'posting map');
    await ok(call('POST', `/v1/finance/day-book/${tradingDay}/post`, ACCT, undefined, `post-${tradingDay}`), 'day book');
    type Report = { figures: { name: string; valueMinor?: number; notAvailableBecause?: string }[]; rows: Record<string, string>[] };
    const profit = (await call('GET', `/v1/reports/profitability?day=${tradingDay}`, OWNER)).body as Report;
    const figure = (name: string) => profit.figures.find((f) => f.name === name);
    expect(figure('Revenue net of GST and returns')?.valueMinor).toBeGreaterThan(0);
    expect(figure('Cost of goods sold')).toMatchObject({ notAvailableBecause: expect.stringContaining(SALT.productId) });
    expect(figure('Cost of goods sold')?.valueMinor).toBeUndefined();
    expect(figure('Profit')).toMatchObject({ notAvailableBecause: expect.stringMatching(/never costed at zero/) });
    expect(profit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: RICE.productId, storeId: STORE, averageBuyingCostMinor: String(RICE_AVG), receivedMinor: '40' }),
      expect.objectContaining({ productId: TOMATO.productId, storeId: STORE, averageBuyingCostMinor: String(TOM_AVG), receivedMinor: '15000' }),
    ]));
    expect(profit.rows.some((r) => r['productId'] === SALT.productId)).toBe(false);

    // ── Salt is now bought at a cost: the next setup carries it, and head office costs the day in full.
    await receive('salt-in-costed', SALT.productId, BACK, 10, 'ea', 1_800);
    const saltAvg = 1_800; // only the costed receipt has a cost: the uncosted 20 are not averaged in at zero
    const profit2 = (await call('GET', `/v1/reports/profitability?day=${tradingDay}`, OWNER)).body as Report;
    const cogs2 = costA + saltAvg;
    expect(profit2.figures.find((f) => f.name === 'Cost of goods sold')?.valueMinor).toBe(cogs2);
    const revenue = profit2.figures.find((f) => f.name === 'Revenue net of GST and returns')!.valueMinor!;
    expect(profit2.figures.find((f) => f.name === 'Profit')?.valueMinor).toBe(revenue - cogs2);
    expect((await edge.refreshStorePack!()).status).toMatch(/updated|renewed/);
    const pack2 = (await call('GET', `/v1/store-packs/${STORE}`, BOX)).body as { sections?: { products?: { productId: string; unitCostMinor?: number }[] } };
    expect(pack2.sections?.products?.find((p) => p.productId === SALT.productId)?.unitCostMinor).toBe(saltAvg);
  }, 180_000);
});
