import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY } from '../support/api-harness';
import { startRealCloud, type RealCloud } from '../support/real-store';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { enrolmentCodeHash } from '../../packages/platform-admin/src/device-enrolment';
import { withTillPeople, issueTillPins, signInTill, pinOf, signInOnPhone, type TillPerson } from '../support/till-operator';
import type { QueueTillSession, QueueWindow } from '../../apps/queue-pos/src/browser-entry';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

/**
 * **D04-FR-05 mobile POS and queue-busting (OB-288 Pkg 6b) — a staff handheld scans in the queue, takes a card payment where
 * the shop switched it on, and otherwise hands the basket to a till by a code; all of it through the REAL store computer
 * with head office unreachable, and head office books the handheld's sale exactly as a till's.** In memory (head office
 * behind a fetch shim) and, with DATABASE_URL, on real PostgreSQL through the production API over HTTP:
 *
 *   • SWITCHED OFF (OB-316 — nobody set the switch): the handheld page says so; a hand-over and the till's recall are
 *     refused in words; nothing is kept;
 *   • QUEUE-BUSTING ON for lane-1 (payments not switched on): a person signs in on the enrolled handheld with their own
 *     till PIN FOR SELLING (a warehouse sign-in on the same phone opens nothing); the till's own session prices the basket
 *     from the signed pack; the basket is handed over — on the box's disk — under a four-digit code; the fixed till keys
 *     the code and rings every line through ITS pack; a second recall is refused naming the till; a card attempt from the
 *     handheld is refused (payments off); a basket nobody came for is given up with a reason and is never deleted;
 *   • a COLD RESTART with payments.mobile_pos switched on too: the queue baskets come back as they were (the recalled one
 *     is still recalled); the handheld takes a CARD payment — the attempt recorded on the box before the machine is asked,
 *     the box's receipt number, the seal on who rang it — and the SAME sale record joins the queue for head office; cash,
 *     a refund and a cash movement from the handheld are refused before anything is written;
 *   • THE LINE COMES BACK: head office takes the stock off for both bills, files the handheld's sale under its lane and its
 *     person with the store computer's seal verified, and the books post both sales; a resend books nothing twice.
 */

const OWNER = 'u-owner';
const STORE = 'S1';
const LANE = 'lane-1';
const CASHIER = 'u-asha';
const RUNNER = 'u-ravi';
const PICKER = 'u-kumar';
const ACCOUNTANT = 'u-acct';
const DEVICE = 'hh-q1';
const ENROL = 'QUEUE-TILL1-ENROL-CODE1';
const AT = new Date(Date.now() - 60_000).toISOString();
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: STORE };
const GROCERY = { categoryId: 'grocery', name: 'Grocery', parentId: null };
const ean = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const CODE = { dal: ean('890100000011'), oil: ean('890100000012') };
const PEOPLE: readonly TillPerson[] = [
  { userId: CASHIER, displayName: 'Asha' },
  { userId: RUNNER, displayName: 'Ravi' },
  { userId: PICKER, displayName: 'Kumar', permissions: ['inventory.movement.append'] },
];
type Switches = 'none' | 'queue' | 'queue_and_payments';
const rolloutOf = (s: Switches): unknown => ({
  format: 'sre-rollout/1', branchId: STORE,
  switches: [
    ...(s === 'none' ? [] : [{ key: 'pos.queue_busting', branch: null, lanes: [{ laneId: LANE, enabled: true, version: 1 }] }]),
    ...(s === 'queue_and_payments' ? [{ key: 'payments.mobile_pos', branch: { enabled: true, version: 1 }, lanes: [] }] : []),
  ],
});
const storePack = (s: Switches): string => JSON.stringify(withTillPeople({
  version: 1,
  policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', ...SETTINGS },
  lossPreventionRules: [],
  devices: [{ deviceId: DEVICE, kind: 'handheld', status: 'registered', label: 'Queue till 1', enrolment: { codeHash: enrolmentCodeHash(ENROL), expiresAt: '2099-01-01T00:00:00.000Z' } }],
  rollout: rolloutOf(s),
}, PEOPLE));

