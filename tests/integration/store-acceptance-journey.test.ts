import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { bootOwner, forgetfulQueueStore } from '../../apps/owner-app/src/browser-entry';
import { bootWarehouse, withChosenDelivery } from '../../apps/warehouse-app/src/browser-entry';
import type { WarehouseSession, WarehouseAssignment } from '../../apps/warehouse-app/src/warehouse-session';
import { DeviceOutbox, noDeviceStore } from '../../packages/sync/src/device-outbox';
import { drainToBox, boxStatus } from '../../packages/sync/src/device-drain';
import { issueTillPins, signInTill, managerApprovesOn, signInOnPhone, pinOf } from '../support/till-operator';
import { TEST_IDP } from '../support/api-harness';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { makeTradingDayRule, tradingDateOf } from '../../packages/calendar/src/trading-day';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **THE FINAL INTEGRATED STORE ACCEPTANCE — one synthetic store, one journey, twelve steps, every one through a served
 * interface over real persistent storage (round 4 · the owner's first priority).**
 *
 * Head office is the REAL production API (`startApi`) over REAL PostgreSQL as the application role; the store is the REAL
 * store computer (`startEdge`) with its own durable disk, its lane socket (the till), its device socket (the warehouse
 * phone) and its screen socket; it takes its setup from head office (the signed store pack, OB-26/OB-37) and its catalogue
 * from head office (the signed catalogue pack). The till is the code the served till page boots (`bootPos`), the phone is
 * the code the served warehouse page boots (`bootWarehouse` on the assignment the box injects, draining through the
 * shared device → box leg). Every act is a different signed-in person, under their own sign-in. The roles are NOT all
 * narrow: the buyer, the receiver, the back-store keeper, the floor person and the manager each hold the broad
 * `store_manager` role (the product has no narrower role for those jobs yet), so their roles alone would let any of them
 * do the others' work. The separation this journey proves is the per-act maker-checker the product enforces: a second
 * person approves the supplier, the order, the bill match, the indent and the refund, and nobody approves their own work:
 *
 *   OWNER    u-owner   owner           — issues the purchase order; reads the reports
 *   BUYER    u-buyer   store_manager   — proposes the supplier and the order; captures the bill
 *   FINANCE  u-fin     accountant      — approves the supplier; checks and matches the bill; debit note; day book
 *   RECEIVER u-recv    store_manager   — receives on the warehouse phone
 *   BACK     u-back    store_manager   — puts away and issues to the floor on the warehouse phone
 *   FLOOR    u-floor   store_manager   — raises the floor indent; counts the delivery in on the floor
 *   CASHIER  u-cash    cashier         — sells and closes the shift blind
 *   MANAGER  u-mgr     store_manager   — QC on the held line; approves the indent; resolves the shortfall; approves the
 *                                        refund with their own PIN; closes the day
 *   BOX      u-box     store_computer  — the store computer's own identity (OB-36), bound to its store
 *
 * The 12 steps (in order) and the hybrid conditions — a network cut during trading, a box restart mid-day, reconnection,
 * a duplicate replay, and a recovery — are asserted in the same run; every figure is checked end to end (stock per
 * location, money per tender, points, liabilities) and the owner's reports must EQUAL the journey's own numbers.
 *
 * Synthetic data only (hard rule #7). Needs DATABASE_URL; without it the suite SKIPS (it says so).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) {
  console.warn('store-acceptance-journey: SKIPPED — needs DATABASE_URL (a real PostgreSQL) for head office.');
}

const KEY = ['store', 'acceptance', 'journey', 'key'].join('-').padEnd(48, '0');
const COMPANY = 'C1';
const STORE = 'S1';
const BACK = 'S1-BACK';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const BUYER = 'u-buyer';
const FINANCE = 'u-fin';
const RECEIVER = 'u-recv';
const BACKSTORE = 'u-back';
const FLOOR = 'u-floor';
const CASHIER = 'u-cash';
const MANAGER = 'u-mgr';
const BOX = 'u-box';
const PHONE = 'hh-1';
const SUPPLIER = 'sup-kaveri';
const GSTIN = '33ABCDE1234F1Z7';
const PO = 'po-acc-1';
const INDENT = 'ind-acc-1';
const BIN_DRY = 'BIN-DRY-1';
const BIN_VEG = 'BIN-VEG-1';
const MOBILE = '98400 13579';
const MEMBER = memberRefFor(loyaltyMemberKey(KEY), MOBILE)!;

/** Rice by the bag; tomatoes loose, by the kilogram, counted in GRAMS (OB-31). Prices GST-inclusive; costs per whole unit. */
const RICE = { productId: 'p-rice', barcode: '8901234560011', sku: 'RICE-5KG', name: 'Ponni rice 5kg', uom: 'ea', price: 48_000, mrp: 50_000, cost: 40_000 };
const TOMATO = { productId: 'p-tomato', barcode: '2100001000007', sku: 'TOM-LOOSE', name: 'Tomato (loose)', uom: 'kg', price: 4_000, mrp: 5_000, cost: 2_500 };

/** Grams × price per kg ÷ 1000, rounded once — the OB-31 rule, written out so the expectation is independent. */
const perKg = (grams: number, perKgMinor: number): number => Math.round((grams * perKgMinor) / 1000);

// ── the journey's own numbers ─────────────────────────────────────────────────────────────────────────────────────────
const ORDER = { rice: 20, tomatoGrams: 10_000 };
const DELIVERED = { riceGood: 18, riceDamaged: 2, tomatoGrams: 9_500 };
const INDENT_ASK = { rice: 10, tomatoGrams: 5_000 };
const ARRIVED = { rice: 9, tomatoGrams: 5_000 }; // one bag short on the floor
const S1_LINES = { rice: 2 };                                    // online: the member's first bill
const S2_LINES = { rice: 1, tomatoGrams: 1_500 };               // OFFLINE: rice + 1.5 kg tomatoes
const S3_LINES = { rice: 1 };                                    // OFFLINE, across the restart
const S1_TOTAL = S1_LINES.rice * RICE.price;                                         // ₹960.00
const S2_TOTAL = S2_LINES.rice * RICE.price + perKg(S2_LINES.tomatoGrams, TOMATO.price); // ₹480 + ₹60 = ₹540.00
const S3_TOTAL = S3_LINES.rice * RICE.price;
const S1_UPI = 50_000;
const S1_CASH = S1_TOTAL - S1_UPI;
const S1_POINTS = Math.floor(S1_TOTAL / 10_000);     // 1 point per ₹100 → 9
const S2_POINTS_SPENT = S1_POINTS;                   // the member spends all of them (₹1 each)
const S2_CARD = 30_000;
const S2_CASH = S2_TOTAL - S2_POINTS_SPENT * 100 - S2_CARD;
const FLOAT = 200_000;

type Reply = { status: number; body: unknown };
type Body = Record<string, unknown>;
const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } } | null)?.error?.code;

/** One row of the acceptance table the report prints: step → PASS/GAP → what it proved. */
interface Row { step: string; verdict: 'PASS' | 'GAP'; detail: string }

