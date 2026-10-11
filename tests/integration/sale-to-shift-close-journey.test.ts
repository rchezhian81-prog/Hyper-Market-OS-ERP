import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { addTillPeople, signInTill, managerApprovesOn, pinOf } from '../support/till-operator';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { makeTradingDayRule, tradingDateOf } from '../../packages/calendar/src/trading-day';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **Batch 3 acceptance — a sale to a closed shift and a closed day, reconciled independently (Wave 5 · PF-06, PF-08,
 * PF-09, PF-12 · M12-FR-03, M13-FR-01/03, M14-FR-01/02/04, M17-FR-01/03, M23-FR-01/03/04 · hard rules #1 #2 #10).**
 *
 * One connected run on the REAL production API (`startApi`) over REAL PostgreSQL as the application role, the REAL store
 * computer (`startEdge`) under the store's own sync identity, and the till's OWN session model (the code the served page
 * boots), driven through the day:
 *
 *   head office publishes rice and oil (5% GST inside the shelf price) and launches 10% off oil; books opening stock; the
 *   owner sets the loyalty rule, the point value and the till spend limit; a member joins at the desk →
 *   the box pulls the pack and the members' balances → the cashier signs in, takes the float →
 *   S-1: the member's bill — 2 rice + 1 oil at the offer price — paid split: card (an attempt recorded on the box before
 *   the machine, approved) + cash; the member earns →
 *   R-1: one rice comes back against the bill, approved by the manager with their own PIN, refunded as store credit to
 *   the member's mobile number; the rice goes back on the shelf and the points it earned are taken back →
 *   S-2: the member spends their store credit and all their points on another rice, the rest in cash →
 *   the same sale relayed twice is one effect →
 *   the cable is cut: S-3 is sold and saved on the box only; the box RESTARTS with the cable still out; the line returns
 *   and S-3 reaches head office once →
 *   the cashier banks a pickup and closes the shift blind; the manager closes the day →
 *   the accountant posts the day book; the provider's settlement file and the bank statement (synthetic fixtures — no
 *   live provider) are imported.
 *
 * Then the INDEPENDENT reconciliation, each figure reached two ways and required to agree exactly:
 *   stock (opening − sold + returned) · cash (expected vs counted) · card tenders vs the settlement file · the provider's
 *   payout vs the bank · loyalty points and store credit held vs the liability the books carry · sales clearing at zero.
 *
 * Not proved here, and said: the till captures no lot at the counter, so a sale line carries no batch and a return can
 * only keep a lot the bill carries (see the report — an owner decision on how the counter captures lots).
 *
 * Synthetic data only (hard rule #7). Needs DATABASE_URL; without it the suite SKIPS.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const KEY = ['sale', 'to', 'shift', 'close', 'journey', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-meena';
const MANAGER = 'u-manager';
const ACCT = 'u-acct';
const MOBILE = '98400 24680';
const MEMBER = memberRefFor(loyaltyMemberKey(KEY), MOBILE)!;
const RICE = { productId: 'p-rice', barcode: '8901234560011', price: 48_000, mrp: 50_000, cost: 40_000 };
const OIL = { productId: 'p-oil', barcode: '8901234560028', price: 20_000, mrp: 22_000, cost: 12_000 };
const OIL_OFFER = 18_000; // 10% off ₹200

interface Reply { status: number; body: unknown }

/** GST inside an inclusive amount at 5%, as the till and the day book pull it out (A9: taxable + tax == gross). */
const gstInside = (gross: number): number => gross - Math.round((gross * 100) / 105);

describeOrSkip('Batch 3 acceptance: sale → split tender → loyalty → return → store credit → shift close → day close → independent reconciliation (real API · real PostgreSQL · real box)', () => {
  let cloud: RealCloud;
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];
  const realFetch = globalThis.fetch;
  let cableCut = false;

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    // The network cut is the STORE's line to head office: the box's calls to the cloud fail while it is cut.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      // (Nothing in this test calls head office itself while the cable is cut.)
      if (cableCut && String(url).startsWith(cloud.baseUrl)) {
        throw new Error('ENETUNREACH');
      }
      return realFetch(url, init);
    }) as typeof globalThis.fetch;
    // OB-36 "A": the store computer holds its own role — every sync/relay permission it needs, the day close included.
    await cloud.grant(BOX, 'store_computer');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(MANAGER, 'store_manager');
    await cloud.grant(ACCT, 'accountant');
    expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'tz')).status).toBe(200);
    await setUpHeadOffice();
  }, 90_000);
  afterAll(async () => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    for (const edge of edges.splice(0)) await edge.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    await cloud?.stop();
  });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<Reply>, what: string): Promise<Reply> => {
    const r = await p;
    expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r;
  };

  async function setUpHeadOffice(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax'), 'tax rate');
    for (const p of [{ ...RICE, name: 'Ponni rice 5kg', sku: 'RICE-5KG' }, { ...OIL, name: 'Groundnut oil 1L', sku: 'OIL-1L' }]) {
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/publish`, OWNER, {
        product: { sku: p.sku, name: p.name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
        categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
      }, `publish-${p.productId}`), 'publish');
      await ok(call('POST', `/v1/prices/list/${p.productId}/entries/e1`, OWNER, {
        scope: 'store', scopeRef: STORE, priceMinor: p.price, mrpMinor: p.mrp, costMinor: p.cost, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
      }, `price-${p.productId}`), 'price');
      await ok(call('POST', `/v1/catalogue/products/${p.productId}/barcodes/${p.barcode}`, OWNER, { kind: 'ean' }, `barcode-${p.productId}`), 'barcode');
      await ok(call('POST', '/v1/inventory/movements', OWNER, {
        movementId: `mv-open-${p.productId}`, productId: p.productId, locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'ea',
        occurredAt: `${today}T00:30:00.000Z`, enteredBy: OWNER, unitCostMinor: p.cost,
      }, `open-${p.productId}`), 'opening stock');
    }
    // 10% off oil, defined and LAUNCHED (its margin check passed) — the next pack carries it (SF-01).
    await ok(call('POST', '/v1/promotions/oil-10/definition', OWNER, { kind: 'percent_off', percentBps: 1000, productIds: [OIL.productId], startsAt: day(-1), endsAt: day(30) }, 'def-oil'), 'offer');
    await ok(call('POST', '/v1/promotions/oil-10/launch', OWNER, { description: '10% off oil', normalPrice: { minor: OIL.price, currency: 'INR' }, promoPrice: { minor: OIL_OFFER, currency: 'INR' }, unitCost: { minor: OIL.cost, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200 }, 'launch-oil'), 'launch');
    const pack = await call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1');
    expect(pack.status, JSON.stringify(pack.body)).toBe(201);
    // The owner's loyalty rule (OB-28 "C"): 1 point per ₹100, a point is worth ₹1, at most ₹1,000 spent at a till a day;
    // and the store-credit cap. A member joins at the desk with their consent, the number seen on their phone (OB-29 "A").
    for (const [key, value] of [['loyalty.points_per_100_inr', 1], ['loyalty.point_value_paise', 100], ['loyalty.till_spend_cap_paise', 100_000]] as const) {
      await ok(call('PUT', `/v1/platform/setup/${key}`, OWNER, { value }, `set-${key}`), key);
    }
    await ok(call('POST', '/v1/pos/store-credit-cap', OWNER, { capMinor: 100_000 }, 'sc-cap'), 'store-credit cap');
    await ok(call('POST', '/v1/loyalty/members', MANAGER, { mobile: MOBILE, consent: true, verifiedHow: 'seen_on_phone' }, 'join'), 'member joins');
  }

  async function startBox(dir?: string): Promise<EdgeProcess> {
    const dataDir = dir ?? await mkdtemp(join(tmpdir(), 'sre-journey-'));
    if (dir === undefined) dirs.push(dataDir);
    const packFile = join(dataDir, 'store-pack.json');
    if (dir === undefined) {
      await writeFile(packFile, JSON.stringify({
        version: 1,
        policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: `${STORE}-BACK`, tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
        lossPreventionRules: [],
      }), 'utf8');
      await addTillPeople(packFile, dataDir, KEY, [{ userId: CASHIER, displayName: 'Meena' }, { userId: MANAGER, displayName: 'Manager', manager: true }]);
    }
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    }, () => {}))!;
    edges.push(edge);
    return edge;
  }
  async function servedCatalogue(edge: EdgeProcess): Promise<CatalogueSnapshot> {
    const html = await (await realFetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    return JSON.parse(/<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html)![1]!) as CatalogueSnapshot;
  }
  const onHand = async (productId: string): Promise<number | undefined> =>
    ((await call('GET', `/v1/inventory/availability?productId=${productId}`, OWNER)).body as { rows: { locationId: string; onHandMinor: number }[] })
      .rows.find((r) => r.locationId === STORE)?.onHandMinor;
  const pointsHeld = async (): Promise<number | undefined> => ((await call('GET', `/v1/customers/${MEMBER}/points`, OWNER)).body as { pointsBalance?: number }).pointsBalance;
  const creditHeld = async (): Promise<number> => ((await call('GET', `/v1/stored-value/households/${MEMBER}/balance`, OWNER)).body as { balanceMinor: number }).balanceMinor;

  it('sells, splits, earns, returns with approval, issues and spends store credit, survives a cut and a restart, closes the shift and the day — and every figure reconciles independently', async () => {
    // ── The box pulls the signed pack and the members' balances; the served till is built from the pack (offer included).
    let edge = await startBox();
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: 1 });
    expect(await edge.refreshLoyaltyWallets!()).toMatchObject({ status: 'updated' });
    const served = await servedCatalogue(edge);
    expect(served.promotions).toEqual([expect.objectContaining({ id: 'oil-10', percentBps: 1000 })]);
    const dataDir = dirs[0]!;

    let till = bootPos({ laneId: LANE, catalogue: served, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    await signInTill(till, CASHIER);
    const T0 = Date.now();
    const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
    const tradingDay = tradingDateOf(at(0), makeTradingDayRule('00:00'));
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: at(0), movementId: 'cm-float' })).toMatchObject({ committed: true });

    // ── S-1: the member's bill. 2 rice (₹960) + 1 oil at the launched offer (₹180) = ₹1,140; GST inside, never added.
    expect(till.setLoyaltyMobile(MOBILE)).toMatchObject({ ok: true, last4: '4680' });
    till.scanBarcode(RICE.barcode);
    till.scanBarcode(RICE.barcode);
    till.scanBarcode(OIL.barcode);
    expect(till.payableMinor()).toBe(2 * RICE.price + OIL_OFFER);
    // Split: ₹640 by card (the attempt recorded on the box BEFORE the machine — the test adapter answers "approved") + ₹500 cash.
    const card = await till.startCardPayment('card', 64_000);
    expect(card).toMatchObject({ ok: true });
    expect(await till.answerCardPayment(card.attemptId!, 'approved')).toMatchObject({ ok: true });
    const r1 = await till.nextReceipt();
    expect(await till.tenderSplit({ saleId: 'S-1', receiptNumber: r1, atIsoUtc: at(5), parts: [{ kind: 'card', amountMinor: 64_000, ref: card.attemptId! }, { kind: 'cash', amountMinor: 50_000 }] })).toBe(r1);
    till.newSale();
    const onDisk = (await readLog(edge.log.path)).map((r) => JSON.parse((r as { record: string }).record) as Record<string, unknown>);
    expect(onDisk[0]).toMatchObject({
      id: 'S-1', cashierId: CASHIER, customerRef: MEMBER, total: 114_000,
      // Each scan is its own line, and the GST is pulled out of each line as charged.
      taxMinor: 2 * gstInside(RICE.price) + gstInside(OIL_OFFER), netMinor: 114_000 - 2 * gstInside(RICE.price) - gstInside(OIL_OFFER),
    });
    expect(JSON.stringify(onDisk)).not.toContain('9840024680');
    expect((await edge.syncOnce!()).dead).toBe(0);
    expect(await onHand(RICE.productId)).toBe(8);
    expect(await onHand(OIL.productId)).toBe(9);
    expect(await pointsHeld()).toBe(11); // ₹1,140 → 11 points

    // ── R-1: one rice back against S-1, approved by the manager with their own PIN; refunded as store credit to the member.
    const bill = (await till.lookupRefund(r1))!;
    expect(bill.sale).toMatchObject({ saleId: 'S-1', totalMinor: 114_000 });
    const approval = await managerApprovesOn(till, MANAGER, { kind: 'refund', billRef: 'S-1', valueMinor: RICE.price, reason: 'bag torn' });
    const refunded = await bill.submit({
      returnId: 'RT-1', number: await till.nextReceipt(), reasonCode: 'damaged',
      lines: [{ productId: RICE.productId, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: RICE.price, refundTender: 'store_credit', approval, customerRef: MOBILE.replace(/\s/g, ''),
    });
    expect(refunded).toMatchObject({ kind: 'settled', refundMinor: RICE.price });
    expect(JSON.stringify((await readLog(edge.returnsLog.path)))).not.toContain('9840024680'); // the box swapped it for the code
    expect((await edge.syncOnce!()).dead).toBe(0);
    expect(await onHand(RICE.productId)).toBe(9);
    expect(await pointsHeld()).toBe(7);           // 11 − ⌊11 × 480/1,140⌋ = 11 − 4
    expect(await creditHeld()).toBe(RICE.price);  // ₹480 of store credit, issued by head office on the synced refund

    // ── S-2: the member spends ₹300 store credit + all 7 points (₹7) on a rice; ₹173 cash. The box decides from its copy.
    expect(await edge.refreshLoyaltyWallets!()).toMatchObject({ status: 'updated' });
    till.setLoyaltyMobile(MOBILE);
    expect(await till.loyaltyWallet()).toMatchObject({ ok: true, points: 7, pointsValueMinor: 700, storeCreditMinor: RICE.price, capRemainingMinor: 100_000 });
    till.scanBarcode(RICE.barcode);
    const r2 = await till.nextReceipt();
    expect(await till.tenderSplit({ saleId: 'S-2', receiptNumber: r2, atIsoUtc: at(20), parts: [{ kind: 'store_credit', amountMinor: 30_000 }, { kind: 'loyalty_points', amountMinor: 700 }, { kind: 'cash', amountMinor: 17_300 }] })).toBe(r2);
    till.newSale();
    expect((await edge.syncOnce!()).dead).toBe(0);
    expect(await pointsHeld()).toBe(4);           // 7 − 7 + ⌊₹473 / ₹100⌋
    expect(await creditHeld()).toBe(18_000);
    expect(await onHand(RICE.productId)).toBe(8);

    // ── The same sale relayed twice is one effect: to the box, and to head office under a fresh key.
    const s1Record = ((await readLog(edge.log.path))[0] as { record: string }).record;
    // The till's retry after a lost reply: the record as the TILL sent it — the keyed number, not the box's stamps.
    const { customerRef: _code, operatorVerified: _stamp, ...asSent } = JSON.parse(s1Record) as Record<string, unknown>;
    void _code; void _stamp;
    const again = await (await realFetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sre-operator': till.operatorToken()! }, body: JSON.stringify({ ...asSent, customerMobile: MOBILE }) })).json() as { committed: boolean };
    expect(again.committed, JSON.stringify(again)).toBe(true);
    expect(await readLog(edge.log.path)).toHaveLength(2);
    const { toCloudSale } = await import('../../edge/store-edge/src/cloud-sale');
    const relay = await call('POST', '/v1/sales', BOX, toCloudSale(JSON.parse(s1Record) as unknown, 1, STORE, LANE), 'relay-S-1-again');
    expect((relay.body as { alreadyBanked?: boolean }).alreadyBanked).toBe(true);
    expect(await onHand(RICE.productId)).toBe(8);
    expect(await pointsHeld()).toBe(4);

    // ── The cable is cut. S-3 (an oil, cash) is saved on the box only.
    cableCut = true;
    till.scanBarcode(OIL.barcode);
    const r3 = await till.nextReceipt();
    expect(await till.tenderCash('S-3', r3, at(40))).toBe(r3);
    till.newSale();
    const cut = await edge.syncOnce!();
    expect(cut.sent).toBe(0);
    expect(edge.outbox.unsentCount()).toBe(1);

    // ── The box restarts with the cable still out: the pack, the sale and its place in the queue survive.
    await edges.splice(edges.indexOf(edge), 1)[0]!.stop();
    edge = await startBox(dataDir);
    expect(edge.node.pack()?.snapshot.version).toBe(1);
    expect(edge.outbox.unsentCount()).toBe(1);
    till = bootPos({ laneId: LANE, catalogue: served, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    await signInTill(till, CASHIER);

    // ── The line returns: S-3 reaches head office once.
    cableCut = false;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect((await call('GET', '/v1/sales/S-3', OWNER)).body).toMatchObject({ saleId: 'S-3', banked: true });
    expect(await onHand(OIL.productId)).toBe(8);

    // ── Cash: a pickup to the safe, then the BLIND close. Expected = ₹2,000 + ₹500 + ₹173 + ₹180 − ₹1,000 = ₹1,853.
    expect(await till.till.moveCash({ kind: 'pickup', amountMinor: 100_000, at: at(50), movementId: 'cm-pick' })).toMatchObject({ committed: true });
    const counted = 185_300;
    const shift = await till.till.close({ shiftId: 'sh-1', closedAt: at(60), countedMinor: counted });
    expect(shift).toMatchObject({ closed: true, varianceMinor: 0 });
    // The day does not close over unsent work: the pickup and the shift close reach head office first (M14-FR-04).
    expect((await edge.closeDay({ dayCloseId: 'dc-too-early', closedBy: MANAGER, closerPin: pinOf(MANAGER) })).closed).toBe(false);
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });

    // ── A trading day closes once its cut-off has passed (M01-FR-02): the clock moves to 00:05 the next morning, and the
    // box is started for the new day (a second restart, with the store's credential as issued that morning).
    const nextMorning = new Date(Date.parse(`${tradingDay}T00:00:00.000Z`) + 86_400_000 + 5 * 60_000);
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(nextMorning);
    await edges.splice(edges.indexOf(edge), 1)[0]!.stop();
    edge = await startBox(dataDir);
    // ── The manager closes the day on the box (an open till would block it — PF-08); it reaches head office.
    const closedDay = await edge.closeDay({ dayCloseId: `dc-${tradingDay}`, closedBy: MANAGER, closerPin: pinOf(MANAGER) });
    expect(closedDay, JSON.stringify(closedDay)).toMatchObject({ closed: true, tradingDay, locked: true });
    const dayCloseSync = await edge.syncOnce!();
    expect(dayCloseSync, JSON.stringify(edge.dayCloseOutbox.deadLetters())).toMatchObject({ dead: 0, remaining: 0 });
    const dayClose = (await call('GET', '/v1/pos/day-close', OWNER)).body as { dayCloses: { dayCloseId: string; locked: boolean }[] };
    expect(dayClose.dayCloses).toEqual(expect.arrayContaining([expect.objectContaining({ dayCloseId: `dc-${tradingDay}`, locked: true })]));

    // ── Accounting: the accountant maps and posts the day — every journal balances, nothing held back.
    await ok(call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP, 'map'), 'posting map');
    const posted = await ok(call('POST', `/v1/finance/day-book/${tradingDay}/post`, ACCT, undefined, `post-${tradingDay}`), 'day book');
    const dayBook = posted.body as { journals: { kind: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(dayBook.exceptions).toEqual([]);
    for (const j of dayBook.journals) expect(j.lines.reduce((n, l) => n + l.debitMinor - l.creditMinor, 0), j.kind).toBe(0);
    expect(dayBook.journals.map((j) => j.kind)).toEqual(expect.arrayContaining(['sale', 'tender:cash', 'tender:card', 'tender:store_credit', 'tender:loyalty_points', 'sale_return', 'refund:store_credit', 'loyalty:earn', 'loyalty:takeback']));
    const accounts = ((await call('GET', `/v1/finance/day-book/${tradingDay}`, ACCT)).body as { accounts: { accountCode: string; balanceMinor: number }[]; open: number });
    expect(accounts.open).toBe(0);

    // ── The outside evidence (synthetic fixtures): the provider's settlement file for the card tender, then the bank
    // statement with the provider's payout naming the file.
    const today = tradingDay;
    const month = today.slice(0, 7);
    await ok(call('POST', '/v1/settlement/batches', ACCT, {
      batchId: `PB-${today}`, providerId: 'test-acquirer', currency: 'INR', settlementDate: today, sourceName: 'acquirer-fixture.json',
      lines: [{ id: 'l1', ref: card.attemptId!, amountMinor: 64_000 }], declaredGrossMinor: 64_000, declaredFeesMinor: 640, declaredNetMinor: 63_360,
    }, 'pb'), 'settlement file');
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    await ok(call('POST', '/v1/finance/bank-statements', ACCT, {
      statementId: `BANK-${month}`, accountRef: 'current-account-1', fromDate: `${month}-01`, toDate: lastDay, openingMinor: 1_000_000, closingMinor: 1_063_360,
      sourceName: 'bank-fixture.csv', csv: `Date,Reference,Narrative,Debit,Credit\n${today},UTR-1 PB-${today},ACQUIRER PAYOUT,,633.60`,
    }, 'bank'), 'bank statement');

    // ════ THE INDEPENDENT RECONCILIATION — each figure two ways, equal exactly ════
    const evidence = (await call('GET', `/v1/finance/periods/${month}/independent-evidence`, ACCT)).body as { agrees: boolean; checks: { name: string; leftMinor: number; rightMinor: number }[] };
    const liability = (await call('GET', '/v1/finance/loyalty-liability', ACCT)).body as { reconciles: boolean; points: { outstandingPoints: number; heldValueMinor: number; postedMinor: number }; storeCredit: { heldMinor: number; postedMinor: number } };
    const tillCash = (await call('GET', `/v1/tills/${LANE}/cash`, OWNER)).body as { balanceMinor: number; flagged: unknown[] };
    const overShort = ((await call('GET', '/v1/shifts/over-short', OWNER)).body as { overShort: unknown[] }).overShort;
    const balanceOf = (code: string): number => accounts.accounts.find((a) => a.accountCode === code)?.balanceMinor ?? 0;
    const table = [
      { what: 'rice on hand (10 − 2 sold + 1 returned − 1 sold)', expected: 8, actual: await onHand(RICE.productId) },
      { what: 'oil on hand (10 − 1 − 1)', expected: 8, actual: await onHand(OIL.productId) },
      { what: 'drawer: float + cash tenders − pickup (this script) vs the box\'s expected (counted − variance)', expected: 200_000 + 50_000 + 17_300 + 18_000 - 100_000, actual: counted - (shift as { varianceMinor: number }).varianceMinor },
      { what: 'drawer counted blind vs expected', expected: counted, actual: 200_000 + 50_000 + 17_300 + 18_000 - 100_000 },
      { what: 'till custody at head office (float − pickup)', expected: 100_000, actual: tillCash.balanceMinor },
      { what: 'card tenders (books) vs provider settlement file', expected: evidence.checks[0]!.leftMinor, actual: evidence.checks[0]!.rightMinor },
      { what: 'provider payout (file) vs bank statement credit', expected: evidence.checks[1]!.leftMinor, actual: evidence.checks[1]!.rightMinor },
      { what: 'loyalty points held (value) vs liability posted', expected: liability.points.heldValueMinor, actual: liability.points.postedMinor },
      { what: 'store credit held vs liability posted', expected: liability.storeCredit.heldMinor, actual: liability.storeCredit.postedMinor },
      { what: 'sales clearing after tenders and refunds', expected: 0, actual: balanceOf('sales_clearing') },
      { what: 'cash in hand posted vs cash taken in sales (₹500 + ₹173 + ₹180)', expected: 85_300, actual: balanceOf('cash_in_hand') },
      { what: 'card receivable posted vs card tendered', expected: 64_000, actual: balanceOf('card_receivable') },
    ];
    // Printed for the report: the reconciliation table, expected vs actual.
    process.stdout.write(`\nRECONCILIATION\n${table.map((r) => `  ${r.what}: expected ${r.expected} · actual ${r.actual}`).join('\n')}\n`);
    for (const row of table) expect(row.actual, row.what).toBe(row.expected);
    expect(evidence.agrees).toBe(true);
    expect(liability.reconciles).toBe(true);
    expect(liability.points).toMatchObject({ outstandingPoints: 4, heldValueMinor: 400 });
    expect(liability.storeCredit.heldMinor).toBe(18_000);
    expect(tillCash.flagged).toEqual([]);
    expect(overShort).toEqual([]);

  }, 240_000);
});
