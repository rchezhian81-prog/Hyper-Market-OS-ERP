import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { makeTradingDayRule, tradingDateOf } from '../../packages/calendar/src/trading-day';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **The store trades a day, connected — on the REAL cloud, over REAL PostgreSQL, through the REAL box (SP-9-i · W10 · F13).**
 *
 * Every earlier suite proved one join at a time, most of them against the in-process API harness. This one runs the
 * production API assembly (`startApi`, the code the container runs) as the application role on a real database, starts
 * the real store box against it under the store's own sync identity, and drives the till's OWN session model (the code
 * the served shell boots) through a trading day:
 *
 *   head office publishes the catalogue (tax rate, product, store price, barcode, signed pack) and books opening stock →
 *   the box pulls the pack and the SERVED till is built from it (F13 — until this slice the till priced from the pack
 *   FILE and the pulled pack fed only the badge) → the cashier signs in, takes the float, scans the barcode and takes
 *   cash → the sale is on the box's disk first and reaches the cloud on the next pass → stock at the store falls and the
 *   valuation follows → the customer brings it back and the refund (approved by a manager) puts the stock back → the
 *   cashier banks a pickup and closes the till blind → the cash office sees the chain and no over/short → the accountant
 *   posts the day book and every journal balances → the owner's dashboard shows the day's takings → the box restarts and
 *   is still trading from the pulled pack with nothing re-sent.
 *
 * Then the things that go wrong: the same sale posted twice banks once; a box whose identity holds no sync right keeps
 * every record and reaches nothing; a pull under a credential head office does not know is "offline", not a new pack.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL (the CI job provides one);
 * without it the suite SKIPS — and the CI shell check refuses a run where the database tests silently skipped.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const KEY = ['store', 'trades', 'a', 'day', 'signing', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const BACK = 'S1-BACK';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const BOX = 'u-box';          // the store computer's sync identity (cashier role: *.sync + catalogue.pack.read)
const CASHIER = 'u-meena';    // signs in at the till
const MANAGER = 'u-manager';  // approves the refund (store_manager: pos.return.approve)
const ACCT = 'u-acct';        // posts the day book
const PRODUCT = 'p-rice';
const BARCODE = '8901234567890';
const PRICE = 48_000;         // ₹480.00 — the shelf price head office published (≤ the ₹500 MRP), the 5% GST INSIDE it (A9)
/** The GST inside the ₹480: 480 × 100/105 = ₹457.14 taxable, ₹22.86 GST — the remainder, so the two sum to the price to the paisa. */
const TAXABLE = 45_714;
const GST = 2_286;
const COST = 40_000;

interface Reply { status: number; body: unknown }

/** The till's catalogue exactly as the SAME box serves it to the browser: the global the shell boots from. */
async function servedTillCatalogue(edge: EdgeProcess): Promise<(CatalogueSnapshot & { source?: string }) | undefined> {
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
  const match = /<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html);
  return match === null ? undefined : JSON.parse(match[1]!) as CatalogueSnapshot & { source?: string };
}