interface Reply { readonly status: number; readonly body: unknown }
interface Cloud {
  readonly tenant: string;
  readonly url: string;
  request(r: { method: 'GET' | 'POST' | 'PUT'; path: string; userId: string; body?: unknown; idempotencyKey?: string }): Promise<Reply>;
  grant(user: string, role: string, scope?: readonly string[] | 'all'): Promise<void>;
  fetchFor(saved: typeof globalThis.fetch, isCut: () => boolean): typeof globalThis.fetch;
}
const branchOf = (user: string): string | undefined => (user === 'u-box' || user === CASHIER || user === RUNNER ? STORE : undefined);

async function setUp(cloud: Cloud): Promise<void> {
  const ok = async (method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, what: string): Promise<Reply> => {
    const r = await cloud.request({ method, path, userId: OWNER, body, idempotencyKey: `k-${what}` });
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r;
  };
  await ok('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }, 'org-c1');
  await ok('POST', '/v1/org/gst-registrations/33AAACS1111A2ZG', { companyId: 'C1', legalName: 'Synthetic SRE TN' }, 'gst-tn');
  await ok('POST', `/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'C1', companyId: 'C1', gstin: '33AAACS1111A2ZG' }, 'org-s1');
  await ok('POST', `/v1/stores/${STORE}/settings`, SETTINGS, 'settings');
  await cloud.grant('u-box', 'store_computer', [STORE]);
  await cloud.grant(CASHIER, 'cashier', [STORE]);
  await cloud.grant(RUNNER, 'cashier', [STORE]);
  await cloud.grant(ACCOUNTANT, 'accountant');
  await ok('POST', '/v1/catalogue/tax-classes/0713/rates/2017-07-01', { rateBps: 500 }, 'tax-0713');
  await ok('POST', '/v1/catalogue/tax-classes/1507/rates/2017-07-01', { rateBps: 500 }, 'tax-1507');
  const product = async (id: string, name: string, taxClass: string, priceMinor: number, code: string) => {
    await ok('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom: 'each', primaryCategoryId: 'grocery', taxClass, lifecycle: 'active', handling: 'ambient' }, categories: [GROCERY] }, `publish-${id}`);
    await ok('POST', `/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor, mrpMinor: priceMinor, costMinor: Math.floor(priceMinor / 2), marginFloorBps: 0, currency: 'INR', effectiveFrom: AT.slice(0, 10) }, `price-${id}`);
    await ok('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' }, `barcode-${id}`);
  };
  await product('p-dal', 'Toor dal 1kg', '0713', 12_000, CODE.dal);
  await product('p-oil', 'Groundnut oil 1L', '1507', 20_000, CODE.oil);
  for (const [productId, qty] of [['p-dal', 20], ['p-oil', 10]] as const) {
    await ok('POST', '/v1/inventory/movements', { movementId: `r-${productId}`, productId, locationId: STORE, kind: 'received', quantityMinor: qty, uom: 'each', occurredAt: AT, enteredBy: OWNER, unitCostMinor: 1_000 }, `rx-${productId}`);
  }
  await ok('POST', '/v1/catalogue/pack', { storeId: STORE, asOf: AT }, 'pack');
  const map = await cloud.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: ACCOUNTANT, body: DEFAULT_RETAIL_POSTING_MAP, idempotencyKey: 'k-map' });
  expect(map.status, JSON.stringify(map.body)).toBeLessThan(300);
}

const globalsOf = (html: string, name: string): unknown => {
  const m = new RegExp(`<script>window\\.${name} = ([\\s\\S]*?);</script>`).exec(html);
  return m === null ? undefined : JSON.parse(m[1]!) as unknown;
};

