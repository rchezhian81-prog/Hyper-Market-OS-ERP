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
import { bootPos } from '../../apps/pos/src/browser-entry';
import { bootOwner } from '../../apps/owner-app/src/browser-entry';
import { bootShop, forgetfulBasket } from '../../apps/customer-app/src/browser-entry';
import { httpShopTransport } from '../../apps/customer-app/src/shop-transport';
import { PickSession } from '../../apps/picker-app/src/pick-session';
import { APP_BUILD_VERSION, bindNewWorkGate, openNewWorkGate, NewWorkRefusedError } from '../../packages/platform-admin/src/client-version';
import { APPROVE_REASONS } from '../../packages/approvals/src/reasons';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { money } from '../../packages/contracts/src/money';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { issueTillPins, signInTill, pinOf } from '../support/till-operator';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **OB-519 · OB-520 · OB-521 (R8-A) on a REAL store computer with the network CUT, across a cold restart; head office
 * re-checks and serves the phone apps' policy itself.** In memory and, with DATABASE_URL, on real PostgreSQL (migrations
 * run on an empty database):
 *
 *   • OB-519: with the owner's limits never touched, a store manager approves ₹90 off a line at the till and is refused
 *     ₹120 (above ₹100) — offline, by the store computer, from its signed pack;
 *   • OB-520: a product never received at a cost has no floor; the till says only the owner can approve; the store
 *     computer refuses the manager (English and Tamil) and grants the owner; head office raises a cut a manager approved
 *     on it and the finding survives a cold restart; the owner's own cut raises nothing;
 *   • OB-521: head office withdraws this build; the store computer takes the signed pack; with the network cut the
 *     handhelds read the policy from the store computer and start no new work (a wave already started is finished); the
 *     owner app's page carries it; the customer app asks head office (`GET /v1/me/app-version-policy`), and a new order
 *     is refused before anything is sent — across a cold restart of head office too.
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

interface Backing { readonly name: string; readonly make: () => () => ApiHarness }
const backings: Backing[] = [{
  name: 'the in-memory stores',
  make: () => {
    const settings = new DurableTenantSettings(new InMemoryConfigVersionStore());
    const first = apiHarness({ settings });
    return () => apiHarness({ store: first.store, settings });
  },
}];
if (DATABASE_URL !== undefined) {
  backings.push({
    name: 'real PostgreSQL',
    make: () => {
      const sql = pgPoolClient(pool!);
      const settings = new DurableTenantSettings(new SqlConfigVersionStore(sql));
      const store = new SqlEventStore(sql);
      return () => apiHarness({ store, idempotency: new SqlIdempotencyStore(sql), settings });
    },
  });
}

const OWNER = 'u-owner';
const STORE = 'S1';
const LANE = 'lane-1';
const CASHIER = 'u-meena';
const MANAGER = 'u-mgr';
const BOX = 'u-box';
const CUSTOMER = 'c-anu';
const TODAY = shopDateIn(new Date().toISOString());
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
const RULES = {
  approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
  reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
  service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
  journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
  merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
  writeOffMaterialThresholdMinor: 50_000,
  checklist: [{ itemId: 'close-1', description: 'Count every till blind', blocking: true }],
};
const ean = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const GHEE = ean('890100000077');
const SOAP = ean('890100000084');
const branchOf = (user: string): string | undefined => (user === BOX || user === CASHIER || user === MANAGER ? STORE : undefined);
type Reply = { status: number; body: unknown };
const WITHDRAWN = { currentVersion: '99.0.0', previousVersion: '98.0.0', minimumSupportedVersion: '98.0.0' };

