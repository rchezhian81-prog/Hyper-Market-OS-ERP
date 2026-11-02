import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import type { HttpRequest } from '../../services/kernel/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { InMemoryConfigVersionStore, SqlConfigVersionStore } from '../../packages/persistence/src/config-store';
import { DurableTenantSettings } from '../../packages/tenant/src/durable-settings';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, signInTill } from '../support/till-operator';
import { DEFAULT_SHOP_CALENDAR, shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **W3 · D06-FR-03 · OB-673 and D07-FR-04 · OB-677 on two REAL store computers (two tills) with the cloud UNREACHABLE.**
 * In memory and, with DATABASE_URL, on real PostgreSQL (migrations run on an empty database):
 *
 *   • OB-673: head office's signed store pack carries its live coupons. With the internet down a single-use coupon is
 *     accepted on till 1 AND on till 2 (neither box can know of the other's use) and both sales go through. When the link
 *     returns both uses are recorded once each, the second is a visible `coupon_used_beyond_its_limit` exception for the
 *     manager — never a silent last-write-wins — and a resend changes nothing.
 *   • OB-677: a gift card holding ₹800 is taken offline up to ₹500 per till per card (the owner's limit rides the pack from
 *     the tenant setting): ₹600 is refused with "take another payment until the link is back", ₹500 goes through on each
 *     till; a restart with the cable out remembers it. At head office the card is overspent by ₹200 across the two tills —
 *     `gift_card_overspent`, valued, both payments kept. A gift card SOLD at the till offline commits locally, is spent on
 *     the same box before head office knows it, and is issued at head office when the link returns. No receipt shows a
 *     card's whole code.
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

interface Backing { readonly name: string; readonly make: () => ApiHarness }
const backings: Backing[] = [{ name: 'the in-memory stores', make: () => apiHarness({ settings: new DurableTenantSettings(new InMemoryConfigVersionStore()) }) }];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => {
      const sql = pgPoolClient(pool!);
      return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), settings: new DurableTenantSettings(new SqlConfigVersionStore(sql)) });
    },
  });
}

const OWNER = 'u-owner';
const STORE = 'S1';
const CASHIER = 'u-meena';
const BOX = 'u-box';
const TODAY = shopDateIn(new Date().toISOString());
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
const ean = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const GHEE = ean('890100000077');
type Reply = { status: number; body: unknown };

