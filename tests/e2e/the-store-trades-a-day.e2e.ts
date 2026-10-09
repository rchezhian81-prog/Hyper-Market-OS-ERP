import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen, pinOf } from '../support/till-operator';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { makeTradingDayRule, tradingDateOf } from '../../packages/calendar/src/trading-day';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **The store trades a day in a REAL browser, on the REAL cloud, over REAL PostgreSQL, through the REAL box (SP-9-i · W10).**
 *
 * The integration suite of the same name drives the till's session model from Node. This one opens the SERVED till in
 * headless Chromium — the shell the cashier actually uses, built from this branch — on a box that pulled its catalogue
 * from the production API assembly running against a real database, and does what a cashier does: signs in, takes the
 * float from the More sheet, scans the barcode as a scanner would (keystrokes + Enter), takes cash, refunds the bill
 * through the shell's refund surface, banks a pickup, reloads the page, counts the drawer blind and closes. After each
 * leg the box syncs and the cloud is read back: the sale banked, stock down then up again at the store, the cash chain and
 * no over/short, the day book posted and balanced. Then the box restarts and the till still sells from head office's pack.
 *
 * Synthetic data, a fresh random tenant. Needs DATABASE_URL AND the pre-installed Chromium; without either it SKIPS
 * (the CI job has the database and no browser, so the integration twin is the CI-run proof and this is the browser one).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['browser', 'trades', 'a', 'day', 'signing', 'key'].join('-').padEnd(48, '0');
const STORE = 'S1';
const LANE = 'lane-1';
const OWNER = 'u-owner';
const BOX = 'u-box';
const CASHIER = 'u-meena';
const MANAGER = 'u-manager';
const ACCT = 'u-acct';
const PRODUCT = 'p-rice';
const BARCODE = '8901234567890';
const PRICE = 48_000;   // the shelf price head office published — the 5% GST INSIDE it (A9); what the customer pays (F15 fixed)
const COST = 40_000;

interface RefundOutcome { readonly kind: string; readonly laneMessage: string; readonly refundMinor?: number }
interface RefundLookup { readonly maxRefundMinor: number; submit(draft: unknown): Promise<RefundOutcome> }
interface PosWindow {
  readonly posCatalogue?: { readonly version: number; readonly source?: string; readonly products: { productId: string }[] };
  readonly posSession?: {
    hasCatalogue(): boolean;
    operator(): string | undefined;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    /** The next receipt number, from the store computer (audit PF-04). */
    nextReceipt(): Promise<string>;
    newSale(): void;
    lookupRefund(receipt: string): Promise<RefundLookup | null>;
    approveAtTill(r: { managerId: string; pin: string; kind: 'refund'; billRef: string; valueMinor: number; reason: string }): Promise<{ approved: boolean; approvalId?: string; laneMessage?: string }>;
  };
}