async function queueBustOfflineAndSync(cloud: Cloud): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sre-queue-till-'));
  const packFile = join(dir, 'store-pack.json');
  const saved = globalThis.fetch;
  let cut = false;
  const cloudFetch = cloud.fetchFor(saved, () => cut);
  // The handheld's own calls carry its cookies, as a browser on the shop wifi does (same origin, HttpOnly).
  let phone: { base: string; cookie: string } | undefined;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    if (phone !== undefined && String(url).startsWith(phone.base)) {
      return saved(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie: phone.cookie } });
    }
    return cloudFetch(url as string, init);
  }) as unknown as typeof globalThis.fetch;
  const edges: EdgeProcess[] = [];
  const boot = async (s: Switches): Promise<EdgeProcess> => {
    await writeFile(packFile, storePack(s), 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: cloud.tenant, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE,
      EDGE_DEVICE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.url, CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: cloud.tenant, branchId: STORE }),
    }, () => {}))!;
    edges.push(edge);
    return edge;
  };
  const stopAll = async (): Promise<void> => { for (const e of edges.splice(0)) await e.stop(); };
  const dev = (edge: EdgeProcess): string => `http://127.0.0.1:${edge.devices!.port}`;
  const onDisk = async (e: EdgeProcess) => (await readLog(e.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
  const queueLog = async () => (await readLog(join(dir, 'queue-baskets.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { code: string; state: string; recalledOnLane?: string; giveUpReason?: string }] : []));
  // A fresh copy of the till's module for the handheld: one page holds one till, as in the shop.
  const handheld = async (edge: EdgeProcess, cookie: string): Promise<QueueTillSession> => {
    phone = { base: dev(edge), cookie };
    const page = await (await saved(`${dev(edge)}/queue-pos/`, { headers: { accept: 'text/html', cookie } })).text();
    vi.resetModules();
    const { bootQueuePos } = await import('../../apps/queue-pos/src/browser-entry');
    const w: QueueWindow = { posLane: globalsOf(page, 'posLane') as QueueWindow['posLane'], posCatalogue: globalsOf(page, 'posCatalogue') as CatalogueSnapshot, queuePos: globalsOf(page, 'queuePos') as QueueWindow['queuePos'] };
    const q = bootQueuePos(w, { base: `${dev(edge)}/queue-pos` });
    expect(await q.ready).toBe(true);
    return q;
  };
  const tillRecall = async (edge: EdgeProcess, code: string) => {
    const till = bootPos({ laneId: LANE, catalogue: (await edge.refreshPack!(), globalsOf(await (await saved(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text(), 'posCatalogue') as CatalogueSnapshot), lanePort: edge.lane!.port });
    await signInTill(till, CASHIER);
    return { till, out: await till.recallQueueBasketAtTill(code) };
  };

  try {
    await issueTillPins(dir, TEST_PACK_KEY, [CASHIER, RUNNER, PICKER]);

    // ── 1. NOBODY SET THE SWITCH: off, and said ────────────────────────────────────────────────────────────────────
    let edge = await boot('none');
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated' });
    cut = true;
    const enrolled = await saved(`${dev(edge)}/device/enrol`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: DEVICE, code: ENROL, next: '/queue-pos/' }) });
    expect(enrolled.status).toBe(200);
    expect(await enrolled.json()).toMatchObject({ enrolled: true, next: '/queue-pos/' });
    const deviceCookie = enrolled.headers.get('set-cookie')!.split(';')[0]!;
    const offPage = await saved(`${dev(edge)}/queue-pos/`, { headers: { accept: 'text/html', cookie: deviceCookie } });
    expect(offPage.status).toBe(403);
    expect(await offPage.text()).toMatch(/Queue-busting is switched off[\s\S]*அணைக்கப்பட்டுள்ளது/);
    const offHandOver = await saved(`${dev(edge)}/queue-pos/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: '{}' });
    expect(offHandOver.status).toBe(403);
    expect(await offHandOver.json()).toMatchObject({ refusedBecause: 'queue_busting_off' });
    expect((await tillRecall(edge, '1234')).out).toMatchObject({ ok: false, refusedBecause: 'queue_busting_off' });
    // No device credential at all: sent to enrol, never served.
    expect((await saved(`${dev(edge)}/queue-pos/`, { headers: { accept: 'text/html' }, redirect: 'manual' })).headers.get('location')).toMatch(/^\/device\/enrol\?why=no_credential&next=%2Fqueue-pos%2F/);
    await stopAll();

    // ── 2. QUEUE-BUSTING ON for lane-1 (no payments): sign in for selling, scan, hand over; the till rings it ─────────
    edge = await boot('queue');
    // A warehouse sign-in on the same phone opens nothing here.
    const pickerCookie = await signInOnPhone(dev(edge), deviceCookie, PICKER, 'warehouse');
    const notSelling = await saved(`${dev(edge)}/queue-pos/`, { headers: { accept: 'text/html', cookie: pickerCookie }, redirect: 'manual' });
    expect([notSelling.status, notSelling.headers.get('location')]).toEqual([303, '/queue-pos/sign-in']);
    expect((await saved(`${dev(edge)}/queue-pos/lane/sales`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: pickerCookie }, body: '{}' })).status).toBe(401);
    // A wrong PIN signs nobody in; the right one, for SELLING.
    const wrong = await saved(`${dev(edge)}/queue-pos/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: JSON.stringify({ staffId: RUNNER, pin: '000000' }) });
    expect(wrong.status).toBe(401);
    const signedIn = await saved(`${dev(edge)}/queue-pos/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', cookie: deviceCookie }, body: JSON.stringify({ staffId: RUNNER, pin: pinOf(RUNNER) }) });
    expect(await signedIn.json()).toMatchObject({ signedIn: true, userId: RUNNER });
    const runnerCookie = `${deviceCookie}; ${signedIn.headers.get('set-cookie')!.split(';')[0]!}`;
    let q = await handheld(edge, runnerCookie);
    expect(q.paymentsHere()).toBe(false);
    q.scan(CODE.dal);
    q.scan(CODE.dal);
    q.scan(CODE.oil);
    expect(q.till.payableMinor()).toBe(44_000);
    const handed = await q.handOver();
    expect(handed).toMatchObject({ ok: true, lineCount: 3 });
    if (!handed.ok) throw new Error(handed.laneMessage);
    expect(handed.code).toMatch(/^\d{4}$/);
    expect(q.till.basket()).toEqual([]);
    expect((await queueLog()).map((b) => [b.code, b.state])).toEqual([[handed.code, 'waiting']]);
    // Payments are not switched on: a card attempt from the handheld is refused before anything is written.
    q.scan(CODE.oil);
    expect(await q.till.startCardPayment('card')).toMatchObject({ ok: false, refusedBecause: 'mobile_pos_payment_off' });
    // The fixed till keys the code — offline — and rings the lines through ITS pack.
    const first = await tillRecall(edge, handed.code);
    expect(first.out).toMatchObject({ ok: true, notAdded: [] });
    expect(first.out.laneMessage).toBe(`Handheld basket ${handed.code}: 3 line(s) rung at the till's prices. Check the bag, then take the payment.`);
    expect(first.till.payableMinor()).toBe(44_000);
    await first.till.tenderCash(`S-till-${handed.code}`, await first.till.nextReceipt(), new Date().toISOString());
    expect((await tillRecall(edge, handed.code)).out).toMatchObject({ ok: false, refusedBecause: 'already_recalled' });
    expect((await tillRecall(edge, handed.code)).out.laneMessage).toMatch(/brought up on lane-1/);
    // A basket nobody came for: given up with a reason, kept on the record.
    q.newCustomer();
    q.scan(CODE.dal);
    const left = await q.handOver();
    if (!left.ok) throw new Error(left.laneMessage);
    expect((await q.waiting()).baskets.map((b) => b.code)).toEqual([left.code]);
    expect(await q.giveUp(left.code, '')).toMatchObject({ ok: false });
    expect(await q.giveUp(left.code, 'Customer left the queue')).toMatchObject({ ok: true });
    expect((await tillRecall(edge, left.code)).out).toMatchObject({ ok: false });
    expect((await q.waiting()).baskets).toEqual([]);
    await stopAll();

    // ── 3. A COLD RESTART with payments.mobile_pos on too: the baskets are as they were; a card sale on the handheld ──
    edge = await boot('queue_and_payments');
    expect((await queueLog()).filter((b) => b.state !== 'waiting').map((b) => [b.state, b.recalledOnLane ?? b.giveUpReason])).toEqual([['recalled', LANE], ['given_up', 'Customer left the queue']]);
    expect((await tillRecall(edge, handed.code)).out).toMatchObject({ ok: false, refusedBecause: 'already_recalled' });
    q = await handheld(edge, runnerCookie);
    expect(q.paymentsHere()).toBe(true);
    q.scan(CODE.dal);
    const attempt = await q.till.startCardPayment('card');
    expect(attempt).toMatchObject({ ok: true });
    expect(await q.till.answerCardPayment(attempt.attemptId!, 'approved')).toMatchObject({ ok: true, state: 'approved' });
    const number = await q.till.nextReceipt();
    await q.till.tenderCardOrUpi({ saleId: `S-${number}`, receiptNumber: number, atIsoUtc: new Date().toISOString(), kind: 'card', outcome: 'approved', ref: attempt.attemptId! });
    const sales = await onDisk(edge);
    const mine = sales.find((s) => s['id'] === `S-${number}`)!;
    expect(mine).toMatchObject({ laneId: `device:${DEVICE}`, cashierId: RUNNER, total: 12_000, operatorVerified: { userId: RUNNER, laneId: `device:${DEVICE}`, via: 'pin' } });
    expect(typeof (mine['operatorVerified'] as { seal?: unknown }).seal).toBe('string');
    expect((mine['tenders'] as { kind: string; ref?: string }[]).map((t) => [t.kind, t.ref])).toEqual([['card', attempt.attemptId]]);
    // Cash on a handheld is not decided: refused before the disk; so are a refund and a cash movement.
    q.newCustomer();
    q.scan(CODE.oil);
    await expect(q.till.tenderCash(`S-cash-${number}`, `R-cash-${number}`, new Date().toISOString())).rejects.toMatchObject({ refusedBecause: 'tender_not_on_handheld' });
    for (const path of ['/lane/returns', '/lane/cash-movements', '/lane/held-bills', '/lane/approvals', '/lane/day-close']) {
      const r = await saved(`${dev(edge)}/queue-pos${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: runnerCookie }, body: '{}' });
      expect([path, r.status]).toEqual([path, 404]);
    }
    expect((await onDisk(edge)).length).toBe(sales.length);
    expect(edge.outbox.unsentCount()).toBe(2);

    // ── 4. THE LINE COMES BACK: head office books the handheld's sale as any till's ────────────────────────────────
    cut = false;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const onHand = async (productId: string): Promise<number> =>
      ((await cloud.request({ method: 'GET', path: `/v1/inventory/availability?productId=${productId}`, userId: OWNER })).body as { rows: { locationId: string; onHandMinor: number }[] })
        .rows.filter((r) => r.locationId === STORE).reduce((n, r) => n + r.onHandMinor, 0);
    expect(await onHand('p-dal')).toBe(20 - 2 - 1);
    expect(await onHand('p-oil')).toBe(10 - 1);
    const filed = await cloud.request({ method: 'GET', path: `/v1/sales/S-${number}`, userId: OWNER });
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    expect(filed.body).toMatchObject({ saleId: `S-${number}`, banked: true });
    // The SAME record as a till's: head office finds exactly what it finds on the fixed till's bill — and never that the
    // store computer could not vouch for who rang it (the seal is there and matches).
    const exceptions = (await cloud.request({ method: 'GET', path: '/v1/sales/exceptions', userId: OWNER })).body as { critical: { kind: string; saleId: string }[]; material: { kind: string; saleId: string }[] };
    const kindsOf = (saleId: string): string[] => [...exceptions.critical, ...exceptions.material].filter((e) => e.saleId === saleId).map((e) => e.kind).sort();
    expect(kindsOf(`S-${number}`)).toEqual(kindsOf(`S-till-${handed.code}`));
    expect([...exceptions.critical, ...exceptions.material].map((e) => e.kind)).not.toContain('cashier_not_verified_at_store');
    expect([...exceptions.critical, ...exceptions.material].map((e) => e.kind)).not.toContain('cashier_seal_does_not_match');
    // The books: both bills post — the handheld's card to the card receivable, the GST output on both.
    // Posted for the trading day(s) the two bills were dated (a run that crosses midnight posts both days).
    const days = [...new Set((await onDisk(edge)).map((r) => String(r['tradingDay'])))].sort();
    type Posted = { journals: { kind: string; components: Record<string, number> }[]; counted: { sales: number } };
    const postings: Posted[] = [];
    for (const day of days) postings.push((await cloud.request({ method: 'POST', path: `/v1/finance/day-book/${day}/post`, userId: ACCOUNTANT, body: {}, idempotencyKey: `db-${day}` })).body as Posted);
    const journals = postings.flatMap((p) => p.journals);
    const sum = (kind: string, part: string): number => journals.filter((j) => j.kind === kind).reduce((n, j) => n + (j.components[part] ?? 0), 0);
    expect(postings.reduce((n, p) => n + p.counted.sales, 0)).toBe(2);
    expect(sum('tender:card', 'amount')).toBe(12_000);
    expect([sum('sale', 'total'), sum('sale', 'tax')]).toEqual([56_000, 2_665]);
    const tb = (await cloud.request({ method: 'GET', path: `/v1/finance/periods/${days.at(-1)!.slice(0, 7)}/trial-balance`, userId: ACCOUNTANT })).body as { balanced: boolean; rows: { account: string; closingNetDebitMinor: number }[] };
    expect(tb.balanced).toBe(true);
    expect(Object.fromEntries(tb.rows.map((r) => [r.account, r.closingNetDebitMinor]))).toMatchObject({ card_receivable: 12_000, cash_in_hand: 44_000, sales_revenue: -53_335 });
    // A resend books nothing twice: the queue is empty, and the same record sent again is the same sale.
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    const again = await cloud.request({ method: 'POST', path: '/v1/sales', userId: RUNNER, idempotencyKey: `resend-${number}`, body: toCloudSale(mine, 0) });
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body).toMatchObject({ alreadyBanked: true });
    expect(await onHand('p-dal')).toBe(20 - 2 - 1);
  } finally {
    await stopAll();
    globalThis.fetch = saved;
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('D04-FR-05 — the queue till scans, pays and hands over through the store computer (memory)', () => {
  it('off until switched on; a hand-over the till rings once; a card sale on the handheld; a cold restart; head office books it', async () => {
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
    await queueBustOfflineAndSync(cloud);
  }, 180_000);
});

const DATABASE_URL = process.env['DATABASE_URL'];
describe.skipIf(DATABASE_URL === undefined)('D04-FR-05 — the same on real PostgreSQL, over HTTP', () => {
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

  it('off until switched on; a hand-over the till rings once; a card sale on the handheld; a cold restart; head office books it', async () => {
    await queueBustOfflineAndSync(cloud);
  }, 240_000);
});