describeOrSkip('the store trades a day, connected: real API · real PostgreSQL · real box · the till\'s own session (SP-9-i · W10 · F13)', () => {
  let cloud: RealCloud;
  const dirs: string[] = [];
  const edges: EdgeProcess[] = [];

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    await cloud.grant(BOX, 'cashier');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(MANAGER, 'store_manager');
    await cloud.grant(ACCT, 'accountant');
    // The box in this run keeps this machine's clock (UTC) with a midnight cut-off; the owner tells head office so,
    // through store setup — "Sales today" is then the SHOP's trading day at head office too (F14 fixed, SP-9-i-c).
    expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'setup-tz-utc')).status).toBe(200);
    await publishCatalogueAndStock();
  }, 60_000);
  afterAll(async () => { await cloud?.stop(); });
  afterEach(async () => {
    for (const edge of edges.splice(0)) await edge.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });

  /** A pack FILE with policies only — no products: the shape the one-PC install starts with. The catalogue comes from head office. */
  async function startBox(token: string, dir?: string): Promise<EdgeProcess> {
    const dataDir = dir ?? await mkdtemp(join(tmpdir(), 'sre-trades-a-day-'));
    if (dir === undefined) dirs.push(dataDir);
    const packFile = join(dataDir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: BACK, tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
      lossPreventionRules: [],
    }), 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: token,
    }, () => {}))!;
    edges.push(edge);
    return edge;
  }

  /** Head office authors the one product this shop sells today and books ten on the shelf. Idempotent per run. */
  async function publishCatalogueAndStock(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    expect((await call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax-1006')).status).toBeLessThan(300);
    expect((await call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
      product: { sku: 'RICE-5KG', name: 'Ponni rice 5kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, `publish-${PRODUCT}`)).status).toBeLessThan(300);
    expect((await call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: PRICE, mrpMinor: 50_000, costMinor: COST, marginFloorBps: 0, currency: 'INR', effectiveFrom: today, // a price may not be back-dated (§28)
    }, `price-${PRODUCT}`)).status).toBeLessThan(300);
    expect((await call('POST', `/v1/catalogue/products/${PRODUCT}/barcodes/${BARCODE}`, OWNER, { kind: 'ean' }, `barcode-${PRODUCT}`)).status).toBeLessThan(300);
    const published = await call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1');
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    // Opening stock at the store, booked directly so this suite stays the RETAIL leg. The chain that fills a shelf for real —
    // supplier → order → delivery → quarantine → back store → indent → floor — runs connected in `the-store-buys-what-it-sells` (SP-9-ii).
    const opening = await call('POST', '/v1/inventory/movements', OWNER, {
      movementId: 'mv-opening', productId: PRODUCT, locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'ea',
      occurredAt: `${today}T00:30:00.000Z`, enteredBy: OWNER, unitCostMinor: COST,
    }, 'mv-opening');
    expect(opening.status, JSON.stringify(opening.body)).toBe(202);
  }

  const onHandAt = async (locationId: string): Promise<number | undefined> => {
    const r = await call('GET', `/v1/inventory/availability?productId=${PRODUCT}`, OWNER);
    expect(r.status).toBe(200);
    return (r.body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((row) => row.locationId === locationId)?.onHandMinor;
  };

  it('publish → pull → sell → sync → stock falls → refund → stock back → float/pickup/close → cash office, day book and dashboard agree → restart keeps the pack', async () => {
    expect(await onHandAt(STORE)).toBe(10);

    // ── The box, before its first pull: a file with no products means the served till has NO catalogue (and says so).
    const edge = await startBox(cloud.token(BOX));
    expect(await servedTillCatalogue(edge)).toBeUndefined();

    // ── The pull: head office's signed pack, verified with the shared key, adopted, persisted.
    const pulled = await edge.refreshPack!();
    expect(pulled).toMatchObject({ status: 'updated', heldVersion: 1 });

    // ── F13 FIXED: the SERVED till is built from the pulled pack — priced, taxed, barcoded as head office published it.
    const served = (await servedTillCatalogue(edge))!;
    expect(served).toMatchObject({ source: 'head_office', version: 1, tenantId: cloud.tenantId });
    expect(served.products.map((p) => ({ productId: p.productId, unitPriceMinor: p.unitPriceMinor, taxBps: p.taxBps, status: p.status, baseUom: p.baseUom })))
      .toEqual([{ productId: PRODUCT, unitPriceMinor: PRICE, taxBps: 500, status: 'active', baseUom: 'ea' }]);
    expect(served.barcodes).toEqual([{ code: BARCODE, productId: PRODUCT, kind: expect.any(String) }]);
    expect(served.scope).toMatchObject({ storeId: STORE });

    // ── The till: the shell's own session model, booted the way the served page boots it, posting to this box's lane socket.
    const port = edge.lane!.port;
    const till = bootPos({ laneId: LANE, catalogue: served, lanePort: port, tradingDayCutoff: '00:00' });
    till.signIn(CASHIER);
    const T0 = Date.now();
    const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
    const tradingDay = tradingDateOf(at(0), makeTradingDayRule('00:00'));

    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: at(0), movementId: 'cm-float' })).toMatchObject({ committed: true });
    const scanned = till.scanBarcode(BARCODE);
    expect(scanned).toMatchObject({ description: 'Ponni rice 5kg', qty: 1, amountMinor: PRICE, requiresAgeCheck: false });
    expect(await till.tenderCash('S-1', 'R-S-1', at(5))).toBe('R-S-1');
    till.newSale();

    // Durable on THIS box first (hard rule #1), queued for the cloud; nothing has reached head office yet.
    const onDisk = (await readLog(edge.log.path)).map((r) => JSON.parse((r as { record: string }).record) as Record<string, unknown>);
    expect(onDisk).toHaveLength(1);
    // The customer paid the shelf price — never the price plus GST (F15 fixed): the GST is pulled OUT of the ₹480.
    expect(onDisk[0]).toMatchObject({ id: 'S-1', number: 'R-S-1', cashierId: CASHIER, laneId: LANE, tradingDay, total: PRICE, netMinor: TAXABLE, taxMinor: GST });
    // Queued for head office as the cloud's contract, stamped by the BOX: the pulled pack's version and this shop as the stock location.
    expect(edge.outbox.unsentCount()).toBe(1);
    expect(edge.outbox.pending()[0]!.event.payload).toMatchObject({ saleId: 'S-1', packVersion: 1, locationId: STORE, cashierId: CASHIER, laneId: LANE, tradingDay, totalMinor: PRICE });
    expect((await call('GET', '/v1/sales/S-1', OWNER)).status).toBe(404);
    expect(await onHandAt(STORE)).toBe(10);

    // ── One pass of the real sync agent over real HTTP: the sale and the float reach head office; stock falls at the store.
    const pass1 = await edge.syncOnce!();
    expect(pass1).toMatchObject({ dead: 0, remaining: 0 });
    expect(pass1.sent).toBeGreaterThanOrEqual(2);
    expect((await call('GET', '/v1/sales/S-1', OWNER)).body).toMatchObject({ saleId: 'S-1', banked: true });
    expect(await onHandAt(STORE)).toBe(9);
    const valued = (await call('GET', `/v1/inventory/valuation?productId=${PRODUCT}`, OWNER)).body as { rows: { productId: string; value: { minor: number } }[]; totalValueMinor: number };
    expect(valued.totalValueMinor).toBe(9 * COST);

    // ── The refund, on the till: the bill looked up on this box, a manager's approval, cash back; synced, the stock returns.
    const bill = (await till.lookupRefund('R-S-1'))!;
    expect(bill).toMatchObject({ sale: { saleId: 'S-1', totalMinor: PRICE }, maxRefundMinor: PRICE }); // what was paid: the ₹480 shelf price
    const refunded = await bill.submit({
      returnId: 'RT-1', number: 'RT-0001', reasonCode: 'changed_mind',
      lines: [{ productId: PRODUCT, uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
      refundMinor: PRICE, refundTender: 'cash', approval: { by: MANAGER, reason: 'checked the goods' },
    });
    expect(refunded).toMatchObject({ kind: 'settled', refundMinor: PRICE });
    const pass2 = await edge.syncOnce!();
    expect(pass2).toMatchObject({ dead: 0, remaining: 0 });
    expect(await onHandAt(STORE)).toBe(10);
    expect(((await call('GET', `/v1/inventory/valuation?productId=${PRODUCT}`, OWNER)).body as { totalValueMinor: number }).totalValueMinor).toBe(10 * COST);

    // ── Cash: a pickup to the safe, then the blind close. 2,000 + 480 − 480 − 1,000 = ₹1,000 in the drawer.
    expect(await till.till.moveCash({ kind: 'pickup', amountMinor: 100_000, at: at(30), movementId: 'cm-pick' })).toMatchObject({ committed: true });
    expect(await till.till.close({ shiftId: 'sh-1', closedAt: at(60), countedMinor: 100_000 })).toMatchObject({ closed: true, varianceMinor: 0 });
    const pass3 = await edge.syncOnce!();
    expect(pass3).toMatchObject({ dead: 0, remaining: 0 });
    const cash = (await call('GET', `/v1/tills/${LANE}/cash`, OWNER)).body as { custodian: string | null; balanceMinor: number; flagged: unknown[] };
    expect(cash).toMatchObject({ balanceMinor: 100_000, flagged: [] });
    expect(((await call('GET', '/v1/shifts/over-short', OWNER)).body as { overShort: unknown[] }).overShort).toEqual([]);

    // ── Accounting: the accountant maps the books and posts the day; every journal balances; the return is in it.
    expect((await call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP, 'map-1')).status).toBeLessThan(300);
    const posted = await call('POST', `/v1/finance/day-book/${tradingDay}/post`, ACCT, undefined, `post-${tradingDay}`);
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    const day = posted.body as { journals: { kind: string; lines: { debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(day.exceptions).toEqual([]);
    expect(day.journals.map((j) => j.kind)).toEqual(expect.arrayContaining(['sale', 'tender:cash']));
    expect(day.journals.some((j) => /return|refund/.test(j.kind))).toBe(true);
    for (const j of day.journals) {
      const debits = j.lines.reduce((s, l) => s + l.debitMinor, 0);
      const credits = j.lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(debits, `journal ${j.kind} does not balance`).toBe(credits);
    }
    const read = (await call('GET', `/v1/finance/day-book/${tradingDay}`, ACCT)).body as { accounts: { accountCode: string; balanceMinor: number }[]; open: number };
    expect(read.open).toBe(0);
    // Sold and refunded in full: nothing left in sales clearing.
    expect(read.accounts.find((a) => a.accountCode === 'sales_clearing')?.balanceMinor ?? 0).toBe(0);

    // ── The owner's dashboard: "Sales today" is the SHOP's trading day — head office reads the shop's time zone and
    // cut-off from the setup answers above, the same rule the till dated the sale by (F14 FIXED). Unconditional.
    const dash = (await call('GET', '/v1/reports/dashboard', OWNER)).body as { figures: { name: string; valueMinor?: number }[] };
    expect(dash.figures.find((f) => f.name === 'Sales today')).toMatchObject({ valueMinor: PRICE });

    // ── Restart on the same disk: the pulled pack is restored, the served till still sells from it, nothing is re-sent.
    const dataDir = dirs[dirs.length - 1]!;
    await edges.splice(edges.indexOf(edge), 1)[0]!.stop();
    const rebooted = await startBox(cloud.token(BOX), dataDir);
    expect(rebooted.node.pack()?.snapshot.version).toBe(1);
    expect(await servedTillCatalogue(rebooted)).toMatchObject({ source: 'head_office', version: 1 });
    expect(rebooted.outbox.unsentCount()).toBe(0);
    expect(await rebooted.syncOnce!()).toMatchObject({ sent: 0, dead: 0, remaining: 0 });
    expect(await onHandAt(STORE)).toBe(10);
  }, 120_000);

  it('the same sale posted twice banks once; a box whose identity holds no sync right reaches nothing and loses nothing', async () => {
    const before = (await onHandAt(STORE))!;

    const edge = await startBox(cloud.token(BOX));
    await edge.refreshPack!();
    const served = (await servedTillCatalogue(edge))!;
    const till = bootPos({ laneId: LANE, catalogue: served, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    till.signIn(CASHIER);
    till.scanBarcode(BARCODE);
    const when = new Date().toISOString();
    expect(await till.tenderCash('S-2', 'R-S-2', when)).toBe('R-S-2');
    // The shell's retry shape: the SAME record posted again to the box's lane socket. One sale on the disk, one in the queue.
    const record = (await readLog(edge.log.path)).map((r) => (r as { record: string }).record)[0]!;
    const again = await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: record })).json() as { committed: boolean };
    expect(again.committed).toBe(true);
    expect((await readLog(edge.log.path))).toHaveLength(1);
    expect(edge.outbox.unsentCount()).toBe(1);
    const cloudPayload = edge.outbox.pending()[0]!.event.payload as Record<string, unknown>;
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    // …and a second pass, or the same cloud record re-sent to head office under a fresh key, adds no second movement.
    expect(await edge.syncOnce!()).toMatchObject({ sent: 0, dead: 0, remaining: 0 });
    const resent = await call('POST', '/v1/sales', BOX, cloudPayload, 'resend-S-2');
    expect(resent.status, JSON.stringify(resent.body)).toBeLessThan(300);
    expect((resent.body as { alreadyBanked?: boolean }).alreadyBanked).toBe(true);
    expect(await onHandAt(STORE)).toBe(before - 1);

    // A box whose identity is a known person with NO till authority (the accountant holds no `*.sync` and no pack read): the
    // pull is "offline" (never a pack), a sale it takes stays on its own disk and in its queue — visible, retried, never
    // dropped — and head office holds nothing from it.
    const stranger = await startBox(cloud.token(ACCT));
    expect((await stranger.refreshPack!()).status).toBe('offline');
    expect(await servedTillCatalogue(stranger)).toBeUndefined();
    const blind = bootPos({ laneId: LANE, catalogue: served, lanePort: stranger.lane!.port, tradingDayCutoff: '00:00' });
    blind.signIn(CASHIER);
    blind.scanBarcode(BARCODE);
    expect(await blind.tenderCash('S-3', 'R-S-3', new Date().toISOString())).toBe('R-S-3');
    const refused = await stranger.syncOnce!();
    expect(refused.sent).toBe(0);
    expect(refused.remaining + refused.dead).toBe(1);
    expect((await call('GET', '/v1/sales/S-3', OWNER)).status).toBe(404);
    expect(await onHandAt(STORE)).toBe(before - 1);
    // Nothing is lost: the record is still on the stranger's disk.
    expect(await readLog(stranger.log.path)).toHaveLength(1);
  }, 120_000);
});