describe.each(backings)('OB-673 · OB-677: coupons and gift cards at two tills with the internet down — $name', ({ make }) => {
  let h: ApiHarness;
  let tenant: string;
  const dirs: string[] = [];
  let cut = false;
  const saved = globalThis.fetch;

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Reply> => {
    const [bare, qs] = path.split('?');
    return h.raw({
      method, path: bare!, query: Object.fromEntries(new URLSearchParams(qs ?? '')),
      token: TEST_IDP.issue({ sub: userId, tenantId: tenant, ...(userId === BOX || userId === CASHIER ? { branchId: STORE } : {}) }),
      ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }),
    });
  };
  const ok = async (method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, what: string): Promise<Reply> => {
    const r = await call(method, path, OWNER, body);
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r;
  };
  const boot = async (dir: string, laneId: string): Promise<EdgeProcess> => (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: laneId,
    CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: BOX, tenantId: tenant, branchId: STORE }),
    EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE,
  }, () => {}))!;
  const tillOn = async (edge: EdgeProcess, laneId: string) => {
    const till = bootPos({ laneId, lanePort: edge.lane!.port, timeZone: DEFAULT_SHOP_CALENDAR.timeZone, taxPercent: 0 });
    await signInTill(till, CASHIER);
    return till;
  };
  const balance = async (code: string): Promise<number> =>
    ((await call('GET', `/v1/stored-value/instruments/${code}`, OWNER)).body as { balanceMinor: number }).balanceMinor;
  const exceptions = async (): Promise<{ kind: string; saleId: string; differenceMinor?: number; detail: string }[]> => {
    const b = (await call('GET', '/v1/sales/exceptions', OWNER)).body as Record<string, { kind: string; saleId: string; differenceMinor?: number; detail: string }[] | unknown>;
    return ['critical', 'material', 'informational'].flatMap((k) => (Array.isArray(b[k]) ? b[k] as { kind: string; saleId: string; detail: string }[] : []));
  };
  const refusalOf = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return 'committed'; } catch (e) { return (e as { laneMessage?: string }).laneMessage ?? String(e); }
  };

  beforeAll(async () => {
    h = make();
    tenant = randomUUID();
    await h.seedOwner(tenant, OWNER);
    await h.enableFeature(tenant, 'loyalty'); // the shop's plan includes the loyalty programme (coupons, M36-FR-01)
    await ok('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'org-c1');
    await ok('POST', `/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }, 'org-s1');
    await ok('POST', `/v1/stores/${STORE}/settings`, SETTINGS, 'settings');
    await h.provisionRole(tenant, BOX, 'store_computer', [STORE]);
    await h.provisionRole(tenant, CASHIER, 'cashier', [STORE]);
    await ok('POST', '/v1/catalogue/tax-classes/0405/rates/2017-07-01', { rateBps: 0 }, 'tax');
    await ok('POST', '/v1/catalogue/products/p-ghee/publish', { product: { sku: 'SKU-GHEE', name: 'Ghee 1L', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0405', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, 'publish');
    await ok('POST', '/v1/prices/list/p-ghee/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 100_000, mrpMinor: 100_000, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }, 'price');
    await ok('POST', `/v1/catalogue/products/p-ghee/barcodes/${GHEE}`, { kind: 'ean' }, 'barcode');
    await ok('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AT }, 'pack');
    // A single-use ₹50-off coupon, and a gift card holding ₹800 — both head office's own records (synthetic).
    await ok('POST', '/v1/loyalty/coupons/DIWALI50', { kind: 'amount_off', valueMinor: 5_000, validUntil: '2099-12-31', maxRedemptions: 1, maxPerCustomer: 1 }, 'coupon');
    await ok('POST', '/v1/stored-value/instruments', { instrumentId: 'GC-1001', kind: 'gift_card', ownerRef: 'c-gift', faceValueMinor: 80_000 }, 'gift card');

    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
      if (cut) throw new Error('ENETUNREACH');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
  }, 180_000);
  afterAll(async () => {
    globalThis.fetch = saved;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('accepts the coupon and takes the gift card offline on both tills; head office records each once and shows the double use and the overspend', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'sre-w3-vouchers-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'sre-w3-vouchers-b-'));
    dirs.push(dirA, dirB);
    await issueTillPins(dirA, TEST_PACK_KEY, [CASHIER]);
    await issueTillPins(dirB, TEST_PACK_KEY, [CASHIER]);
    let boxA = await boot(dirA, 'lane-1');
    const boxB = await boot(dirB, 'lane-2');
    for (const box of [boxA, boxB]) {
      expect(await box.refreshPack!()).toMatchObject({ status: 'updated' });
      expect(await box.refreshStorePack!()).toMatchObject({ status: 'updated' });
    }

    // ── THE INTERNET GOES DOWN. Each box tries head office once and learns it cannot reach it. ──
    cut = true;
    for (const box of [boxA, boxB]) expect(await box.refreshPack!()).toMatchObject({ status: 'offline' });

    // TILL 1: a ₹1,000 bill, ₹50 off with the coupon, ₹500 from the gift card (₹600 is over the offline limit), the rest in cash.
    let till1 = await tillOn(boxA, 'lane-1');
    till1.scan({ productId: 'p-ghee', description: 'Ghee 1L', unitPriceMinor: 100_000, qty: 1 });
    expect(await till1.couponAtTill('DIWALI50')).toMatchObject({ ok: true, offMinor: 5_000 });
    expect(till1.payableMinor()).toBe(95_000);
    const card1 = await till1.giftCardBalance('gc-1001');
    expect(card1).toMatchObject({ ok: true, last4: '1001', balanceMinor: 80_000, linkUp: false, offlineCapMinor: 50_000, mayTakeMinor: 50_000 });
    const over = await refusalOf(till1.tenderSplit({ saleId: 'S-A1', receiptNumber: await till1.nextReceipt(), atIsoUtc: new Date().toISOString(), parts: [
      { kind: 'gift_card', amountMinor: 60_000, giftCardCode: 'GC-1001' }, { kind: 'cash', amountMinor: 35_000 },
    ] }));
    expect(over).toMatch(/cannot reach head office.*at most ₹500\.00 more.*until the link is back/);
    const r1 = await till1.nextReceipt();
    expect(await till1.tenderSplit({ saleId: 'S-A1', receiptNumber: r1, atIsoUtc: new Date().toISOString(), parts: [
      { kind: 'gift_card', amountMinor: 50_000, giftCardCode: 'GC-1001' }, { kind: 'cash', amountMinor: 45_000 },
    ] })).toBe(r1);
    // The bill shows the card by its last four only (never the whole code — like every instrument reference).
    const bill1 = till1.receiptLines();
    expect(bill1.ok && bill1.lines.join('\n')).toContain('••••1001');
    expect(bill1.ok && bill1.lines.join('\n')).not.toContain('GC-1001');
    till1.newSale();
    // This till has used its ₹500 on this card until the link is back.
    expect(await till1.giftCardBalance('GC-1001')).toMatchObject({ ok: true, balanceMinor: 30_000, offlineRemainingMinor: 0, mayTakeMinor: 0 });

    // TILL 2 (another store computer): the same single-use coupon and the same card — it cannot know till 1 used them.
    const till2 = await tillOn(boxB, 'lane-2');
    till2.scan({ productId: 'p-ghee', description: 'Ghee 1L', unitPriceMinor: 100_000, qty: 1 });
    expect(await till2.couponAtTill('DIWALI50')).toMatchObject({ ok: true, offMinor: 5_000 });
    const r2 = await till2.nextReceipt();
    expect(await till2.tenderSplit({ saleId: 'S-B1', receiptNumber: r2, atIsoUtc: new Date().toISOString(), parts: [
      { kind: 'gift_card', amountMinor: 50_000, giftCardCode: 'GC-1001' }, { kind: 'cash', amountMinor: 45_000 },
    ] })).toBe(r2);
    till2.newSale();

    // (One test process holds one till sign-in at a time, as one browser does: till 1's cashier signs in again.)
    await signInTill(till1, CASHIER);
    // TILL 1 sells a NEW gift card with the internet down — saved on its store computer, no bill number, cash in the drawer.
    const sold = await till1.sellGiftCard({ saleId: 'GC-SALE-1', code: 'gc-2002', valueMinor: 30_000, kind: 'cash', atIsoUtc: new Date().toISOString() });
    expect(sold, JSON.stringify(sold)).toMatchObject({ ok: true, card: '••••2002', valueMinor: 30_000 });
    expect(await till1.sellGiftCard({ saleId: 'GC-SALE-2', code: 'GC-2002', valueMinor: 30_000, kind: 'cash', atIsoUtc: new Date().toISOString() })).toMatchObject({ ok: false, refusedBecause: 'gift_card_already_issued' });
    // ...and it is spent on the same box before head office knows it.
    till1.scan({ productId: 'p-ghee', description: 'Ghee 1L', unitPriceMinor: 100_000, qty: 1 });
    const r3 = await till1.nextReceipt();
    expect(await till1.tenderSplit({ saleId: 'S-A2', receiptNumber: r3, atIsoUtc: new Date().toISOString(), parts: [
      { kind: 'gift_card', amountMinor: 20_000, giftCardCode: 'GC-2002' }, { kind: 'cash', amountMinor: 80_000 },
    ] })).toBe(r3);
    till1.newSale();
    const onDisk = (await readLog(boxA.log.path)).map((r) => JSON.parse((r as { record: string }).record) as { id: string; kind?: string; coupons?: unknown; tenders: { kind: string; giftCard?: unknown }[] });
    expect(onDisk.map((r) => r.id)).toEqual(['S-A1', 'GC-SALE-1', 'S-A2']);
    expect(onDisk[0]!.coupons).toEqual([{ code: 'DIWALI50', discountMinor: 5_000 }]);
    expect(onDisk[0]!.tenders[0]!.giftCard).toEqual({ code: 'GC-1001', capturedOffline: true });
    expect(onDisk[1]!.kind).toBe('gift_card_sale');
    expect((await boxA.syncOnce!()).sent).toBe(0); // nothing reached head office
    expect(await balance('GC-1001')).toBe(80_000);

    // ── Box 1 restarts with the cable still out: it remembers this till's ₹500 on the card and the card it sold. ──
    await boxA.stop();
    boxA = await boot(dirA, 'lane-1');
    expect(await boxA.refreshPack!()).toMatchObject({ status: 'offline' });
    till1 = await tillOn(boxA, 'lane-1');
    expect(await till1.giftCardBalance('GC-1001')).toMatchObject({ ok: true, mayTakeMinor: 0 });
    expect(await till1.giftCardBalance('GC-2002')).toMatchObject({ ok: true, balanceMinor: 10_000 });

    // ── THE LINK RETURNS. Both boxes send what they kept. ──
    cut = false;
    expect(await boxA.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(await boxB.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });

    // Coupon: both uses recorded once each; the second is the manager's exception, valued at the ₹50 given.
    const coupon = (await call('GET', '/v1/loyalty/coupons/DIWALI50', OWNER)).body as { redemptionCount: number; redemptions: { saleId: string }[] };
    expect(coupon.redemptionCount).toBe(2);
    expect(coupon.redemptions.map((r) => r.saleId).sort()).toEqual(['S-A1', 'S-B1']);
    // Gift cards: ₹800 − ₹500 − ₹500 → spent twice by ₹200, both payments kept; the card sold offline is issued and spent.
    expect(await balance('GC-1001')).toBe(-20_000);
    expect(await balance('GC-2002')).toBe(10_000);
    const found = await exceptions();
    const couponTwice = found.filter((e) => e.kind === 'coupon_used_beyond_its_limit');
    expect(couponTwice.map((e) => [e.saleId, e.differenceMinor])).toEqual([['S-B1', 5_000]]);
    expect(couponTwice[0]!.detail).toContain('DIWALI50');
    const overspent = found.filter((e) => e.kind === 'gift_card_overspent');
    expect(overspent.map((e) => [e.saleId, e.differenceMinor])).toEqual([['S-B1', 20_000]]);
    expect(overspent[0]!.detail).toContain('••••1001');
    expect(overspent[0]!.detail).not.toContain('GC-1001');
    expect(found.filter((e) => e.kind === 'gift_card_sold_twice' || e.kind === 'gift_card_not_valid_when_spent')).toEqual([]);

    // A resend of everything changes nothing (idempotent): still two uses, the same balances, the same findings.
    const rec = JSON.parse(((await readLog(boxB.log.path))[0] as { record: string }).record) as Record<string, unknown>;
    const { toCloudSale } = await import('../../edge/store-edge/src/cloud-sale');
    expect((await call('POST', '/v1/sales', BOX, toCloudSale(rec, 1, STORE, 'lane-2'))).status).toBe(202);
    expect(((await call('GET', '/v1/loyalty/coupons/DIWALI50', OWNER)).body as { redemptionCount: number }).redemptionCount).toBe(2);
    expect(await balance('GC-1001')).toBe(-20_000);
    expect((await exceptions()).filter((e) => e.kind === 'coupon_used_beyond_its_limit' || e.kind === 'gift_card_overspent')).toHaveLength(2);

    // The next pack carries head office's truth: the coupon is used up, the card holds nothing — said at the till.
    expect(await boxA.refreshStorePack!()).toMatchObject({ status: 'updated' });
    expect(await boxA.refreshPack!()).not.toMatchObject({ status: 'offline' });
    till1.scan({ productId: 'p-ghee', description: 'Ghee 1L', unitPriceMinor: 100_000, qty: 1 });
    expect(await till1.couponAtTill('DIWALI50')).toMatchObject({ ok: false, refusedBecause: 'limit_reached' });
    expect(await till1.giftCardBalance('GC-1001')).toMatchObject({ ok: true, balanceMinor: 0, linkUp: true, mayTakeMinor: 0 });
    expect(await till1.giftCardBalance('GC-2002')).toMatchObject({ ok: true, balanceMinor: 10_000, mayTakeMinor: 10_000 });
    await boxA.stop();
    await boxB.stop();
  }, 180_000);
});