describeOrSkip('FINAL INTEGRATED STORE ACCEPTANCE — supplier to owner report, one store, real head office (PostgreSQL) + real store computer', () => {
  let cloud: RealCloud;
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const realFetch = globalThis.fetch;
  let cableCut = false;
  /** A RECOVERY drill: head office takes the next relayed sale, but its reply is lost on the way back to the store. */
  let loseNextSaleReply = false;
  const rows: Row[] = [];
  const row = (step: string, detail: string, verdict: Row['verdict'] = 'PASS'): void => { rows.push({ step, verdict, detail }); };

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    // The network cut is the STORE's line to head office: while cut, every call from the store computer to the cloud fails.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (cableCut && String(url).startsWith(cloud.baseUrl)) throw new Error('ENETUNREACH');
      const res = await realFetch(url, init);
      if (loseNextSaleReply && String(url) === `${cloud.baseUrl}/v1/sales` && init?.method === 'POST') { loseNextSaleReply = false; throw new Error('ECONNRESET'); }
      return res;
    }) as typeof globalThis.fetch;
  }, 120_000);
  afterAll(async () => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    if (rows.length > 0) {
      process.stdout.write(`\nSTORE ACCEPTANCE\n${rows.map((r) => `| ${r.step} | ${r.verdict} | ${r.detail} |`).join('\n')}\n`);
    }
    for (const edge of edges.splice(0)) await edge.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    await cloud?.stop();
  });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<Reply>, what: string): Promise<Body> => {
    const r = await p;
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body as Body;
  };

  // ── head office's stock picture: on hand per place, in transit, value per place ─────────────────────────────────────
  interface Place { back: number; floor: number; inTransit: number; backValue: number; floorValue: number }
  const picture = async (productId: string): Promise<Place> => {
    const a = (await call('GET', `/v1/inventory/availability?productId=${productId}`, OWNER)).body as { rows: { locationId: string; onHandMinor: number }[]; inTransit: { quantityMinor: number }[] };
    const v = (await call('GET', `/v1/inventory/valuation?productId=${productId}`, OWNER)).body as { rows: { locationId: string; value: { minor: number } }[] };
    const on = (loc: string): number => a.rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
    const val = (loc: string): number => v.rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.value.minor, 0);
    return { back: on(BACK), floor: on(STORE), inTransit: (a.inTransit ?? []).reduce((s, r) => s + r.quantityMinor, 0), backValue: val(BACK), floorValue: val(STORE) };
  };
  const binHeld = async (binId: string): Promise<Record<string, number>> =>
    Object.fromEntries(((await call('GET', `/v1/warehouse/bins/${binId}`, OWNER)).body as { held: { key: string; quantityMinor: number }[] }).held.map((x) => [x.key, x.quantityMinor]));
  const pointsHeld = async (): Promise<number | undefined> => ((await call('GET', `/v1/customers/${MEMBER}/points`, OWNER)).body as { pointsBalance?: number }).pointsBalance;

  // ── the store computer ──────────────────────────────────────────────────────────────────────────────────────────────
  let dataDir = '';
  async function startBox(): Promise<EdgeProcess> {
    if (dataDir === '') {
      dataDir = await mkdtemp(join(tmpdir(), 'sre-acceptance-'));
      dirs.push(dataDir);
      // The administrator's `till-pin` command on the box: each person's own till PIN (made at run time, never written here).
      await issueTillPins(dataDir, KEY, [RECEIVER, BACKSTORE, CASHIER, MANAGER]);
    }
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '20971520',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_DEVICE_PORT: '0', EDGE_APPS_DIR: 'apps',
      // OB-26 "A": the store computer takes ITS setup from head office (signed, for this store), never a carried file.
      EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: BOX, tenantId: cloud.tenantId, branchId: STORE }),
    }, () => {}))!;
    edges.push(edge);
    return edge;
  }
  async function restartBox(edge: EdgeProcess): Promise<EdgeProcess> {
    await edges.splice(edges.indexOf(edge), 1)[0]!.stop();
    return startBox();
  }
  /** The manager screen's served day-close route on the box (POST /lane/day-close). */
  const laneDayClose2 = async (edge: EdgeProcess, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await realFetch(`http://127.0.0.1:${edge.lane!.port}/lane/day-close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
  async function servedCatalogue(edge: EdgeProcess): Promise<CatalogueSnapshot> {
    const html = await (await realFetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    return JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot;
  }

  // ── the warehouse phone: enrolled once on the box's device socket, then each person signs in with their own PIN ────────
  const deviceBase = (edge: EdgeProcess): string => `http://127.0.0.1:${edge.devices!.port}`;
  let deviceCookie = '';
  async function enrolPhone(edge: EdgeProcess, code: string): Promise<void> {
    const res = await realFetch(`${deviceBase(edge)}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: PHONE, code }) });
    expect(res.status, await res.clone().text()).toBe(200);
    deviceCookie = res.headers.get('set-cookie')!.split(';')[0]!;
  }
  interface Phone { session: WarehouseSession; outbox: DeviceOutbox; data: WarehouseAssignment; sync(): Promise<{ handed: number; refused: number; failed: number; offline: boolean }> }
  /** Open the served warehouse page as `person` (signed in with their PIN) and boot the phone's own session on what it injects. */
  async function openPhone(edge: EdgeProcess, person: string, delivery: string | null = null): Promise<Phone> {
    const cookie = await signInOnPhone(deviceBase(edge), deviceCookie, person, 'warehouse');
    const html = await (await realFetch(`${deviceBase(edge)}/warehouse/`, { headers: { accept: 'text/html', cookie } })).text();
    const m = /<script>window\.warehouseData = ([\s\S]*?);<\/script>/.exec(html);
    expect(m, `the phone page carries an assignment: ${html.slice(0, 300)}`).not.toBeNull();
    const data = withChosenDelivery(JSON.parse(m![1]!) as WarehouseAssignment, delivery)!;
    const outbox = new DeviceOutbox(noDeviceStore());
    const session = bootWarehouse(data, outbox)!;
    expect(session).not.toBeNull();
    // The page's own relay (`openWarehouseRelay`): same origin, the browser sends the cookies — here, added explicitly.
    const fetchWithCookie = ((url: string, init: { method: string; headers: Readonly<Record<string, string>>; body?: string }) =>
      realFetch(url, { ...init, headers: { ...init.headers, cookie } })) as Parameters<typeof drainToBox>[0]['fetch'];
    return {
      session, outbox, data,
      sync: async () => {
        const r = await drainToBox({ outbox, boxBase: deviceBase(edge), source: 'warehouse', fetch: fetchWithCookie });
        const st = await boxStatus({ boxBase: deviceBase(edge), keys: session.handedKeys(), fetch: fetchWithCookie });
        if (st !== undefined) session.noteBoxStatus(st);
        return r;
      },
    };
  }

  it('purchase → receive (phone, QC) → three-way match → back-store bins (grams) → indent → issue (phone) → independent floor receipt → offline split-tender member sale → return with approval → blind shift close + day close → sync once → owner reports equal the journey', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // ═══ 0. The shop: people (each granted by two people's acts), places, settings, products, loyalty rule ═══════════════
    await cloud.grant(BOX, 'store_computer');
    for (const u of [BUYER, RECEIVER, BACKSTORE, FLOOR, MANAGER]) await cloud.grant(u, 'store_manager');
    await cloud.grant(FINANCE, 'accountant');
    await cloud.grant(CASHIER, 'cashier');
    await ok(call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'tz'), 'time zone');
    await ok(call('POST', `/v1/org/nodes/${COMPANY}`, OWNER, { kind: 'company', name: 'SRE Retail' }, 'org-c'), 'company');
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: COMPANY, companyId: COMPANY }, 'org-s'), 'store');
    await ok(call('POST', `/v1/org/nodes/${BACK}`, OWNER, { kind: 'warehouse', name: 'Back store', parentId: STORE, companyId: COMPANY }, 'org-b'), 'back store');
    await ok(call('POST', `/v1/stores/${STORE}/settings`, OWNER, { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 30, warehouseId: BACK }, 'settings'), 'store settings');
    await ok(call('POST', '/v1/inventory/receipt-policy', OWNER, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'receipt-policy'), 'receipt policy');
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax'), 'tax rate');
    for (const p of [RICE, TOMATO]) {
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/publish`, OWNER, {
        product: { sku: p.sku, name: p.name, baseUom: p.uom, primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      }, `publish-${p.productId}`), `publish ${p.productId}`);
      await ok(call('POST', `/v1/prices/list/${p.productId}/entries/e1`, OWNER, {
        scope: 'store', scopeRef: STORE, priceMinor: p.price, mrpMinor: p.mrp, costMinor: p.cost, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
      }, `price-${p.productId}`), `price ${p.productId}`);
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/barcodes/${p.barcode}`, OWNER, { kind: p.uom === 'kg' ? 'internal' : 'ean' }, `barcode-${p.productId}`), `barcode ${p.productId}`);
    }
    for (const [key, value] of [['loyalty.points_per_100_inr', 1], ['loyalty.point_value_paise', 100], ['loyalty.till_spend_cap_paise', 50_000]] as const) {
      await ok(call('PUT', `/v1/platform/setup/${key}`, OWNER, { value }, `set-${key}`), key);
    }
    await ok(call('POST', '/v1/loyalty/members', MANAGER, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, 'join'), 'member joins');
    // The back-store bins at head office, and the warehouse phone in head office's fleet register with a one-time code.
    for (const [bin, zone] of [[BIN_DRY, 'ambient'], [BIN_VEG, 'chilled']] as const) {
      await ok(call('POST', `/v1/warehouse/bins/${bin}`, BACKSTORE, { storeId: BACK, capacityMinor: 1_000_000, pickable: true, zone, locationId: BACK }, `bin-${bin}`), `bin ${bin}`);
    }
    await ok(call('POST', `/v1/platform/devices/${PHONE}/register`, OWNER, { branchId: STORE, kind: 'handheld', label: 'Back store phone' }, 'dev-reg'), 'phone registered');
    const enrolment = await ok(call('POST', `/v1/platform/devices/${PHONE}/enrolment`, OWNER, {}, 'dev-enrol'), 'phone enrolment code');
    const enrolCode = String(enrolment['code']);

    // ═══ 1. Purchase order to an APPROVED supplier (OB-32), delivered to the store (OB-37), approved by a second person ════
    const unit = (minor: number) => ({ minor, currency: 'INR' });
    const poBody = { supplierId: SUPPLIER, deliverToLocationId: BACK, lines: [{ productId: RICE.productId, orderedQty: ORDER.rice, unitCost: unit(RICE.cost) }, { productId: TOMATO.productId, orderedQty: ORDER.tomatoGrams, unitCost: unit(TOMATO.cost) }] };
    const unknownSupplier = await call('POST', `/v1/purchase/orders/${PO}`, BUYER, poBody, 'po-too-early');
    expect(codeOf(unknownSupplier), JSON.stringify(unknownSupplier.body)).toBe('supplier_unknown');
    await ok(call('POST', `/v1/purchase/suppliers/${SUPPLIER}`, BUYER, { name: 'Kaveri Agro Traders', gstin: GSTIN }, 'sup'), 'supplier proposed');
    const notYet = await call('POST', `/v1/purchase/orders/${PO}`, BUYER, poBody, 'po-not-approved');
    expect(codeOf(notYet), JSON.stringify(notYet.body)).toBe('supplier_not_approved');
    expect(codeOf(await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, BUYER, { reason: 'mine' }, 'sup-self'))).toBe('forbidden');
    await ok(call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, FINANCE, { reason: 'GST certificate and FSSAI licence checked' }, 'sup-ok'), 'finance approves supplier');
    await ok(call('POST', `/v1/purchase/orders/${PO}`, BUYER, poBody, 'po'), 'buyer raises the order');
    const selfIssue = await call('POST', `/v1/purchase/orders/${PO}/approval`, BUYER, { reason: 'mine' }, 'po-self');
    expect(selfIssue.status).toBeGreaterThanOrEqual(400);
    const issued = await ok(call('POST', `/v1/purchase/orders/${PO}/approval`, OWNER, { reason: 'within the month budget' }, 'po-ok'), 'owner issues');
    expect(issued['order']).toMatchObject({ status: 'issued', approvedBy: OWNER, requisitionedBy: BUYER });
    const poValue = ORDER.rice * RICE.cost + perKg(ORDER.tomatoGrams, TOMATO.cost);
    expect(await ok(call('GET', '/v1/purchase/commitments', OWNER), 'commitments')).toMatchObject({ known: true, valueMinor: poValue });
    const open = await ok(call('GET', `/v1/purchase/deliveries/open?storeId=${STORE}`, RECEIVER), 'open deliveries');
    expect((open['deliveries'] as { poId: string }[]).map((d) => d.poId)).toEqual([PO]);
    row('1 PO → approved supplier, deliver-to store, second-person approval', `unknown supplier ${unknownSupplier.status} · unapproved ${notYet.status} · buyer self-approve forbidden · finance approved · buyer self-issue ${selfIssue.status} · owner issued · commitment ${poValue} · open delivery at ${STORE}: ${PO}`);

    // ═══ The store computer starts, takes its setup and its catalogue from head office; the phone enrols once ══════════════
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1'), 'catalogue pack');
    let edge = await startBox();
    const setup = await edge.refreshStorePack!();
    expect(setup, JSON.stringify(setup)).toMatchObject({ status: 'updated' });
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    await enrolPhone(edge, enrolCode);

    // ═══ 2. Receiving against the PO on the warehouse phone, with a quality check; a damaged line is an exception ══════════
    let phone = await openPhone(edge, RECEIVER);
    expect(phone.data).toMatchObject({ poId: PO, workerId: RECEIVER, storeId: BACK });
    const grnId = phone.data.grnId!;
    const scan = (commandId: string, barcode: string, qty: number, over: Record<string, unknown> = {}) =>
      phone.session.receive({ commandId, grnId, barcode, scannedQuantity: qty, source: 'po', poId: PO, ...over });
    expect(scan('r-rice-good', RICE.barcode, DELIVERED.riceGood).result, 'rice good').toMatchObject({ accepted: true });
    expect(scan('r-rice-dmg', RICE.barcode, DELIVERED.riceDamaged, { stockState: 'damaged' }).result, 'rice damaged').toMatchObject({ accepted: true });
    expect(scan('r-tom', TOMATO.barcode, DELIVERED.tomatoGrams).result, 'tomato grams').toMatchObject({ accepted: true });
    expect(phone.session.completeReceiving({ grnId })).toMatchObject({ accepted: true, scanCount: 3 });
    expect(await phone.sync()).toMatchObject({ handed: 4, refused: 0, failed: 0 });
    const relayed = await edge.syncOnce!();
    expect(relayed, JSON.stringify(edge.deviceEventsOutbox.deadLetters())).toMatchObject({ dead: 0 });
    const got = (await ok(call('GET', `/v1/inventory/goods-receipt/${grnId}`, OWNER), 'the assembled GRN')) as { grn: { receivedBy: string; relayedBy: string; source: string; warehouseId: string; captured: { lines: { lineId: string; productId: string; uom: string; disposition: string; sellableMinor: number; quarantinedMinor: number; unitCost: { minor: number } }[]; discrepancies: { kind: string; productId: string; quantityMinor: number }[] }; poReceipt: { receivedByProduct: Record<string, number> }; governanceFlags: string[] }; awaitingDisposition: string[] };
    const grn = got.grn;
    expect(grn).toMatchObject({ receivedBy: RECEIVER, relayedBy: BOX, source: 'warehouse-handheld', warehouseId: BACK });
    const lineOf = (productId: string, disposition: string) => grn.captured.lines.find((l) => l.productId === productId && l.disposition === disposition)!;
    expect(lineOf(RICE.productId, 'sellable').sellableMinor).toBe(DELIVERED.riceGood);
    const damagedLine = lineOf(RICE.productId, 'quarantine');
    expect(damagedLine.quarantinedMinor).toBe(DELIVERED.riceDamaged);
    expect(lineOf(TOMATO.productId, 'sellable').sellableMinor).toBe(DELIVERED.tomatoGrams);
    expect(grn.captured.discrepancies.map((d) => [d.kind, d.productId, d.quantityMinor])).toEqual(expect.arrayContaining([
      ['damaged', RICE.productId, DELIVERED.riceDamaged], ['short', TOMATO.productId, ORDER.tomatoGrams - DELIVERED.tomatoGrams],
    ]));
    expect(got.awaitingDisposition).toEqual([damagedLine.lineId]);
    expect(grn.poReceipt.receivedByProduct).toEqual({ [RICE.productId]: DELIVERED.riceGood + DELIVERED.riceDamaged, [TOMATO.productId]: DELIVERED.tomatoGrams });
    // QC is a second person: the receiver cannot dispose of their own delivery; the manager returns the 2 damaged bags.
    expect(codeOf(await call('POST', `/v1/inventory/goods-receipt/${grnId}/lines/${encodeURIComponent(damagedLine.lineId)}/disposition`, RECEIVER, { disposition: 'return', reason: 'mine' }, 'qc-self'))).toBe('self_approval');
    const qc = await ok(call('POST', `/v1/inventory/goods-receipt/${grnId}/lines/${encodeURIComponent(damagedLine.lineId)}/disposition`, MANAGER, { disposition: 'return', reason: 'two bags torn and wet — supplier to collect' }, 'qc'), 'QC returns the damaged line');
    expect(qc).toMatchObject({ disposition: 'return', quantityMinor: DELIVERED.riceDamaged, decidedBy: MANAGER, movementIds: [] });
    // OB-31: the phone counted grams; head office records the master's unit (kg → grams), never the phone's default 'EA'.
    expect(grn.captured.lines.filter((l) => l.productId === TOMATO.productId).map((l) => l.uom)).toEqual(['kg']);
    // M07-FR-02: every line carries the cost the issued order agreed — the discrepancy and the debit note have a value.
    expect(grn.captured.lines.map((l) => [l.productId, l.unitCost.minor])).toEqual([[RICE.productId, RICE.cost], [RICE.productId, RICE.cost], [TOMATO.productId, TOMATO.cost]]);
    expect(grn.governanceFlags).not.toContain('cost_unknown');
    row('2 receive on the phone with QC; damaged line an exception', `phone (RECEIVER, own PIN) scanned 18 good + 2 damaged rice + ${DELIVERED.tomatoGrams} g tomato → box → HO assembled ONE GRN (relayed by the box identity) · damaged line held + receiver self-QC refused + manager returned it · tomato short ${ORDER.tomatoGrams - DELIVERED.tomatoGrams} g flagged · GRN tomato unit '${lineOf(TOMATO.productId, 'sellable').uom}' · cost on lines ${grn.captured.lines.map((l) => l.unitCost.minor).join('/')} flags ${grn.governanceFlags.join(',')}`);

    // ═══ 3. The supplier's bill and the three-way match (order × receipt × invoice) ══════════════════════════════════════
    const billed = { rice: DELIVERED.riceGood + DELIVERED.riceDamaged, tomatoGrams: DELIVERED.tomatoGrams };
    const riceBill = billed.rice * RICE.cost;
    const tomatoBill = perKg(billed.tomatoGrams, TOMATO.cost);
    // The paper charges GST on top of the agreed (ex-tax) price: an intra-state bill (the supplier is in Tamil Nadu, 33…),
    // 5% as 2.5% CGST + 2.5% SGST on each line, each half rounded on its own as a bill prints it.
    const half = (taxable: number): number => Math.round((taxable * 250) / 10_000);
    const billTax = 2 * (half(riceBill) + half(tomatoBill));
    const billGross = riceBill + tomatoBill + billTax;
    const paper = {
      supplierId: SUPPLIER, poId: PO, declaredTotalMinor: billGross,
      lines: [
        { productId: RICE.productId, quantity: billed.rice, unitPriceMinor: RICE.cost, lineTotalMinor: riceBill, cgstMinor: half(riceBill), sgstMinor: half(riceBill) },
        { productId: TOMATO.productId, quantity: billed.tomatoGrams, unitPriceMinor: TOMATO.cost, lineTotalMinor: tomatoBill, cgstMinor: half(tomatoBill), sgstMinor: half(tomatoBill) },
      ],
    };
    const ask = await ok(call('POST', '/v1/approvals/requests', BUYER, { kind: 'supplier_invoice_check', subjectRef: 'inv-acc-1', details: { ...paper, invoiceId: 'inv-acc-1' }, valueMinor: paper.declaredTotalMinor, summary: 'Check bill inv-acc-1', reason: 'paper bill in hand' }, 'ask-inv'), 'ask finance to check the bill');
    expect((await call('POST', `/v1/approvals/requests/${String(ask['requestId'])}/decide`, BUYER, { decision: 'approved', reason: 'mine' }, 'decide-self')).status).toBeGreaterThanOrEqual(400);
    await ok(call('POST', `/v1/approvals/requests/${String(ask['requestId'])}/decide`, FINANCE, { decision: 'approved', reason: 'checked against the paper bill' }, 'decide-inv'), 'finance checks the bill');
    await ok(call('POST', '/v1/purchase/invoices/inv-acc-1/capture', BUYER, { ...paper, approvalId: ask['requestId'] }, 'cap-inv'), 'buyer captures the bill');
    const matched = await ok(call('POST', '/v1/purchase/invoices/inv-acc-1/match', FINANCE, {}, 'match-inv'), 'finance matches three ways');
    // The engine compares the ex-tax prices; the payable carries the paper's GST with it.
    expect(matched).toMatchObject({ invoiceId: 'inv-acc-1', poId: PO, blocked: false, payableMinor: billGross, withheldMinor: 0, matchedBy: FINANCE,
      tax: { taxablePayableMinor: riceBill + tomatoBill, cgstMinor: billTax / 2, sgstMinor: billTax / 2, igstMinor: 0, invoicedTaxMinor: billTax } });
    const note = await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/debit-notes/${encodeURIComponent(`DN-${grnId}-${damagedLine.lineId}`)}/issue`, FINANCE, {}, 'dn');
    const account = await ok(call('GET', `/v1/purchase/suppliers/${SUPPLIER}/account`, FINANCE), 'supplier account') as { totals: Record<string, number>; pendingLineReturns?: { debitNoteRef: string; quantityMinor: number }[] };
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    const dnValue = (note.body as { valueMinor: number }).valueMinor;
    // The debit note is the bill's reversal for the 2 bags: their cost AND the GST the bill charged on them.
    const dnTaxable = DELIVERED.riceDamaged * RICE.cost;
    const dnTaxHalf = Math.round((half(riceBill) * dnTaxable) / riceBill);
    const dnGross = dnTaxable + 2 * dnTaxHalf;
    const owedExpected = billGross - dnGross;
    expect(dnValue).toBe(dnGross);
    expect(account.totals).toMatchObject({ invoicedMinor: billGross, debitNotesMinor: dnGross, paidMinor: 0, owedMinor: owedExpected });
    row('3 supplier invoice + three-way match', `bill captured by buyer, checked by finance in their own session (buyer self-check refused), MATCHED three-way: payable ${String(matched['payableMinor'])} (= ${billed.rice}×₹${RICE.cost / 100} + ${billed.tomatoGrams} g×₹${TOMATO.cost / 100}/kg + GST ${billTax} as CGST/SGST) · debit note for the 2 returned bags valued ${dnValue} (= ${dnTaxable} + GST ${2 * dnTaxHalf}) · supplier owed ${account.totals['owedMinor']} (expected ${owedExpected})`);

    // ═══ 4. Stock lands in the back store, in bins, ON THE PHONE; weighed goods in GRAMS (OB-31) ════════════════════════════
    // The back-store keeper is a different person from the receiver. Their sign-in reloads the phone page as them; the put-away
    // list ("goods in") comes from head office — what is on hand at the back store and in no bin yet.
    expect((await edge.refreshStorePack!()).status).toMatch(/updated|unchanged|renewed/);
    phone = await openPhone(edge, BACKSTORE);
    expect(phone.session.goodsIn().map((g) => [g.productId, g.quantityMinor]).sort()).toEqual([[RICE.productId, DELIVERED.riceGood], [TOMATO.productId, DELIVERED.tomatoGrams]]);
    const at4 = new Date().toISOString();
    const paRice = phone.session.putAway({ commandId: 'pa-rice', scannedProductId: RICE.productId, scannedBinId: BIN_DRY, quantityMinor: DELIVERED.riceGood, uom: 'ea', at: at4 });
    const paTom = phone.session.putAway({ commandId: 'pa-tom', scannedProductId: TOMATO.productId, scannedBinId: BIN_VEG, quantityMinor: DELIVERED.tomatoGrams, uom: 'kg', at: at4 });
    expect(paRice.result, JSON.stringify(paRice.signal)).toMatchObject({ accepted: true });
    expect(paTom.result, JSON.stringify(paTom.signal)).toMatchObject({ accepted: true });
    expect(phone.session.goodsIn().filter((g) => g.quantityMinor > 0)).toEqual([]);
    expect(await phone.sync()).toMatchObject({ handed: 2, refused: 0, failed: 0 });
    expect(await edge.syncOnce!(), JSON.stringify(edge.deviceEventsOutbox.deadLetters())).toMatchObject({ dead: 0 });
    expect(await binHeld(BIN_DRY)).toEqual({ [`${BIN_DRY}|${RICE.productId}|`]: DELIVERED.riceGood });
    expect(await binHeld(BIN_VEG)).toEqual({ [`${BIN_VEG}|${TOMATO.productId}|`]: DELIVERED.tomatoGrams });
    let rice = await picture(RICE.productId);
    let tom = await picture(TOMATO.productId);
    expect(rice).toEqual({ back: DELIVERED.riceGood, floor: 0, inTransit: 0, backValue: DELIVERED.riceGood * RICE.cost, floorValue: 0 });
    expect(tom).toEqual({ back: DELIVERED.tomatoGrams, floor: 0, inTransit: 0, backValue: perKg(DELIVERED.tomatoGrams, TOMATO.cost), floorValue: 0 });
    row('4 back-store bins; weighed goods in grams', `phone (${BACKSTORE}, own PIN; goods-in from head office) put ${DELIVERED.riceGood} rice into ${BIN_DRY} and ${DELIVERED.tomatoGrams} g tomato into ${BIN_VEG} → box → HO bins hold exactly that · back store on hand rice ${rice.back}, tomato ${tom.back} g · valued ${rice.backValue} (= ${DELIVERED.riceGood}×₹${RICE.cost / 100}) and ${tom.backValue} (= ${DELIVERED.tomatoGrams} g×₹${TOMATO.cost / 100}/kg ÷ 1000)`);

    // ═══ 5. The floor supervisor raises a floor indent; a manager approves (never their own) ══════════════════════════════
    const indentBody = { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: RICE.productId, quantityMinor: INDENT_ASK.rice, uom: 'ea' }, { productId: TOMATO.productId, quantityMinor: INDENT_ASK.tomatoGrams, uom: 'kg' }], reason: 'shelf low before the evening rush' };
    const raised = await ok(call('POST', `/v1/floor/indents/${INDENT}`, FLOOR, indentBody, INDENT), 'floor raises the indent');
    expect(raised['indent']).toMatchObject({ state: 'requested', requestedBy: FLOOR });
    expect(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/approval`, FLOOR, {}, 'ind-self'))).toBe('self_approval');
    const approvedIndent = await ok(call('POST', `/v1/floor/indents/${INDENT}/approval`, MANAGER, {}, 'ind-ok'), 'manager approves the indent');
    expect(approvedIndent['indent']).toMatchObject({ state: 'approved', approvedBy: MANAGER });
    row('5 floor indent raised by the floor supervisor', `${INDENT}: ${INDENT_ASK.rice} rice + ${INDENT_ASK.tomatoGrams} g tomato, raised by ${FLOOR}; self-approval forbidden; approved by ${MANAGER}`);

    // ═══ 6. The back store issues to the floor ON THE PHONE, from the bins; the box relays; head office dispatches ═══════════
    expect(await edge.refreshIndentsFeed!()).toMatchObject({ status: 'updated' });
    expect((await edge.refreshStorePack!()).status).toMatch(/updated|unchanged|renewed/);
    phone = await openPhone(edge, BACKSTORE);
    const at6 = new Date().toISOString();
    const issueRice = phone.session.issueToFloor({ commandId: 'is-rice', indentId: INDENT, productId: RICE.productId, scannedBinId: BIN_DRY, scannedItem: RICE.barcode, quantityMinor: INDENT_ASK.rice, at: at6 });
    const issueTom = phone.session.issueToFloor({ commandId: 'is-tom', indentId: INDENT, productId: TOMATO.productId, scannedBinId: BIN_VEG, scannedItem: TOMATO.barcode, quantityMinor: INDENT_ASK.tomatoGrams, at: at6 });
    expect(issueRice, JSON.stringify(issueRice.signal)).toMatchObject({ accepted: true });
    expect(issueTom, JSON.stringify(issueTom.signal)).toMatchObject({ accepted: true });
    expect(await phone.sync()).toMatchObject({ handed: 2, refused: 0, failed: 0 });
    expect(await edge.syncOnce!(), JSON.stringify(edge.deviceEventsOutbox.deadLetters())).toMatchObject({ dead: 0 });
    rice = await picture(RICE.productId);
    tom = await picture(TOMATO.productId);
    expect(rice).toMatchObject({ back: DELIVERED.riceGood - INDENT_ASK.rice, floor: 0, inTransit: INDENT_ASK.rice });
    expect(tom).toMatchObject({ back: DELIVERED.tomatoGrams - INDENT_ASK.tomatoGrams, floor: 0, inTransit: INDENT_ASK.tomatoGrams });
    expect(await binHeld(BIN_DRY)).toEqual({ [`${BIN_DRY}|${RICE.productId}|`]: DELIVERED.riceGood - INDENT_ASK.rice });
    expect(await binHeld(BIN_VEG)).toEqual({ [`${BIN_VEG}|${TOMATO.productId}|`]: DELIVERED.tomatoGrams - INDENT_ASK.tomatoGrams });
    row('6 back-store issue on the phone → transfer to the floor', `phone (${BACKSTORE}, own PIN) issued ${INDENT_ASK.rice} rice from ${BIN_DRY} + ${INDENT_ASK.tomatoGrams} g from ${BIN_VEG} → box → HO: back rice ${rice.back}, tomato ${tom.back} g; in transit ${rice.inTransit} / ${tom.inTransit} g; bins lowered in the same write`);

    // ═══ 7. INDEPENDENT floor receipt: the floor supervisor counts what arrived; a shortfall is a visible exception ════════
    const issues = ((await ok(call('GET', `/v1/floor/indents/${INDENT}`, OWNER), 'indent')) as { issues: { issueId: string; issuedBy: string }[] }).issues;
    expect(issues.map((i) => [i.issueId, i.issuedBy]).sort()).toEqual([['is-rice', BACKSTORE], ['is-tom', BACKSTORE]]);
    expect(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-rice/receipt`, BACKSTORE, { counted: [{ productId: RICE.productId, batchId: null, quantityMinor: ARRIVED.rice }] }, 'rc-self'))).toBe('issuer_cannot_receive');
    const countedRice = await ok(call('POST', `/v1/floor/indents/${INDENT}/issues/is-rice/receipt`, FLOOR, { counted: [{ productId: RICE.productId, batchId: null, quantityMinor: ARRIVED.rice }] }, 'rc-rice'), 'floor counts rice');
    await ok(call('POST', `/v1/floor/indents/${INDENT}/issues/is-tom/receipt`, FLOOR, { counted: [{ productId: TOMATO.productId, batchId: null, quantityMinor: ARRIVED.tomatoGrams }] }, 'rc-tom'), 'floor counts tomato');
    expect(countedRice['discrepancies']).toEqual([expect.objectContaining({ productId: RICE.productId, differenceMinor: ARRIVED.rice - INDENT_ASK.rice })]);
    const exceptions = await ok(call('GET', '/v1/inventory/exceptions', OWNER), 'exceptions') as { transferShortfalls: { transferId: string; differenceMinor: number; value: { minor: number } }[] };
    expect(exceptions.transferShortfalls).toEqual([expect.objectContaining({ transferId: `${INDENT}:is-rice`, differenceMinor: ARRIVED.rice - INDENT_ASK.rice })]);
    const shortValue = exceptions.transferShortfalls[0]!.value.minor;
    expect(shortValue).toBe(RICE.cost);
    // A manager who neither issued nor counted resolves it: the bag was not found — confirmed lost, reason-coded, kept.
    const resolvePath = `/v1/floor/indents/${INDENT}/issues/is-rice/shortfall/resolution`;
    const resolution = { lines: [{ productId: RICE.productId, batchId: null, foundMinor: 0 }], reasonCode: 'theft_suspected', note: 'one bag not found after a search of the route' };
    expect(codeOf(await call('POST', resolvePath, FLOOR, resolution, 'res-counter'))).toBe('counter_cannot_resolve');
    await ok(call('POST', resolvePath, MANAGER, resolution, 'res'), 'manager resolves the shortfall');
    rice = await picture(RICE.productId);
    tom = await picture(TOMATO.productId);
    expect(rice).toMatchObject({ back: DELIVERED.riceGood - INDENT_ASK.rice, floor: ARRIVED.rice, inTransit: 0 });
    expect(tom).toMatchObject({ back: DELIVERED.tomatoGrams - INDENT_ASK.tomatoGrams, floor: ARRIVED.tomatoGrams, inTransit: 0 });
    row('7 independent floor receipt; shortfall a visible exception', `issuer refused as counter; ${FLOOR} counted ${ARRIVED.rice} of ${INDENT_ASK.rice} rice + ${ARRIVED.tomatoGrams} g → shortfall ${INDENT_ASK.rice - ARRIVED.rice} on the owner's exceptions, valued ${shortValue} (expected ${RICE.cost}); counter refused as resolver; manager confirmed it lost · floor rice ${rice.floor}, tomato ${tom.floor} g · floor value ${rice.floorValue} + ${tom.floorValue}`);
    expect(rice.floorValue).toBe(ARRIVED.rice * RICE.cost);
    expect(tom.floorValue).toBe(perKg(ARRIVED.tomatoGrams, TOMATO.cost));

    // ═══ 8. Sales at the till: box first, scan, split tender, a loyalty member — the second bill with NO network ════════════
    const served = await servedCatalogue(edge);
    let till = bootPos({ laneId: LANE, catalogue: served, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    await signInTill(till, CASHIER);
    const T0 = Date.now();
    const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
    const tradingDay = tradingDateOf(at(0), makeTradingDayRule('00:00'));
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: FLOAT, at: at(0), movementId: 'cm-float' })).toMatchObject({ committed: true });
    // S-1 (online): the member buys 2 rice — UPI (recorded on the box BEFORE the terminal is asked) + cash.
    expect(till.setLoyaltyMobile(MOBILE)).toMatchObject({ ok: true, last4: '3579' });
    till.scanBarcode(RICE.barcode);
    till.scanBarcode(RICE.barcode);
    expect(till.payableMinor()).toBe(S1_TOTAL);
    const upi = await till.startCardPayment('upi', S1_UPI);
    expect(upi).toMatchObject({ ok: true });
    expect(await till.answerCardPayment(upi.attemptId!, 'approved')).toMatchObject({ ok: true });
    const r1 = await till.nextReceipt();
    expect(await till.tenderSplit({ saleId: 'S-1', receiptNumber: r1, atIsoUtc: at(5), parts: [{ kind: 'upi', amountMinor: S1_UPI, ref: upi.attemptId! }, { kind: 'cash', amountMinor: S1_CASH }] })).toBe(r1);
    till.newSale();
    expect((await edge.syncOnce!()).dead).toBe(0);
    expect(await pointsHeld()).toBe(S1_POINTS);
    expect(await edge.refreshLoyaltyWallets!()).toMatchObject({ status: 'updated' });

    // ── THE NETWORK IS CUT. S-2: the member's bill — rice + 1.5 kg tomatoes (weighed, in grams) — paid with ALL their points,
    //    a card and cash; committed on the box's disk, nothing sent.
    cableCut = true;
    till.setLoyaltyMobile(MOBILE);
    expect(await till.loyaltyWallet()).toMatchObject({ ok: true, points: S1_POINTS, pointsValueMinor: S1_POINTS * 100 });
    till.scanBarcode(RICE.barcode);
    const tomLine = till.scanBarcode(TOMATO.barcode);
    till.setQuantity(tomLine.lineId, S2_LINES.tomatoGrams);
    expect(till.payableMinor()).toBe(S2_TOTAL);
    const card = await till.startCardPayment('card', S2_CARD);
    expect(card).toMatchObject({ ok: true });
    expect(await till.answerCardPayment(card.attemptId!, 'approved')).toMatchObject({ ok: true });
    const r2 = await till.nextReceipt();
    expect(await till.tenderSplit({ saleId: 'S-2', receiptNumber: r2, atIsoUtc: at(20), parts: [{ kind: 'loyalty_points', amountMinor: S2_POINTS_SPENT * 100 }, { kind: 'card', amountMinor: S2_CARD, ref: card.attemptId! }, { kind: 'cash', amountMinor: S2_CASH }] })).toBe(r2);
    till.newSale();
    const onDisk = (await readLog(edge.log.path)).map((r) => JSON.parse((r as { record: string }).record) as Record<string, unknown>);
    expect(onDisk.find((x) => x['id'] === 'S-2')).toMatchObject({ cashierId: CASHIER, customerRef: MEMBER, total: S2_TOTAL });
    expect(JSON.stringify(onDisk)).not.toContain(MOBILE.replace(/\s/g, ''));
    const cut = await edge.syncOnce!();
    expect(cut.sent).toBe(0);
    expect(edge.outbox.unsentCount()).toBe(1);
    // S-3 (still cut): one rice, cash.
    till.scanBarcode(RICE.barcode);
    const r3 = await till.nextReceipt();
    expect(await till.tenderCash('S-3', r3, at(30))).toBe(r3);
    till.newSale();
    expect(edge.outbox.unsentCount()).toBe(2);
    row('8 sale at the till: box first, scan, split tender, member, NO network', `S-1 online: 2 rice ₹${S1_TOTAL / 100} = UPI ₹${S1_UPI / 100} (attempt on the box first) + cash ₹${S1_CASH / 100}, member earned ${S1_POINTS} pts · CABLE CUT · S-2: rice + ${S2_LINES.tomatoGrams} g tomato (scanned, weighed qty) ₹${S2_TOTAL / 100} = ${S2_POINTS_SPENT} pts + card ₹${S2_CARD / 100} + cash ₹${S2_CASH / 100}, member named by mobile (disk holds the code only) · S-3 cash · both committed on the box, 0 sent, 2 unsent`);

    // ── THE BOX RESTARTS mid-day with the cable still out: the sales, their queue and the setup survive.
    edge = await restartBox(edge);
    expect(edge.outbox.unsentCount()).toBe(2);
    expect(edge.storeSetup()).toMatchObject({ source: 'head-office' });
    till = bootPos({ laneId: LANE, catalogue: served, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    await signInTill(till, CASHIER);

    // ── RECONNECT, with a RECOVERY: head office books S-2 but the reply is lost on the way back; the retry settles it once.
    cableCut = false;
    loseNextSaleReply = true;
    const lost = await edge.syncOnce!();
    expect(loseNextSaleReply).toBe(false); // the drill fired
    expect(lost.dead).toBe(0);
    expect(edge.outbox.unsentCount()).toBeGreaterThan(0); // kept, not lost and not dead
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(edge.outbox.unsentCount()).toBe(0);
    for (const id of ['S-2', 'S-3']) expect((await call('GET', `/v1/sales/${id}`, OWNER)).body).toMatchObject({ saleId: id, banked: true });

    // ── A DUPLICATE REPLAY: the till re-sends S-2 to the box, and the box's record is relayed to head office again under a
    //    fresh key — neither books anything twice.
    const s2Record = (await readLog(edge.log.path)).map((r) => (r as { record: string }).record).find((x) => (JSON.parse(x) as { id: string }).id === 'S-2')!;
    const { customerRef: _code, operatorVerified: _stamp, ...asSent } = JSON.parse(s2Record) as Record<string, unknown>;
    void _code; void _stamp;
    const again = await (await realFetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sre-operator': till.operatorToken()! }, body: JSON.stringify({ ...asSent, customerMobile: MOBILE }) })).json() as { committed: boolean };
    expect(again.committed).toBe(true);
    expect((await readLog(edge.log.path)).length).toBe(3);
    const { toCloudSale } = await import('../../edge/store-edge/src/cloud-sale');
    const replay = await call('POST', '/v1/sales', BOX, toCloudSale(JSON.parse(s2Record) as unknown, 2, STORE, LANE), 'relay-S-2-again');
    expect((replay.body as { alreadyBanked?: boolean }).alreadyBanked, JSON.stringify(replay.body)).toBe(true);
    const pointsAfterSales = await pointsHeld();
    rice = await picture(RICE.productId);
    tom = await picture(TOMATO.productId);
    const soldRice = S1_LINES.rice + S2_LINES.rice + S3_LINES.rice;
    expect(rice.floor).toBe(ARRIVED.rice - soldRice);
    expect(tom.floor).toBe(ARRIVED.tomatoGrams - S2_LINES.tomatoGrams);
    row('11a hybrid: restart, reconnect, recovery, duplicate replay', `box restarted with the cable out: 2 unsent survived, setup from head office kept · reconnect: a lost reply kept S-2 queued (not dead), the retry booked it ONCE · till re-send of S-2 → box log still 3 · box record relayed again → alreadyBanked · floor rice ${rice.floor} (= ${ARRIVED.rice} − ${soldRice}), tomato ${tom.floor} g · points ${pointsAfterSales}`);

    // ═══ 9. Return of part of S-2: manager approves with their own PIN; stock back; points back (OB-34) ═════════════════════
    const bill = (await till.lookupRefund(r2))!;
    expect(bill.sale).toMatchObject({ saleId: 'S-2', totalMinor: S2_TOTAL });
    const pointsBack = Math.floor((S2_POINTS_SPENT * RICE.price) / S2_TOTAL);
    const moneyBack = RICE.price - Math.round((S2_POINTS_SPENT * 100 * RICE.price) / S2_TOTAL);
    const approval = await managerApprovesOn(till, MANAGER, { kind: 'refund', billRef: 'S-2', valueMinor: moneyBack, reason: 'bag torn' });
    expect(approval.by).toBe(MANAGER);
    const refunded = await bill.submit({
      returnId: 'RT-1', number: await till.nextReceipt(), reasonCode: 'damaged',
      lines: [{ productId: RICE.productId, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: moneyBack, refundTender: 'cash', approval,
    });
    expect(refunded, JSON.stringify(refunded)).toMatchObject({ kind: 'settled', refundMinor: moneyBack });
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    rice = await picture(RICE.productId);
    expect(rice.floor).toBe(ARRIVED.rice - soldRice + 1);
    const pointsAfterReturn = await pointsHeld();
    const s2Earned = Math.floor((S2_TOTAL - S2_POINTS_SPENT * 100) / 10_000);
    const takenBack = Math.floor((s2Earned * RICE.price) / S2_TOTAL);
    const expectedPoints = S1_POINTS - S2_POINTS_SPENT + s2Earned + pointsBack - takenBack;
    expect(pointsAfterReturn).toBe(expectedPoints);
    row('9 return part of the sale: manager PIN, stock back, points back (OB-34)', `1 rice of S-2 back against the bill, approved by ${MANAGER} with their own PIN · refund cash ₹${moneyBack / 100} (the money share; the points share comes back as ${pointsBack} pts) · earned ${s2Earned} on S-2, ${takenBack} taken back · member ${pointsAfterReturn} pts (= ${S1_POINTS} − ${S2_POINTS_SPENT} + ${s2Earned} + ${pointsBack} − ${takenBack}) · floor rice ${rice.floor}`);

    // ═══ 10. Shift reconciliation (BLIND count) and the day close on the box ════════════════════════════════════════════════
    const expectedDrawer = FLOAT + S1_CASH + S2_CASH + S3_TOTAL - moneyBack;
    const counted = expectedDrawer;
    const shift = await till.till.close({ shiftId: 'sh-1', closedAt: at(60), countedMinor: counted });
    expect(shift).toMatchObject({ closed: true, varianceMinor: 0 });
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    // The owner's TODAY, as the store computer serves it (the owner app boots on what the page injects), before the day closes.
    const ownerHtml = await (await realFetch(`http://127.0.0.1:${edge.screens!.port}/owner/`)).text();
    const ownerData = JSON.parse(/<script>window\.ownerData = ([\s\S]*?);<\/script>/.exec(ownerHtml)![1]!) as Parameters<typeof bootOwner>[0];
    const today12 = bootOwner(ownerData, forgetfulQueueStore())!.brief();
    const nextMorning = new Date(Date.parse(`${tradingDay}T00:00:00.000Z`) + 86_400_000 + 5 * 60_000);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(nextMorning);
    edge = await restartBox(edge);
    // The manager's screen asks the box to close the day (POST /lane/day-close — the served route the manager screen uses).
    // It is the closer's OWN act (P-04 · hard rule #4): a typed name, a cashier (even with her own PIN) and the manager's name
    // with the cashier's PIN are refused ON THE BOX, offline-capable, before anything is locked.
    const typed = await laneDayClose2(edge, { dayCloseId: `dc-${tradingDay}`, closedBy: MANAGER });
    const byCashier = await laneDayClose2(edge, { dayCloseId: `dc-${tradingDay}`, closedBy: CASHIER, closerPin: pinOf(CASHIER) });
    const borrowed = await laneDayClose2(edge, { dayCloseId: `dc-${tradingDay}`, closedBy: MANAGER, closerPin: pinOf(CASHIER) });
    for (const refused of [typed, byCashier, borrowed]) expect(refused, JSON.stringify(refused)).toMatchObject({ closed: false });
    expect(await readLog(edge.dayCloseLog.path)).toEqual([]);
    expect(edge.dayCloseOutbox.unsentCount()).toBe(0);
    const closedDay = await laneDayClose2(edge, { dayCloseId: `dc-${tradingDay}`, closedBy: MANAGER, closerPin: pinOf(MANAGER) });
    expect(closedDay, JSON.stringify(closedDay)).toMatchObject({ closed: true, tradingDay, locked: true });
    expect(JSON.stringify(await readLog(edge.dayCloseLog.path))).not.toContain(pinOf(MANAGER));
    expect(await edge.syncOnce!(), JSON.stringify(edge.dayCloseOutbox.deadLetters())).toMatchObject({ dead: 0, remaining: 0 });
    const dayCloses = ((await call('GET', '/v1/pos/day-close', OWNER)).body as { dayCloses: { dayCloseId: string; storeId: string; locked: boolean; closedBy: string; closeFlags: string[] }[] }).dayCloses;
    // Head office records ONE close, in the verified manager's name, for the STORE (not the tenant), with no closer flag.
    expect(dayCloses).toEqual([expect.objectContaining({ dayCloseId: `dc-${tradingDay}`, storeId: STORE, locked: true, closedBy: MANAGER, closeFlags: [] })]);
    row('10 payment + shift reconciliation, day close on the box', `blind count ₹${counted / 100} vs the box's expected (float ₹${FLOAT / 100} + cash ₹${(S1_CASH + S2_CASH + S3_TOTAL) / 100} − refund ₹${moneyBack / 100}) → variance ${(shift as { varianceMinor: number }).varianceMinor} · day close refused on the box for a typed name (${String(typed['reason']).slice(0, 60)}…), for the cashier with her own PIN and for the manager's name with the cashier's PIN — nothing locked · locked by ${MANAGER} with their OWN PIN → head office: closedBy ${MANAGER}, store ${STORE}, no closer flag`);

    // ═══ 10 (money side). The day book, the provider's settlement file for the card and UPI tenders, the bank statement ═════
    // The supplier's bill reaches the books through the accountant's mapping (M23-FR-01/02). A mapping whose bill rule has no
    // input-tax leg is REFUSED for this bill (the GST would be buried in purchases), nothing posted; with the input-tax legs
    // mapped the matched bill and its debit note post ONCE; a re-run posts nothing.
    const noTaxLegs = { rules: DEFAULT_RETAIL_POSTING_MAP.rules.map((r) => (r.kind === 'supplier_invoice'
      ? { kind: r.kind, legs: [{ account: 'purchases_grni', side: 'debit', component: 'payable' }, { account: 'supplier_payable', side: 'credit', component: 'payable' }] }
      : r.kind === 'supplier_debit_note'
        ? { kind: r.kind, legs: [{ account: 'supplier_payable', side: 'debit', component: 'amount' }, { account: 'purchases_grni', side: 'credit', component: 'amount' }] }
        : r)) };
    await ok(call('PUT', '/v1/finance/posting-map', FINANCE, noTaxLegs, 'map-no-tax'), 'a mapping with no input-tax legs');
    const refusedBill = await ok(call('POST', '/v1/finance/payables/post', FINANCE, undefined, 'payables-1'), 'payables (no input-tax legs)') as { journals: { kind: string }[]; exceptions: { kind: string; reason: string; sourceIds: string[] }[] };
    expect(refusedBill.journals).toEqual([]);
    expect(refusedBill.exceptions.map((e) => [e.kind, e.reason]).sort()).toEqual([['supplier_debit_note', 'tax_not_mapped'], ['supplier_invoice', 'tax_not_mapped']]);
    await ok(call('PUT', '/v1/finance/posting-map', FINANCE, DEFAULT_RETAIL_POSTING_MAP, 'map'), 'posting map');
    const billPosted = await ok(call('POST', '/v1/finance/payables/post', FINANCE, undefined, 'payables-2'), 'payables') as { journals: { kind: string; sourceId: string; documentDate: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(billPosted.exceptions).toEqual([]);
    const lineOfBill = (kind: string, code: string): number => {
      const j = billPosted.journals.find((x) => x.kind === kind)!;
      return j.lines.filter((l) => l.accountCode === code).reduce((t, l) => t + l.debitMinor - l.creditMinor, 0);
    };
    expect(billPosted.journals.map((j) => [j.kind, j.sourceId]).sort()).toEqual([['supplier_debit_note', `DN-${grnId}-${damagedLine.lineId}`], ['supplier_invoice', 'inv-acc-1']]);
    expect([lineOfBill('supplier_invoice', 'purchases_grni'), lineOfBill('supplier_invoice', 'gst_input_cgst'), lineOfBill('supplier_invoice', 'gst_input_sgst'), lineOfBill('supplier_invoice', 'supplier_payable')])
      .toEqual([riceBill + tomatoBill, billTax / 2, billTax / 2, -billGross]);
    expect([lineOfBill('supplier_debit_note', 'supplier_payable'), lineOfBill('supplier_debit_note', 'purchases_grni'), lineOfBill('supplier_debit_note', 'gst_input_cgst'), lineOfBill('supplier_debit_note', 'gst_input_sgst')])
      .toEqual([dnGross, -dnTaxable, -dnTaxHalf, -dnTaxHalf]);
    expect(((await ok(call('POST', '/v1/finance/payables/post', FINANCE, undefined, 'payables-3'), 'payables re-run')) as { journals: unknown[] }).journals).toEqual([]);
    const payables = (await call('GET', '/v1/finance/payables', FINANCE)).body as { reconciliation: { agrees: boolean; ledgerOwedMinor: number } };
    expect(payables.reconciliation).toMatchObject({ agrees: true, ledgerOwedMinor: owedExpected });
    const posted = await ok(call('POST', `/v1/finance/day-book/${tradingDay}/post`, FINANCE, undefined, `post-${tradingDay}`), 'day book') as { journals: { kind: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(posted.exceptions).toEqual([]);
    for (const j of posted.journals) expect(j.lines.reduce((n, l) => n + l.debitMinor - l.creditMinor, 0), j.kind).toBe(0);
    const books = (await call('GET', `/v1/finance/day-book/${tradingDay}`, FINANCE)).body as { accounts: { accountCode: string; balanceMinor: number }[]; open: number };
    expect(books.open).toBe(0);
    const balanceOf = (code: string): number => books.accounts.find((a) => a.accountCode === code)?.balanceMinor ?? 0;
    const month = tradingDay.slice(0, 7);
    const electronic = S1_UPI + S2_CARD;
    const fees = 300;
    await ok(call('POST', '/v1/settlement/batches', FINANCE, {
      batchId: `PB-${tradingDay}`, providerId: 'test-acquirer', currency: 'INR', settlementDate: tradingDay, sourceName: 'acquirer-fixture.json',
      lines: [{ id: 'l1', ref: upi.attemptId!, amountMinor: S1_UPI }, { id: 'l2', ref: card.attemptId!, amountMinor: S2_CARD }],
      declaredGrossMinor: electronic, declaredFeesMinor: fees, declaredNetMinor: electronic - fees,
    }, 'pb'), 'settlement file');
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    await ok(call('POST', '/v1/finance/bank-statements', FINANCE, {
      statementId: `BANK-${month}`, accountRef: 'current-account-1', fromDate: `${month}-01`, toDate: lastDay, openingMinor: 1_000_000, closingMinor: 1_000_000 + electronic - fees,
      sourceName: 'bank-fixture.csv', csv: `Date,Reference,Narrative,Debit,Credit\n${tradingDay},UTR-1 PB-${tradingDay},ACQUIRER PAYOUT,,${((electronic - fees) / 100).toFixed(2)}`,
    }, 'bank'), 'bank statement');
    const evidence = (await call('GET', `/v1/finance/periods/${month}/independent-evidence`, FINANCE)).body as { agrees: boolean; checks: { name: string; leftMinor: number; rightMinor: number }[] };
    const liability = (await call('GET', '/v1/finance/loyalty-liability', FINANCE)).body as { reconciles: boolean; points: { outstandingPoints: number; heldValueMinor: number; postedMinor: number } };
    expect(evidence.agrees).toBe(true);
    expect(evidence.checks.map((c) => [c.leftMinor, c.rightMinor])).toEqual([[electronic, electronic], [electronic - fees, electronic - fees]]);
    expect(liability).toMatchObject({ reconciles: true, points: { outstandingPoints: expectedPoints, heldValueMinor: expectedPoints * 100, postedMinor: expectedPoints * 100 } });
    expect(balanceOf('cash_in_hand')).toBe(S1_CASH + S2_CASH + S3_TOTAL - moneyBack);
    expect(balanceOf('card_receivable')).toBe(S2_CARD);
    expect(balanceOf('upi_receivable')).toBe(S1_UPI);
    expect(balanceOf('sales_clearing')).toBe(0);
    expect(balanceOf('loyalty_points_liability')).toBe(-expectedPoints * 100);
    row('10b card/UPI settlement, day book, liabilities', `day book posted by ${FINANCE}, every journal balanced, 0 exceptions · cash in hand ${balanceOf('cash_in_hand')} · card ${balanceOf('card_receivable')} · UPI ${balanceOf('upi_receivable')} · sales clearing 0 · settlement file (card+UPI ${electronic}) = tenders, payout ${electronic - fees} = bank credit · points liability ${expectedPoints * 100} = ${expectedPoints} pts held`);

    // ═══ 11. Sync to head office: every sale, return, cash movement, shift and day close booked ONCE ═══════════════════════
    const sales = ((await call('GET', `/v1/reports/sales_by_day?day=${tradingDay}`, OWNER)).body as { rows: { saleId: string; totalMinor: string }[] }).rows;
    expect(sales.map((r) => [r.saleId, Number(r.totalMinor)])).toEqual([['S-1', S1_TOTAL], ['S-2', S2_TOTAL], ['S-3', S3_TOTAL]]);
    const tillCash = (await call('GET', `/v1/tills/${LANE}/cash`, OWNER)).body as { balanceMinor: number; flagged: unknown[] };
    const overShort = ((await call('GET', '/v1/shifts/over-short', OWNER)).body as { overShort: unknown[] }).overShort;
    expect(tillCash).toMatchObject({ balanceMinor: FLOAT, flagged: [] });
    expect(overShort).toEqual([]);
    for (const q of [edge.outbox, edge.returnsOutbox, edge.tillCashOutbox, edge.dayCloseOutbox, edge.deviceEventsOutbox]) {
      expect(q.unsentCount()).toBe(0);
      expect(q.deadLetters()).toEqual([]);
    }
    // The box tells head office what it holds — its catalogue, its setup and how much it has unsent (its sync loop does
    // this every pass; called here once, as the loop would).
    expect(await edge.reportHeldVersions!()).toBe(true);
    row('11 sync to head office: booked once', `head office holds exactly S-1/S-2/S-3 (${sales.map((r) => r.totalMinor).join(' + ')}), the return, the float, the shift (no over/short) and the locked day — after a cut, a restart, a lost reply and a duplicate replay; every box queue empty, no dead letters`);

    // ═══ 12. Owner reporting: the owner's reports equal the journey's own numbers, with freshness shown ═════════════════════
    type Report = { figures: { name: string; valueMinor: number; staleness: string }[]; rows: Record<string, string>[]; worstStaleness: string; sources: unknown[] };
    const report = async (name: string): Promise<Report> => (await call('GET', `/v1/reports/${name}?day=${tradingDay}`, OWNER)).body as Report;
    const fig = (r: Report, name: string): number | undefined => r.figures.find((f) => f.name === name)?.valueMinor;
    const byDay = await report('sales_by_day');
    const mix = await report('tender_mix');
    const stock = await report('stock_on_hand');
    const loyalty = await report('loyalty');
    const grossSales = S1_TOTAL + S2_TOTAL + S3_TOTAL;
    expect(fig(byDay, 'Taken')).toBe(grossSales);
    expect(fig(byDay, 'Bills')).toBe(3);
    expect(fig(mix, 'cash')).toBe(S1_CASH + S2_CASH + S3_TOTAL);
    expect(fig(mix, 'card')).toBe(S2_CARD);
    expect(fig(mix, 'upi')).toBe(S1_UPI);
    expect(fig(mix, 'loyalty_points')).toBe(S2_POINTS_SPENT * 100);
    const stockRows = Object.fromEntries(stock.rows.map((r) => [`${r['productId']}@${r['locationId']}`, [Number(r['onHandMinor']), Number(r['valueMinor'])]]));
    const riceFloor = ARRIVED.rice - soldRice + 1;
    const riceBack = DELIVERED.riceGood - INDENT_ASK.rice;
    const tomFloor = ARRIVED.tomatoGrams - S2_LINES.tomatoGrams;
    const tomBack = DELIVERED.tomatoGrams - INDENT_ASK.tomatoGrams;
    expect(stockRows).toEqual({
      [`${RICE.productId}@${STORE}`]: [riceFloor, riceFloor * RICE.cost], [`${RICE.productId}@${BACK}`]: [riceBack, riceBack * RICE.cost],
      [`${TOMATO.productId}@${STORE}`]: [tomFloor, perKg(tomFloor, TOMATO.cost)], [`${TOMATO.productId}@${BACK}`]: [tomBack, perKg(tomBack, TOMATO.cost)],
    });
    expect(fig(stock, 'Value on hand')).toBe((riceFloor + riceBack) * RICE.cost + perKg(tomFloor + tomBack, TOMATO.cost));
    expect(fig(loyalty, 'Points outstanding')).toBe(expectedPoints);
    // Conservation, every unit accounted for: received good − lost on the trolley − sold + returned = on hand.
    expect(riceFloor + riceBack).toBe(DELIVERED.riceGood - (INDENT_ASK.rice - ARRIVED.rice) - soldRice + 1);
    expect(tomFloor + tomBack).toBe(DELIVERED.tomatoGrams - S2_LINES.tomatoGrams);
    // Freshness is SHOWN on every report (P-08): each carries its staleness and its sources.
    for (const r of [byDay, mix, stock, loyalty]) { expect(['fresh', 'lagging', 'stale']).toContain(r.worstStaleness); expect(r.sources.length).toBeGreaterThan(0); }
    // The variances the journey made are on the owner's exception reads.
    const ownerExceptions = await ok(call('GET', '/v1/inventory/exceptions', OWNER), 'owner exceptions') as { transferShortfalls: { transferId: string; value: { minor: number }; resolution?: { resolvedBy: string } | null }[] };
    expect(ownerExceptions.transferShortfalls).toEqual([expect.objectContaining({ transferId: `${INDENT}:is-rice`, value: { minor: RICE.cost, currency: 'INR' }, resolution: expect.objectContaining({ resolvedBy: MANAGER }) })]);
    // The owner's TODAY on the store computer (captured before the day closed): the day's sales and tenders, with freshness.
    // OB-39 "B": head office's store setup carries each product's AVERAGE BUYING COST at this store (from the receipts at
    // cost: rice 20 bags at ₹400, tomato 9.5 kg at ₹25/kg) — so the box costs every bill and the owner's Today shows the margin.
    const boxSales = (ownerData as unknown as { branches: { sales: { saleId: string; netMinor: number; cogsMinor: number }[] }[]; uncostable: { sales: number; products: string[] } });
    const cogsExpected = { 'S-1': S1_LINES.rice * RICE.cost, 'S-2': S2_LINES.rice * RICE.cost + perKg(S2_LINES.tomatoGrams, TOMATO.cost), 'S-3': S3_LINES.rice * RICE.cost };
    expect(Object.fromEntries(boxSales.branches[0]!.sales.map((x) => [x.saleId, x.cogsMinor]))).toEqual(cogsExpected);
    expect(boxSales.uncostable).toMatchObject({ sales: 0, products: [] });
    const boxCogs = cogsExpected['S-1'] + cogsExpected['S-2'] + cogsExpected['S-3'];
    const boxNet = boxSales.branches[0]!.sales.reduce((t, x) => t + x.netMinor, 0);
    expect(today12.takings).toEqual({ bills: 3, takenMinor: S1_TOTAL + S2_TOTAL + S3_TOTAL, marginUnknownBills: 0, tenderMix: { cash: S1_CASH + S2_CASH + S3_TOTAL, card: S2_CARD, upi: S1_UPI, loyalty_points: S2_POINTS_SPENT * 100 } });
    expect(today12.kpis).toMatchObject({ grossSalesMinor: S1_TOTAL + S2_TOTAL + S3_TOTAL, cogsMinor: boxCogs, marginMinor: boxNet - boxCogs });
    const rupees = (minor: number): string => (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(today12.headline).toContain(`3 bills today, ₹1,980.00 taken, margin ₹${rupees(boxNet - boxCogs)}`);
    expect(today12.headline).not.toMatch(/margin not known|No sales recorded/);
    expect(today12.freshness).toBeDefined();
    row('12b owner Today (box) shows the takings and the margin', `owner app booted on the box's /owner/ page: "${today12.headline}" · takings ${today12.takings.takenMinor} on ${today12.takings.bills} bills, tenders ${JSON.stringify(today12.takings.tenderMix)} · costed at head office's average buying cost (OB-39 B) from the store setup: cost of goods ${boxCogs} (S-1 ${cogsExpected['S-1']}, S-2 ${cogsExpected['S-2']}, S-3 ${cogsExpected['S-3']}) · margin ${boxNet - boxCogs} on net ${boxNet} · margin unknown on ${today12.takings.marginUnknownBills} bills · freshness shown`);
    // RETURNS beside the takings — "Taken" keeps its meaning; what came back and the net are shown with it, valued as the
    // books value them (the ₹472 cash refund + the ₹8 of points given back = the ₹480 rice returned).
    expect(fig(byDay, 'Returned')).toBe(RICE.price);
    expect(fig(byDay, 'Returns')).toBe(1);
    expect(fig(byDay, 'Taken net of returns')).toBe(grossSales - RICE.price);
    expect(fig(mix, 'refunded — cash')).toBe(moneyBack);
    expect(fig(mix, 'refunded — loyalty_points')).toBe(RICE.price - moneyBack);
    // The five reports that were "not recorded": now produced from the real sources.
    const gst = await report('gst');
    const bank = await report('reconciliation');
    const profit = await report('profitability');
    const sync = await report('sync_health');
    const fresh = await report('data_freshness');
    const gstPosted = -(balanceOf('gst_output_cgst') + balanceOf('gst_output_sgst'));
    expect(fig(gst, 'GST collected')).toBe(gstPosted);
    expect(fig(gst, 'GST collected — CGST')).toBe(-balanceOf('gst_output_cgst'));
    // GST PAID ON PURCHASES, from the books: the matched bill's input tax less what its debit note reversed — and the net.
    const inputGst = billTax - 2 * dnTaxHalf;
    expect(billPosted.journals.every((j) => j.documentDate === tradingDay)).toBe(true);
    expect(fig(gst, 'GST paid on purchases')).toBe(inputGst);
    expect(fig(gst, 'GST paid on purchases — CGST')).toBe(billTax / 2 - dnTaxHalf);
    expect(fig(gst, 'GST paid on purchases — SGST')).toBe(billTax / 2 - dnTaxHalf);
    expect(fig(gst, 'Net GST (collected less paid on purchases)')).toBe(gstPosted - inputGst);
    expect(bank.figures.filter((f) => / — difference$/.test(f.name)).map((f) => f.valueMinor)).toEqual([0, 0]);
    expect(fig(bank, 'Card and UPI takings for ' + month + ' — ours')).toBe(electronic);
    expect(fig(bank, 'Provider payouts received in ' + month + ' — theirs')).toBe(electronic - fees);
    expect(fig(profit, 'Revenue net of GST and returns')).toBe(-balanceOf('sales_revenue'));
    // Head office's profitability with the SAME average buying cost: what was sold less what came back (1 rice), at cost.
    const hoCogs = boxCogs - RICE.cost;
    expect(fig(profit, 'Cost of goods sold')).toBe(hoCogs);
    expect(fig(profit, 'Profit')).toBe(-balanceOf('sales_revenue') - hoCogs);
    expect(profit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: RICE.productId, storeId: STORE, averageBuyingCostMinor: String(RICE.cost) }),
      expect.objectContaining({ productId: TOMATO.productId, storeId: STORE, averageBuyingCostMinor: String(TOMATO.cost) }),
    ]));
    expect(fig(sync, 'Records not yet sent')).toBe(0);
    expect(sync.rows).toEqual([expect.objectContaining({ storeId: STORE, unsent: '0' })]);
    expect(fresh.rows.map((r) => r['source'])).toEqual(expect.arrayContaining([`store:${STORE}`, 'stock ledger', `store:${STORE} report`]));
    // Freshness is TRUTHFUL the morning after: the figure is old because nothing newer happened (the box said it holds
    // nothing unsent), not "wait for the sync".
    const takenDetail = byDay.figures.find((f) => f.name === 'Taken') as unknown as { detail: string };
    expect(takenDetail.detail).toMatch(/nothing newer happened: the store computer said at .* it had nothing waiting to send/);
    expect(takenDetail.detail).not.toMatch(/until the sync recovers/);
    row('12 owner reporting equals the journey, freshness shown', `HO reports for ${tradingDay}: taken ${fig(byDay, 'Taken')} on ${fig(byDay, 'Bills')} bills = S-1+S-2+S-3 · returned ${fig(byDay, 'Returned')} on ${fig(byDay, 'Returns')} return · net ${fig(byDay, 'Taken net of returns')} · tenders in: cash ${fig(mix, 'cash')} / card ${fig(mix, 'card')} / UPI ${fig(mix, 'upi')} / points ${fig(mix, 'loyalty_points')}; refunded: cash ${fig(mix, 'refunded — cash')} / points ${fig(mix, 'refunded — loyalty_points')} · stock per place rice ${riceFloor} floor + ${riceBack} back, tomato ${tomFloor} g + ${tomBack} g, value ${fig(stock, 'Value on hand')} · points ${fig(loyalty, 'Points outstanding')} · trolley shortfall valued ${RICE.cost} on exceptions · GST collected ${fig(gst, 'GST collected')} (= the books), paid on purchases ${fig(gst, 'GST paid on purchases')} (bill ${billTax} less debit note ${2 * dnTaxHalf}, posted once; a mapping with no input-tax leg refused), net ${fig(gst, 'Net GST (collected less paid on purchases)')} · bank: card+UPI ${electronic} = settled, payout ${electronic - fees} = bank, differences 0 · profitability at the average buying cost (OB-39 B): revenue ${fig(profit, 'Revenue net of GST and returns')} − cost of goods ${fig(profit, 'Cost of goods sold')} (sold ${boxCogs} less 1 rice back ${RICE.cost}) = profit ${fig(profit, 'Profit')} · not yet sent ${fig(sync, 'Records not yet sent')} (the box's own report) · freshness on every figure, truthful: "${takenDetail.detail.replace(/^Taken: \d+ as at /, '').slice(0, 90)}…"`);

  }, 300_000);

  // ── OB-39 "B" (owner, 11 Oct 2026): the store computer's Today and head office's profitability both cost at head office's
  //    average buying cost per product and store (12b, 12). A product with no cost still reads "margin not known" — proved in
  //    `the-margin-is-costed-at-the-average-buying-cost.test.ts`.
});
