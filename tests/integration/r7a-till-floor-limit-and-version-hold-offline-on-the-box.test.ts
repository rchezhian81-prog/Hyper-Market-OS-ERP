import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { askForApproval, decide } from '../support/approval-request';
import { actionDetails } from '../../services/identity/src/approval-requests';
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
import { APP_BUILD_VERSION } from '../../packages/platform-admin/src/client-version';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { issueTillPins, signInTill, signInAtLane, operatorHeader, receiptNumberAt, pinOf } from '../support/till-operator';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **OB-500 · OB-501 (R7-A) — the till's price-cut floor, each manager's price-cut limit and head office's app version policy
 * travel in the SIGNED store pack and hold on a REAL store computer with the network CUT, across a cold restart; head
 * office re-checks what arrives and raises it.** In memory and, with DATABASE_URL, on real PostgreSQL (migrations run on an
 * empty database; the same API composition over the SQL stores):
 *
 *   • head office holds a product bought at ₹400 and the store's 20% margin floor → its floor is ₹500 (the cost is never
 *     sent); the owner's money limits give a store manager ₹100 of price cut at the till (asked by the accountant, approved
 *     by the owner);
 *   • offline, the till refuses ₹450 before any manager is asked (and the box refuses it even when asked directly); the
 *     manager's ₹120 cut is refused by the box (above ₹100), in English and Tamil; ₹90 off goes through; the owner (no limit)
 *     may approve more;
 *   • head office sets a minimum version above this build: offline, the till FINISHES the bill on it, then refuses to start
 *     a new one in plain words; the box marks the bill; after a cold restart the mark is still on the record;
 *   • the line comes back: head office raises the unsupported-version bills, and a lowered line that arrives beyond the floor
 *     or the manager's limit is raised as its own exception — the sale stands.
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
const ACCOUNTANT = 'u-acc';
const BOX = 'u-box';
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
const branchOf = (user: string): string | undefined => (user === BOX || user === CASHIER || user === MANAGER ? STORE : undefined);
type Reply = { status: number; body: unknown };