describe.each(backings)('OB-519 · OB-520 · OB-521 on the store computer, offline — $name', ({ make }) => {
  let harness: () => ApiHarness;
  let h: ApiHarness;
  let tenant: string;
  let dir: string;
  let edge: EdgeProcess;
  let cut = false;
  const saved = globalThis.fetch;

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Reply> => {
    const [bare, qs] = path.split('?');
    const b = branchOf(userId);
    return h.raw({
      method, path: bare!, query: Object.fromEntries(new URLSearchParams(qs ?? '')),
      token: TEST_IDP.issue({ sub: userId, tenantId: tenant, ...(b === undefined ? {} : { branchId: b }) }),
      ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }),
    });
  };
  const ok = async (method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, what: string, userId = OWNER): Promise<Reply> => {
    const r = await call(method, path, userId, body);
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r;
  };
  const boot = async (): Promise<EdgeProcess> => (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE,
    EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: BOX, tenantId: tenant, branchId: STORE }),
    EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE,
  }, () => {}))!;
  const served = async (e: EdgeProcess): Promise<{ catalogue: CatalogueSnapshot; lane: Record<string, unknown> }> => {
    const html = await (await saved(`http://127.0.0.1:${e.screens!.port}/pos/`)).text();
    return {
      catalogue: JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot,
      lane: JSON.parse(/<script>window\.posLane = ([\s\S]*?);<\/script>/.exec(html)![1]!) as Record<string, unknown>,
    };
  };
  const material = async (): Promise<{ kind: string; saleId: string; detail: string }[]> =>
    ((await call('GET', '/v1/sales/exceptions', OWNER)).body as { material: { kind: string; saleId: string; detail: string }[] }).material;

  beforeAll(async () => {
    harness = make();
    h = harness();
    tenant = randomUUID();
    await h.seedOwner(tenant, OWNER);
    await ok('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'org-c1');
    await ok('POST', '/v1/org/gst-registrations/33AAACS1111A2ZG', { companyId: 'C1', legalName: 'Synthetic SRE TN' }, 'gst-tn');
    await ok('POST', `/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1', gstin: '33AAACS1111A2ZG' }, 'org-s1');
    await ok('POST', `/v1/stores/${STORE}/settings`, SETTINGS, 'settings');
    await ok('POST', `/v1/stores/${STORE}/rules`, RULES, 'rules (20% margin floor)');
    await h.provisionRole(tenant, BOX, 'store_computer', [STORE]);
    await h.provisionRole(tenant, CASHIER, 'cashier', [STORE]);
    await h.provisionRole(tenant, MANAGER, 'store_manager', [STORE]);
    await h.provisionRole(tenant, CUSTOMER, 'customer');
    await ok('POST', '/v1/catalogue/tax-classes/0405/rates/2017-07-01', { rateBps: 1200 }, 'tax');
    for (const [id, sku, name, barcode, price] of [['p-ghee', 'SKU-GHEE', 'Ghee 1L', GHEE, 64_000], ['p-soap', 'SKU-SOAP', 'New soap', SOAP, 4_000]] as const) {
      await ok('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0405', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, `publish ${id}`);
      await ok('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: price, costMinor: 1, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: TODAY }, `price ${id}`);
      await ok('POST', `/v1/catalogue/products/${id}/barcodes/${barcode}`, { kind: 'ean' }, `barcode ${id}`);
    }
    // Ghee was bought at ₹400 (floor ₹500); the soap was NEVER received at a cost — it has no known floor.
    await ok('POST', '/v1/inventory/movements', { movementId: 'r-ghee', productId: 'p-ghee', locationId: STORE, kind: 'received', quantityMinor: 20, uom: 'each', occurredAt: AT, enteredBy: OWNER, unitCostMinor: 40_000 }, 'receipt');
    await ok('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AT }, 'pack');

    globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
      if (String(url).startsWith('http://127.0.0.1:')) return saved(url, init);
      if (cut) throw new Error('network down');
      const hdr = (init.headers ?? {}) as Record<string, string>;
      const u = new URL(url);
      const res = await h.raw({
        method: (init.method ?? 'GET') as HttpRequest['method'], path: u.pathname, query: Object.fromEntries(u.searchParams),
        token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof globalThis.fetch;
    dir = await mkdtemp(join(tmpdir(), 'sre-r8a-'));
    await issueTillPins(dir, TEST_PACK_KEY, [CASHIER, MANAGER, OWNER]);
    edge = await boot();
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
  }, 180_000);
  afterAll(async () => {
    await edge?.stop();
    globalThis.fetch = saved;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('OB-519 · OB-520: offline, the manager\'s ₹100 holds with nobody setting it; a floorless product\'s cut is the owner\'s alone', async () => {
    const { catalogue, lane } = await served(edge);
    expect(lane['priceFloors']).toEqual({ 'p-ghee': 50_000 });
    cut = true; // ── THE NETWORK IS CUT ──
    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port, priceFloors: lane['priceFloors'] as Record<string, number> });
    await signInTill(till, CASHIER);
    till.scanBarcode(GHEE);
    till.scanBarcode(SOAP);
    const [ghee, soap] = till.basket();
    const approve = (managerId: string, productId: string, toUnitMinor: number, valueMinor: number) =>
      till.approveAtTill({ managerId, pin: pinOf(managerId), kind: 'price_override', billRef: till.currentBillRef(), valueMinor, reason: 'damaged_pack', productId, toUnitMinor, ...cutOn(productId) });
    // OB-500: what the till sends with a price-cut approval — the line, its first price, its quantity and unit.
    const cutOn = (productId: string) => {
      const l = till.basket().find((x) => x.productId === productId)!;
      return { lineId: l.lineId, fromUnitMinor: l.unitPriceMinor, quantityMinor: l.qty, uom: l.uom };
    };

    // OB-519: the decided ₹100 — ₹90 off goes through, ₹120 off is refused, with no owner figure ever set.
    expect(await approve(MANAGER, 'p-ghee', 55_000, 9_000)).toMatchObject({ approved: true });
    const over = await approve(MANAGER, 'p-ghee', 52_000, 12_000);
    expect(over).toMatchObject({ approved: false, refusedBecause: 'above_limit' });
    expect((over as { laneMessage: string }).laneMessage).toContain('₹100.00');

    // OB-520: the soap has no known floor. The till says so before anyone is asked; the box refuses the manager.
    expect(till.priceChangeValue(soap!.lineId, 3_500)).toMatchObject({ ok: true, ownerOnly: true });
    expect(till.priceChangeValue(ghee!.lineId, 60_000)).not.toHaveProperty('ownerOnly');
    const mgr = await approve(MANAGER, 'p-soap', 3_500, 500);
    expect(mgr).toMatchObject({ approved: false, refusedBecause: 'floor_not_known_owner_only' });
    expect((mgr as { laneMessage: string }).laneMessage).toContain('only the owner can approve');
    expect((mgr as { laneMessageTa?: string }).laneMessageTa).toContain('உரிமையாளர் மட்டுமே');
    const owner = await approve(OWNER, 'p-soap', 3_500, 500);
    expect(owner, JSON.stringify(owner)).toMatchObject({ approved: true });
    cut = false;
  }, 120_000);

  it('OB-520: head office raises a floorless cut a manager approved; the owner\'s raises nothing; the finding survives a cold restart', async () => {
    const sale = (saleId: string, approvedBy: string) => ({
      saleId, receiptNumber: `R-${saleId}`, laneId: LANE, locationId: STORE, cashierId: CASHIER, tradingDay: TODAY, committedAt: new Date(Date.now() - 1_000).toISOString(),
      totalMinor: 3_500, currency: 'INR', packVersion: 1, tenders: [{ kind: 'cash', amountMinor: 3_500 }],
      lines: [{ productId: 'p-soap', quantityMinor: 1, uom: 'ea', unitPriceMinor: 3_500, lineTotalMinor: 3_500, priceOverride: { fromUnitPriceMinor: 4_000, approvedBy, activityId: `O-${saleId}` } }],
    });
    const byMgr = await call('POST', '/v1/sales', BOX, sale('S-R8-1', MANAGER));
    expect(byMgr.status).toBe(202);
    expect((byMgr.body as { exceptions: { kind: string }[] }).exceptions.map((e) => e.kind)).toContain('price_cut_without_floor_not_by_owner');
    const byOwner = await call('POST', '/v1/sales', BOX, sale('S-R8-2', OWNER));
    expect((byOwner.body as { exceptions: { kind: string }[] }).exceptions.map((e) => e.kind).filter((k) => k.startsWith('price_cut'))).toEqual([]);
    h = harness(); // ── A COLD RESTART of head office ──
    const raised = (await material()).filter((e) => e.kind === 'price_cut_without_floor_not_by_owner');
    expect(raised.map((e) => e.saleId)).toEqual(['S-R8-1']);
    expect(raised[0]!.detail).toContain('only the owner may approve');
  }, 60_000);

  it('OB-521: the handhelds learn a withdrawn build from the store computer, offline; the phone apps refuse new work; the customer asks head office', async () => {
    // Before any policy: head office says none is in force (never a guessed rule), to a customer and a cashier alike.
    expect(await call('GET', '/v1/me/app-version-policy', CUSTOMER)).toMatchObject({ status: 200, body: { policy: null } });
    // Nobody signed in is told nothing; a person with no role at all is refused (403) — the route is not public.
    expect((await h.raw({ method: 'GET', path: '/v1/me/app-version-policy' })).status).toBe(401);
    expect((await call('GET', '/v1/me/app-version-policy', 'u-nobody')).status).toBe(403);
    await ok('POST', '/v1/platform/version-policy', { policy: WITHDRAWN }, 'policy');
    expect(await call('GET', '/v1/me/app-version-policy', CASHIER)).toMatchObject({ status: 200, body: { policy: { minimumSupportedVersion: '98.0.0' } } });
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });

    // A picker started a wave BEFORE hearing of it; another wave is not started yet.
    const line = (lineId: string) => ({ lineId, orderRef: 'ORD-1', productId: 'p-ghee', description: 'Ghee', bin: 'B1', requiredQty: 1, uom: 'ea' as const, unitPrice: money(64_000, 'INR') });
    const outbox = new SyncOutbox();
    const started = new PickSession('W-1', [line('a'), line('b')], outbox, { now: () => AT });
    const notYet = new PickSession('W-2', [line('c')], new SyncOutbox(), { now: () => AT });
    started.scanBin('B1');
    started.pick('a', 'p-ghee', 1);
    const gate = bindNewWorkGate(openNewWorkGate({ client: 'picker', key: 'k' }), [started, notYet]);

    cut = true; // ── THE NETWORK IS CUT ── the handheld asks the store computer, as its badge does every 10 s.
    const status = await (await saved(`http://127.0.0.1:${edge.lane!.port}/lane/sync-status`)).json() as { appVersionPolicy: unknown };
    expect(status.appVersionPolicy).toMatchObject({ minimumSupportedVersion: '98.0.0' });
    expect(gate.apply(status.appVersionPolicy)).toMatchObject({ verdict: 'upgrade_required', mayStartWork: false, reported: APP_BUILD_VERSION });
    started.scanBin('B1');
    started.pick('b', 'p-ghee', 1); // the wave in hand is finished
    expect(started.progress().complete).toBe(true);
    notYet.scanBin('B1');
    let refused: unknown;
    try { notYet.pick('c', 'p-ghee', 1); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(NewWorkRefusedError);
    expect((refused as NewWorkRefusedError).laneMessage).toMatch(/picking handheld.*too old.*98\.0\.0.*a new wave cannot be started/);
    expect((refused as NewWorkRefusedError).laneMessageTa).toContain('புதிய தொகுப்பைத் தொடங்க முடியாது');

    // The owner app's page, as the store computer serves it, carries the policy — and a new decision is refused.
    const ownerRes = await saved(`http://127.0.0.1:${edge.screens!.port}/owner/`);
    const ownerHtml = await ownerRes.text();
    const ownerData = JSON.parse(/<script>window\.ownerData = ([\s\S]*?);<\/script>/.exec(ownerHtml)![1]!) as { appVersionPolicy?: unknown; branches?: { approvals: { id: string }[] }[] };
    expect(ownerData.appVersionPolicy).toMatchObject({ minimumSupportedVersion: '98.0.0' });
    const ownerGate = openNewWorkGate({ client: 'owner_app', key: 'k', served: ownerData.appVersionPolicy });
    const ownerApp = bootOwner({ ...(ownerData as object), branches: [{ ...(ownerData.branches?.[0] as object), approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Dal', requestedBy: 'u-buyer', valueMinor: 100 }] }] } as never, { read: () => [], write: () => {} } as never, undefined, ownerGate)!;
    expect(ownerApp.decide({ requestId: 'a1', decision: 'approved', reasonCode: APPROVE_REASONS[0]! })).toEqual({ ok: false, refusal: 'app_version_too_old' });

    // A cold restart of the box, still offline: the rule is in its signed pack on disk.
    await edge.stop();
    edge = await boot();
    const again = await (await saved(`http://127.0.0.1:${edge.lane!.port}/lane/sync-status`)).json() as { appVersionPolicy: unknown };
    expect(again.appVersionPolicy).toMatchObject({ minimumSupportedVersion: '98.0.0' });
    cut = false;

    // The customer app talks to head office: a cold restart of head office, then a new order is refused before it is sent.
    h = harness();
    const placed: string[] = [];
    const transport = httpShopTransport({
      baseUrl: 'https://cloud.example.test', isOnline: () => true,
      fetch: (async (url: string, init?: RequestInit) => { if (String(url).includes('/storefront/orders/')) placed.push(String(url)); return globalThis.fetch(url, init); }) as typeof globalThis.fetch,
    });
    const customerGate = openNewWorkGate({ client: 'customer_app', key: 'k' });
    expect(customerGate.refusal()).toBeUndefined(); // the phone has heard nothing yet
    const products = [{ productId: 'p-ghee', name: 'Ghee 1L', categoryId: 'grocery', unitPriceMinor: 64_000, uom: 'ea', status: 'active', availableMinor: 10, availabilityAgeMinutes: 1 }];
    const shop = bootShop({ tenantId: tenant, customerRef: CUSTOMER, products: products as never, packVersion: 1, locationId: STORE, slots: [{ slotId: 'pick', startsAt: AT, endsAt: AT, capacity: 5, booked: 0, kind: 'pickup' }] } as never, forgetfulBasket(), () => 'DSR-1', transport, undefined, customerGate)!;
    shop.signedIn(TEST_IDP.issue({ sub: CUSTOMER, tenantId: tenant }));
    shop.setLine('p-ghee', 1);
    shop.review();
    shop.chooseSlot('pick', AT);
    const out = await shop.place({ providerRef: 'tok_r8a', result: 'authorised' });
    expect(out).toMatchObject({ ok: false, refusedBecause: 'app_version_too_old' });
    expect(out.ok ? '' : out.tellTheCustomer).toMatch(/shopping app.*too old.*98\.0\.0.*a new order cannot be started/);
    expect(placed).toEqual([]);
    // Put the policy back so nothing after this test is barred.
    await ok('POST', '/v1/platform/version-policy', { policy: { currentVersion: APP_BUILD_VERSION, minimumSupportedVersion: APP_BUILD_VERSION } }, 'policy back');
    expect(await call('GET', '/v1/me/app-version-policy', CUSTOMER)).toMatchObject({ status: 200, body: { policy: { minimumSupportedVersion: APP_BUILD_VERSION } } });
  }, 180_000);
});