describe.skipIf(!HAVE_BROWSER || !DATABASE_URL)('the store trades a day in a real browser, connected to the real cloud (SP-9-i · W10)', () => {
  let browser: Browser;
  let cloud: RealCloud;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string) =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const onHandAt = async (locationId: string): Promise<number | undefined> => {
    const r = await call('GET', `/v1/inventory/availability?productId=${PRODUCT}`, OWNER);
    return (r.body as { rows: { locationId: string; onHandMinor: number }[] }).rows.find((row) => row.locationId === locationId)?.onHandMinor;
  };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    for (const [who, role] of [[BOX, 'cashier'], [CASHIER, 'cashier'], [MANAGER, 'store_manager'], [ACCT, 'accountant']] as const) await cloud.grant(who, role);
    const today = new Date().toISOString().slice(0, 10);
    expect((await call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax-1006')).status).toBeLessThan(300);
    expect((await call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
      product: { sku: 'RICE-5KG', name: 'Ponni rice 5kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, `publish-${PRODUCT}`)).status).toBeLessThan(300);
    expect((await call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: PRICE, mrpMinor: 50_000, costMinor: COST, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
    }, `price-${PRODUCT}`)).status).toBeLessThan(300);
    expect((await call('POST', `/v1/catalogue/products/${PRODUCT}/barcodes/${BARCODE}`, OWNER, { kind: 'ean' }, `barcode-${PRODUCT}`)).status).toBeLessThan(300);
    expect((await call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1')).status).toBe(201);
    expect((await call('POST', '/v1/inventory/movements', OWNER, {
      movementId: 'mv-opening', productId: PRODUCT, locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'ea',
      occurredAt: `${today}T00:30:00.000Z`, enteredBy: OWNER, unitCostMinor: COST,
    }, 'mv-opening')).status).toBe(202);
  }, 180_000);
  afterAll(async () => { await browser?.close(); await cloud?.stop(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** The box exactly as a one-PC install runs it: the lane socket on the port the shell posts to, a policies-only pack file, head office configured. */
  async function startBox(dir?: string): Promise<EdgeProcess> {
    const dataDir = dir ?? await mkdtemp(join(tmpdir(), 'sre-browser-trades-'));
    if (dir === undefined) dirs.push(dataDir);
    // The policies, and the cashier named with till authority — her till PIN issued on this box (ADR-0020).
    const { EDGE_PACK_FILE: packFile } = await prepareTillBox({
      dir: dataDir, key: KEY, people: [{ userId: CASHIER, displayName: 'Meena' }, { userId: MANAGER, displayName: 'Manager', manager: true }],
      pack: {
        policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
        lossPreventionRules: [],
      },
    });
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '8090', EDGE_LANE_ID: LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: cloud.baseUrl, CLOUD_API_TOKEN: cloud.token(BOX),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  }

  const keyAmount = async (page: Page, rupees: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of rupees) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
  };
  const shown = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const title = (await page.textContent('#refusal-title')) ?? '';
    const text = (await page.textContent('#refusal-text')) ?? '';
    await page.click('#refusal-ok');
    return { title, text };
  };
  const moreOffers = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, label: string): Promise<void> => { await page.click(`#pay-kinds button:text-is("${label}")`); };

  it('publish → pull → the served till sells by barcode → sync → stock falls → refund on the till → stock back → float, pickup, reload, blind close → cash office + day book agree → restart keeps head office\'s pack', async () => {
    expect(await onHandAt(STORE)).toBe(10);
    const edge = await startBox();
    expect(edge.lane?.port).toBe(8090);
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: 1 });

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const open = async (base: string): Promise<void> => {
      await page.goto(`${base}/pos/`, { waitUntil: 'load' });
      await page.waitForFunction(() => {
        const w = globalThis as unknown as PosWindow;
        return w.posSession !== undefined && w.posSession.hasCatalogue();
      }, undefined, { timeout: 15_000 });
    };
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    await open(base);
    // The shell boots from head office's catalogue — the pulled pack, not a file (F13).
    expect(await page.evaluate(() => { const c = (globalThis as unknown as PosWindow).posCatalogue!; return { version: c.version, source: c.source, products: c.products.map((p) => p.productId) }; }))
      .toEqual({ version: 1, source: 'head_office', products: [PRODUCT] });

    await signInThroughScreen(page, CASHIER); // staff ID, then the till PIN — checked by the box (ADR-0020)

    // Float, then the sale by barcode — keystrokes and Enter, as a scanner does — then exact cash.
    expect(await moreOffers(page)).toEqual(['Take float (open the till)', 'Refund', 'Exchange']);
    await choose(page, 'Take float (open the till)');
    await keyAmount(page, '2000');
    expect(await shown(page)).toMatchObject({ title: 'Float taken — the till is open' });
    // Dated NOW, like the float and the close the shell itself dates: the box counts the cash a shift took between its float
    // and its close, so a sale stamped ahead of the clock would simply not be in the drawer it expects.
    const soldAt = new Date().toISOString();
    const tradingDay = tradingDateOf(soldAt, makeTradingDayRule('00:00'));
    await page.keyboard.type(BARCODE);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    expect(await page.textContent('#total')).toBe('₹480.00'); // the shelf price — never the price plus GST (F15 fixed), never above the ₹500 MRP
    // The bill's number comes from this box (audit PF-04).
    const receipt = await page.evaluate(async ([when]) => {
      const w = globalThis as unknown as PosWindow;
      const r = await w.posSession!.tenderCash('S-1', await w.posSession!.nextReceipt(), when!);
      w.posSession!.newSale();
      return r;
    }, [soldAt]);
    expect(receipt).toBe('R-lane-1-000001');
    expect(edge.outbox.unsentCount()).toBe(1);
    expect((await call('GET', '/v1/sales/S-1', OWNER)).status).toBe(404);

    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect((await call('GET', '/v1/sales/S-1', OWNER)).body).toMatchObject({ saleId: 'S-1', banked: true });
    expect(await onHandAt(STORE)).toBe(9);

    // The refund through the shell's own refund surface: the bill from this box, a manager's approval, cash back.
    // The manager approves at the till with their own PIN, for this bill and this amount (ADR-0021).
    const refunded = await page.evaluate(async ([manager, managerPin]) => {
      const w = globalThis as unknown as PosWindow;
      const bill = await w.posSession!.lookupRefund('R-lane-1-000001');
      if (bill === null) return { kind: 'not_found' } as RefundOutcome;
      const approved = await w.posSession!.approveAtTill({ managerId: manager!, pin: managerPin!, kind: 'refund', billRef: 'S-1', valueMinor: 48_000, reason: 'checked the goods' });
      if (!approved.approved) return { kind: 'approval_refused', laneMessage: approved.laneMessage } as unknown as RefundOutcome;
      return bill.submit({
        returnId: 'RT-1', number: await w.posSession!.nextReceipt(), reasonCode: 'changed_mind',
        lines: [{ productId: 'p-rice', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
        refundMinor: 48_000, refundTender: 'cash', approval: { by: manager!, reason: 'checked the goods', approvalId: approved.approvalId },
      });
    }, [MANAGER, pinOf(MANAGER)]);
    expect(refunded).toMatchObject({ kind: 'settled', refundMinor: PRICE });
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect(await onHandAt(STORE)).toBe(10);

    // A pickup, a reload (the browser forgets; the box remembers the float is out), then the blind close: 2,000 + 480 − 480 − 1,000 = ₹1,000.
    expect(await moreOffers(page)).toEqual(['Cash to safe', 'Refund', 'Exchange', 'Close till']);
    await choose(page, 'Cash to safe');
    await keyAmount(page, '1000');
    expect(await shown(page)).toMatchObject({ title: 'Moved to the safe' });
    await open(base);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-meena');
    expect(await moreOffers(page)).toEqual(['Cash to safe', 'Refund', 'Exchange', 'Close till']);
    await choose(page, 'Close till');
    await page.waitForSelector('#count:not([hidden])');
    expect(await page.textContent('#count')).not.toMatch(/expected|1,000/);
    for (let i = 0; i < 2; i += 1) await page.click('button[aria-label="one more ₹500.00"]');
    expect(await page.textContent('#count-total')).toContain('₹1,000.00');
    await page.click('#count-ok');
    expect(await shown(page)).toMatchObject({ title: 'The drawer balances exactly.' });
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect((await call('GET', `/v1/tills/${LANE}/cash`, OWNER)).body).toMatchObject({ balanceMinor: 100_000, flagged: [] });
    expect(((await call('GET', '/v1/shifts/over-short', OWNER)).body as { overShort: unknown[] }).overShort).toEqual([]);

    // The accountant posts the day: every journal balances, nothing left open.
    expect((await call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP, 'map-1')).status).toBeLessThan(300);
    const posted = await call('POST', `/v1/finance/day-book/${tradingDay}/post`, ACCT, undefined, `post-${tradingDay}`);
    expect(posted.status).toBeLessThan(300);
    const day = posted.body as { journals: { kind: string; lines: { debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(day.exceptions).toEqual([]);
    expect(day.journals.length).toBeGreaterThanOrEqual(2);
    for (const j of day.journals) {
      expect(j.lines.reduce((s, l) => s + l.debitMinor, 0), `journal ${j.kind}`).toBe(j.lines.reduce((s, l) => s + l.creditMinor, 0));
    }

    // Restart the box on the same disk: head office's pack restored, the served till sells from it, nothing re-sent.
    const dataDir = dirs[0]!;
    await edge.stop();
    stops.splice(0, 1); // the first entry was this box's stop; it has run
    const rebooted = await startBox(dataDir);
    expect(rebooted.node.pack()?.snapshot.version).toBe(1);
    await open(`http://127.0.0.1:${rebooted.screens!.port}`);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posCatalogue!.source)).toBe('head_office');
    expect(await rebooted.syncOnce!()).toMatchObject({ sent: 0, dead: 0, remaining: 0 });
    expect(errors).toEqual([]);
  }, 180_000);
});