describe.each(backings)('OB-500 · OB-501 on the store computer, offline — $name', ({ make }) => {
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
  const onDisk = async (e: EdgeProcess) => (await readLog(e.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
  const materialKinds = async (): Promise<{ kind: string; saleId: string; detail: string }[]> =>
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
    await h.provisionRole(tenant, ACCOUNTANT, 'accountant');
    await ok('POST', '/v1/catalogue/tax-classes/0405/rates/2017-07-01', { rateBps: 1200 }, 'tax');
    await ok('POST', '/v1/catalogue/products/p-ghee/publish', { product: { sku: 'SKU-GHEE', name: 'Ghee 1L', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '0405', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] }, 'publish');
    await ok('POST', '/v1/prices/list/p-ghee/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 64_000, mrpMinor: 64_000, costMinor: 40_000, marginFloorBps: 2_000, currency: 'INR', effectiveFrom: TODAY }, 'price');
    await ok('POST', `/v1/catalogue/products/p-ghee/barcodes/${GHEE}`, { kind: 'ean' }, 'barcode');
    // Bought at ₹400 a unit: with the store's 20% margin floor, the lowest price is ₹500.
    await ok('POST', '/v1/inventory/movements', { movementId: 'r-ghee', productId: 'p-ghee', locationId: STORE, kind: 'received', quantityMinor: 20, uom: 'each', occurredAt: AT, enteredBy: OWNER, unitCostMinor: 40_000 }, 'receipt');
    await ok('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AT }, 'pack');
    // The owner's money limits: a store manager may take up to ₹100 off a line at the till — asked by the accountant, approved
    // by the owner, applied by the accountant (nobody changes a rule alone; a manager never their own).
    const rules = (await call('GET', '/v1/approvals/rules', OWNER)).body as { rules: { limits: { value: { byRole: Record<string, Record<string, number | null>> } } } };
    const change = { value: { byRole: { ...rules.rules.limits.value.byRole, store_manager: { ...rules.rules.limits.value.byRole['store_manager'], price_override: 10_000 } } }, basedOnVersion: 0, reason: 'managers may take up to Rs 100 off a damaged item' };
    const ask = await askForApproval(h, tenant, ACCOUNTANT, { kind: 'approval_rule_change', subjectRef: 'rule:limits', details: actionDetails(change, { rule: 'limits' }) });
    const requestId = (ask.body as { requestId: string }).requestId;
    expect((await decide(h, tenant, OWNER, requestId)).status).toBe(201);
    await ok('PUT', '/v1/approvals/rules/limits', { ...change, approvalId: requestId }, 'limits applied', ACCOUNTANT);

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
    dir = await mkdtemp(join(tmpdir(), 'sre-r7a-'));
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

  it('OB-500: offline, the till refuses a cut below the floor, the box refuses one above the manager\'s limit (English and Tamil); within it, it goes through', async () => {
    // The signed pack carries the floor and the limits — and never the buying cost.
    const { catalogue, lane } = await served(edge);
    expect(lane['priceFloors']).toEqual({ 'p-ghee': 50_000 });
    expect(JSON.stringify(lane)).not.toContain('40000');

    cut = true; // ── THE NETWORK IS CUT ──
    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port, priceFloors: lane['priceFloors'] as Record<string, number> });
    await signInTill(till, CASHIER);
    till.scanBarcode(GHEE);
    const line = till.basket()[0]!.lineId;

    // ₹450 is below the ₹500 floor: refused at the till, before any manager is asked, in both languages.
    const below = till.priceChangeValue(line, 45_000);
    expect(below).toMatchObject({ ok: false });
    expect((below as { laneMessage: string }).laneMessage).toContain('₹500.00');
    expect((below as { laneMessageTa?: string }).laneMessageTa).toContain('குறைந்தபட்ச விலை');
    // …and the store computer refuses it too when asked directly (an old till, or one that skipped its own check).
    const direct = await till.approveAtTill({ managerId: MANAGER, pin: '000000', kind: 'price_override', billRef: till.currentBillRef(), valueMinor: 19_000, reason: 'damaged_pack', productId: 'p-ghee', toUnitMinor: 45_000 });
    expect(direct).toMatchObject({ approved: false, refusedBecause: 'below_floor' });

    // ₹640 → ₹520 takes ₹120 off: above the manager's ₹100 limit — refused by the box, in English and Tamil.
    const big = till.priceChangeValue(line, 52_000);
    expect(big).toMatchObject({ ok: true, reductionMinor: 12_000, productId: 'p-ghee' });
    const over = await till.approveAtTill({ managerId: MANAGER, pin: pinOf(MANAGER), kind: 'price_override', billRef: till.currentBillRef(), valueMinor: 12_000, reason: 'damaged_pack', productId: 'p-ghee', toUnitMinor: 52_000 });
    expect(over).toMatchObject({ approved: false, refusedBecause: 'above_limit' });
    expect((over as { laneMessage: string }).laneMessage).toContain('₹100.00');
    expect((over as { laneMessageTa?: string }).laneMessageTa).toContain('வரம்பை');
    // The owner has no limit: the same ₹120 is his to approve.
    const owners = await till.approveAtTill({ managerId: OWNER, pin: pinOf(OWNER), kind: 'price_override', billRef: till.currentBillRef(), valueMinor: 12_000, reason: 'damaged_pack', productId: 'p-ghee', toUnitMinor: 52_000 });
    expect(owners, JSON.stringify(owners)).toMatchObject({ approved: true });

    // ₹90 off (₹640 → ₹550) is within the manager's limit: approved, recorded, the line changes.
    const fine = await till.approveAtTill({ managerId: MANAGER, pin: pinOf(MANAGER), kind: 'price_override', billRef: till.currentBillRef(), valueMinor: 9_000, reason: 'damaged_pack', productId: 'p-ghee', toUnitMinor: 55_000 });
    expect(fine, JSON.stringify(fine)).toMatchObject({ approved: true });
    // An approval for ₹550 is never spent on another price.
    expect(await till.priceChangeAtTill(line, 54_000, 'damaged_pack', { approvalId: (fine as { approvalId: string }).approvalId })).toMatchObject({ ok: false });
    expect(await till.priceChangeAtTill(line, 55_000, 'damaged_pack', { approvalId: (fine as { approvalId: string }).approvalId })).toMatchObject({ ok: true });
    expect(till.basket()[0]!.unitPriceMinor).toBe(55_000);
    const n = await till.nextReceipt();
    await till.tenderCash(`S-${n}`, n, new Date().toISOString());
    expect((await onDisk(edge)).map((r) => r['id'])).toContain(`S-${n}`);
    cut = false;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    // Within the floor and the limit: head office raises nothing about the cut.
    expect((await materialKinds()).filter((e) => e.saleId === `S-${n}` && e.kind.startsWith('price_cut'))).toEqual([]);
  }, 120_000);

  it('OB-500: head office re-checks a lowered line that arrives beyond the floor or the manager\'s limit and raises it — the sale stands', async () => {
    const sale = (saleId: string, unitPriceMinor: number) => ({
      saleId, receiptNumber: `R-${saleId}`, laneId: LANE, locationId: STORE, cashierId: CASHIER, tradingDay: TODAY, committedAt: new Date(Date.now() - 1_000).toISOString(),
      totalMinor: unitPriceMinor, currency: 'INR', packVersion: 1, tenders: [{ kind: 'cash', amountMinor: unitPriceMinor }],
      lines: [{ productId: 'p-ghee', quantityMinor: 1, uom: 'ea', unitPriceMinor, lineTotalMinor: unitPriceMinor, priceOverride: { fromUnitPriceMinor: 64_000, approvedBy: MANAGER, activityId: `O-${saleId}` } }],
    });
    const below = await call('POST', '/v1/sales', BOX, sale('S-HO-1', 48_000));
    expect(below.status).toBe(202);
    const kinds = (below.body as { exceptions: { kind: string }[] }).exceptions.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['price_cut_below_floor', 'price_cut_above_approver_limit']));
    const within = await call('POST', '/v1/sales', BOX, sale('S-HO-2', 56_000));
    expect((within.body as { exceptions: { kind: string }[] }).exceptions.map((e) => e.kind).filter((k) => k.startsWith('price_cut'))).toEqual([]);
    // A cold restart: the findings were stored, not held in memory.
    h = harness();
    const raised = (await materialKinds()).filter((e) => e.saleId === 'S-HO-1' && e.kind.startsWith('price_cut')).map((e) => e.kind).sort();
    expect(raised).toEqual(['price_cut_above_approver_limit', 'price_cut_below_floor']);
  }, 60_000);

  it('OB-501: offline, a too-old build finishes the bill in progress, then refuses a new one in plain words; the box marks it; it survives a cold restart; head office raises it', async () => {
    const { catalogue } = await served(edge);
    const till = bootPos({ laneId: LANE, catalogue, lanePort: edge.lane!.port });
    expect(till.appVersion).toBe(APP_BUILD_VERSION);
    await signInTill(till, CASHIER);
    till.scanBarcode(GHEE); // a bill is in progress BEFORE the rule changes

    // Head office raises the minimum supported version above this build; the box takes the new signed pack.
    await ok('POST', '/v1/platform/version-policy', { policy: { currentVersion: '99.0.0', previousVersion: '98.0.0', minimumSupportedVersion: '98.0.0' } }, 'policy');
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
    cut = true; // ── THE NETWORK IS CUT ──
    // The till reads the rule from the box (its badge poll) — no head office needed.
    const status = await (await saved(`http://127.0.0.1:${edge.lane!.port}/lane/sync-status`)).json() as { appVersionPolicy: unknown };
    expect(status.appVersionPolicy).toMatchObject({ minimumSupportedVersion: '98.0.0' });
    expect(till.applyVersionPolicy(status.appVersionPolicy)).toMatchObject({ verdict: 'upgrade_required', mayStartBill: false });

    // The bill in progress is finished — never interrupted.
    till.scanBarcode(GHEE);
    const n = await till.nextReceipt();
    await till.tenderCash(`S-${n}`, n, new Date().toISOString());
    // A new bill is refused, in English and Tamil.
    till.newSale();
    let refused: { name?: string; laneMessage?: string; laneMessageTa?: string } | undefined;
    try { till.scanBarcode(GHEE); } catch (e) { refused = e as typeof refused; }
    expect(refused?.name).toBe('NewBillRefusedError');
    expect(refused?.laneMessage).toMatch(/too old.*98\.0\.0.*a new bill cannot be started/);
    expect(refused?.laneMessageTa).toContain('புதிய பில் தொடங்க முடியாது');
    expect(till.basket()).toHaveLength(0);

    // The box marked the finished bill (it was rung on the too-old build) — and a bill from a till that reports no build.
    const token = await signInAtLane(edge.lane!.port, CASHIER);
    const old = await (await saved(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ id: 'S-OLD', number: await receiptNumberAt(edge.lane!.port, token), laneId: LANE, cashierId: CASHIER, tradingDay: TODAY, committedAt: new Date().toISOString(),
        lines: [{ productId: 'p-ghee', quantityMinor: 1, uom: 'ea', unitPriceMinor: 64_000, lineTotalMinor: 64_000 }], tenders: [{ kind: 'cash', amount: { minor: 64_000, currency: 'INR' }, status: 'settled' }], total: 64_000 }),
    })).json() as { committed: boolean };
    expect(old.committed).toBe(true); // never refused: the sale happened
    const marks = (records: Record<string, unknown>[]) => Object.fromEntries(records.filter((r) => r['id'] === `S-${n}` || r['id'] === 'S-OLD').map((r) => [r['id'], r['storeComputerVersionCheck']]));
    const expected = {
      [`S-${n}`]: { verdict: 'upgrade_required', reported: APP_BUILD_VERSION, minimumSupportedVersion: '98.0.0' },
      'S-OLD': { verdict: 'no_version_reported', reported: null, minimumSupportedVersion: '98.0.0' },
    };
    expect(marks(await onDisk(edge))).toEqual(expected);

    // A cold restart of the box, still offline: the marks are on the records it kept.
    await edge.stop();
    edge = await boot();
    expect(marks(await onDisk(edge))).toEqual(expected);

    cut = false; // ── THE LINE COMES BACK ──
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0 });
    const raised = (await materialKinds()).filter((e) => e.kind === 'sold_on_an_unsupported_app_version');
    expect(raised.map((e) => e.saleId)).toContain(`S-${n}`);
    expect(raised.find((e) => e.saleId === `S-${n}`)!.detail).toContain('store computer marked it too');
    // Put the policy back so the bill path is open for anything after this test.
    await ok('POST', '/v1/platform/version-policy', { policy: { currentVersion: APP_BUILD_VERSION, minimumSupportedVersion: APP_BUILD_VERSION } }, 'policy back');
  }, 120_000);
});
