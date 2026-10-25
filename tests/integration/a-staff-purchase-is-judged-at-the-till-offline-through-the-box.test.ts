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
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/earn-rule';
import { issueTillPins, signInTill, signInAtLane, operatorHeader, receiptNumberAt } from '../support/till-operator';

/**
 * **OB-301 (M15-FR-03, owner 23 Oct 2026, in writing) — a staff member's own shopping is judged AT THE TILL, before the
 * sale is saved, from the policy the store computer holds — with the network CUT and across a COLD RESTART of the box.**
 * In memory (head office behind a fetch shim) and, with DATABASE_URL, on real PostgreSQL through the production API:
 *
 *   • head office records two staff members' own customer accounts (their member codes); the owner has set nothing yet.
 *     The store pack carries the policy with both parts "not set";
 *   • offline, the real till rings a staff member's shopping: REFUSED before the disk — the owner has not named the
 *     service-desk till (not set) — in English and Tamil; a customer's bill at the same till is saved;
 *   • the owner sets a 10% cap and names this till the service desk; the box takes the new pack; the network is cut and
 *     the box COLD-RESTARTS on the same disk;
 *   • still offline: the staff member's shopping at the shelf price is SAVED; the same with 20% off is REFUSED (above the
 *     cap); a cashier ringing her OWN shopping is REFUSED (never self-billing) — none of the refused bills is on the disk;
 *   • the line comes back: head office banks the bills and its exception list shows the one staff bill, allowed.
 */

const OWNER = 'u-owner';
const STORE = 'S1';
const LANE = 'lane-1';
const CASHIER = 'u-meena';
const STAFF = 'u-ravi';
const MOBILE = { ravi: '9840011111', meena: '9840022222', customer: '9840033333' };
const TODAY = new Date().toISOString().slice(0, 10);
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const ean = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const RICE = ean('890100000002');
const memberOf = (mobile: string): string => memberRefFor(loyaltyMemberKey(TEST_PACK_KEY), mobile)!;

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  readonly url: string;
  request(r: { method: 'GET' | 'POST' | 'PUT'; path: string; userId: string; body?: unknown; idempotencyKey?: string }): Promise<Reply>;
  grant(user: string, role: string, scope?: readonly string[] | 'all'): Promise<void>;
  fetchFor(saved: typeof globalThis.fetch, isCut: () => boolean): typeof globalThis.fetch;
}
const branchOf = (user: string): string | undefined => (user === 'u-box' || user === CASHIER || user === STAFF ? STORE : undefined);

async function ok(cloud: Cloud, method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, what: string, userId = OWNER): Promise<Reply> {
  const r = await cloud.request({ method, path, userId, body, idempotencyKey: `k-${what}` });
  expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r;
}

async function setUp(cloud: Cloud): Promise<void> {
  await ok(cloud, 'POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'org-c1');
  await ok(cloud, 'POST', `/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1' }, 'org-s1');
  await ok(cloud, 'POST', `/v1/stores/${STORE}/settings`, SETTINGS, 'settings');
  await cloud.grant('u-box', 'store_computer', [STORE]);
  await cloud.grant(CASHIER, 'cashier', [STORE]);
  await cloud.grant(STAFF, 'cashier', [STORE]);
  await ok(cloud, 'POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', { rateBps: 0 }, 'tax-1006');
  await ok(cloud, 'POST', '/v1/catalogue/products/p-rice/publish', { product: { sku: 'SKU-RICE', name: 'Ponni rice 5kg', baseUom: 'each', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active', handling: 'ambient' }, categories: [GROCERY] }, 'publish-rice');
  await ok(cloud, 'POST', '/v1/prices/list/p-rice/entries/e1', { scope: 'store', scopeRef: STORE, priceMinor: 40_000, mrpMinor: 40_000, costMinor: 20_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY }, 'price-rice');
  await ok(cloud, 'POST', `/v1/catalogue/products/p-rice/barcodes/${RICE}`, { kind: 'ean' }, 'barcode-rice');
  await ok(cloud, 'POST', '/v1/inventory/movements', { movementId: 'r-rice', productId: 'p-rice', locationId: STORE, kind: 'received', quantityMinor: 50, uom: 'each', occurredAt: AT, enteredBy: OWNER, unitCostMinor: 20_000 }, 'rx-rice');
  await ok(cloud, 'POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AT }, 'pack');
  // The staff list, and each staff member's own customer account — recorded by the owner, never by themselves.
  for (const [id, name] of [[STAFF, 'Ravi'], [CASHIER, 'Meena']] as const) {
    await ok(cloud, 'POST', `/v1/hr/workforce/employees/${id}`, { name, branchId: STORE, roles: ['cashier'], active: true }, `emp-${id}`);
  }
  await ok(cloud, 'POST', `/v1/loss-prevention/staff-purchases/accounts/${STAFF}`, { customerRef: memberOf(MOBILE.ravi) }, 'acct-ravi');
  await ok(cloud, 'POST', `/v1/loss-prevention/staff-purchases/accounts/${CASHIER}`, { customerRef: memberOf(MOBILE.meena) }, 'acct-meena');
}

async function judgeOfflineAcrossARestart(cloud: Cloud): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-staff-purchase-'));
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
  const catalogueOf = async (edge: EdgeProcess): Promise<CatalogueSnapshot> => {
    const html = await (await saved(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    return JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot;
  };
  const onDisk = async (e: EdgeProcess) => (await readLog(e.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
  try {
    await issueTillPins(dir, TEST_PACK_KEY, [CASHIER, STAFF]);
    const edge = await boot();
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });

    // ── OFFLINE, policy "not set" ───────────────────────────────────────────────────────────────────────────────────
    cut = true;
    const till = bootPos({ laneId: LANE, catalogue: await catalogueOf(edge), lanePort: edge.lane!.port });
    await signInTill(till, CASHIER);
    const first = await till.nextReceipt();
    expect(till.setLoyaltyMobile(MOBILE.ravi)).toMatchObject({ ok: true });
    till.scanBarcode(RICE);
    let refused: unknown;
    try { await till.tenderCash(`S-${first}`, first, new Date().toISOString()); } catch (e) { refused = e; }
    expect(refused).toMatchObject({ name: 'LocalCommitRefusedError', refusedBecause: 'staff_purchase_refused' });
    expect((refused as { laneMessage: string }).laneMessage).toMatch(/owner has not named the service-desk till yet \(not set\)/);
    expect((refused as { laneMessageTa: string }).laneMessageTa).toMatch(/சேவை மேசை/);
    // The same bill for a customer is saved: the rule is about staff, not the till.
    till.setLoyaltyMobile(MOBILE.customer);
    await till.tenderCash(`S-${first}`, first, new Date().toISOString());
    expect((await onDisk(edge)).map((r) => r['id'])).toEqual([`S-${first}`]);

    // ── The owner sets the cap (10%) and names this till the service desk; the box takes the new pack ─────────────────
    cut = false;
    await ok(cloud, 'POST', '/v1/loss-prevention/staff-purchases/policy', { staffDiscountCapBps: 1_000, serviceDeskLaneIds: [LANE] }, 'policy');
    expect(await edge.refreshStorePack!()).toMatchObject({ status: 'updated' });

    // ── THE NETWORK IS CUT, and the box COLD-RESTARTS on the same disk ──────────────────────────────────────────────
    cut = true;
    await edge.stop();
    edges.splice(0);
    const back = await boot();
    const till2 = bootPos({ laneId: LANE, catalogue: await catalogueOf(back), lanePort: back.lane!.port });
    await signInTill(till2, CASHIER);
    // Ravi's shopping at the shelf price, rung by Meena at the service desk: saved.
    const second = await till2.nextReceipt();
    till2.setLoyaltyMobile(MOBILE.ravi);
    till2.scanBarcode(RICE);
    await till2.tenderCash(`S-${second}`, second, new Date().toISOString());

    // The same with 20% off (a price lowered from ₹400 to ₹320): refused above the cap — posted straight to the box.
    const token = await signInAtLane(back.lane!.port, CASHIER);
    const post = async (id: string, mobile: string, unitPriceMinor: number, fromUnitPriceMinor?: number) => (await (await saved(`http://127.0.0.1:${back.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        id, number: await receiptNumberAt(back.lane!.port, token), laneId: LANE, cashierId: CASHIER, tradingDay: TODAY, committedAt: new Date().toISOString(), customerMobile: mobile,
        lines: [{ productId: 'p-rice', quantityMinor: 1, uom: 'ea', unitPriceMinor, lineTotalMinor: unitPriceMinor, ...(fromUnitPriceMinor === undefined ? {} : { priceOverride: { fromUnitPriceMinor, approvedBy: OWNER, activityId: 'a-1' } }) }],
        tenders: [{ kind: 'cash', amount: { minor: unitPriceMinor, currency: 'INR' }, status: 'settled' }], total: unitPriceMinor,
      }),
    })).json()) as { committed: boolean; refusedBecause?: string; refusals?: string[]; laneMessage?: string; laneMessageTa?: string };
    const over = await post('S-OVER', MOBILE.ravi, 32_000, 40_000);
    expect(over).toMatchObject({ committed: false, refusedBecause: 'staff_purchase_refused', refusals: ['discount_above_cap'] });
    expect(over.laneMessage).toMatch(/20% off; the owner's staff discount is at most 10%/);
    expect(over.laneMessageTa).toMatch(/தள்ளுபடி/);
    // Within the cap (5% off): saved.
    expect(await post('S-WITHIN', MOBILE.ravi, 38_000, 40_000)).toMatchObject({ committed: true });
    // Meena ringing her OWN shopping: never — even at the desk, even at the shelf price.
    const self = await post('S-SELF', MOBILE.meena, 40_000);
    expect(self).toMatchObject({ committed: false, refusedBecause: 'staff_purchase_refused', refusals: ['self_billing'] });
    expect(self.laneMessage).toMatch(/may never bill their own shopping/);

    const kept = (await onDisk(back)).map((r) => r['id']);
    expect(kept).toEqual([`S-${first}`, `S-${second}`, 'S-WITHIN']);

    // ── THE LINE COMES BACK: head office banks them; its list shows the two staff bills, both allowed ───────────────
    cut = false;
    expect(await back.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const list = await cloud.request({ method: 'GET', path: '/v1/loss-prevention/staff-purchases/exceptions', userId: OWNER });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body, JSON.stringify(list.body)).toMatchObject({ staffBills: 2, refused: 0 });
    expect((list.body as { bills: { saleId: string; employeeId: string; allowed: boolean }[] }).bills.map((b) => [b.saleId, b.employeeId, b.allowed]).sort())
      .toEqual([[`S-${second}`, STAFF, true], ['S-WITHIN', STAFF, true]].sort());
  } finally {
    for (const e of edges.splice(0)) await e.stop();
    globalThis.fetch = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('OB-301 — a staff purchase is judged at the till, offline, through the box (memory)', () => {
  it('"not set" refuses; once set: shelf price saved, over the cap refused, self-billing refused; a cold restart; head office lists it', async () => {
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
    await setUp(cloud);
    await judgeOfflineAcrossARestart(cloud);
  }, 120_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('OB-301 — the same on real PostgreSQL, over HTTP', () => {
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

  it('"not set" refuses; once set: shelf price saved, over the cap refused, self-billing refused; a cold restart; head office lists it', async () => {
    await judgeOfflineAcrossARestart(cloud);
  }, 180_000);
});
