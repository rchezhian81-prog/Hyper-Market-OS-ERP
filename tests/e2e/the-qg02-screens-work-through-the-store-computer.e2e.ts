import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * **The four QG-02 screens in a real browser, served by the store computer, over head office's real routes (lane 1 R4 ·
 * M07-FR-01 · M06-FR-02 · M05-FR-04 · M01-FR-03 · OB-380).**
 *
 * The real store computer serves each page (as the person the front signed in); head office's API surface runs in memory
 * and every `/v1` call reaches it as that person, on the box's own origin. Through Chromium:
 *   • DOCK DIARY — a door is booked for a supplier; an overlapping booking on the same door is refused in head office's
 *     words; the day lists the booking, which is marked arrived and then done; Tamil;
 *   • STANDING ORDERS — a buyer proposes an agreement (products at agreed prices, a ceiling, dates); the buyer is not offered
 *     an approval (and head office would refuse it); a second person approves it with a reason; it is in force, with what
 *     is left of its ceiling;
 *   • SUPPLIER OFFER FUNDING — an agreement recorded with no Finance approval is said to be flagged; the register shows the
 *     line and its findings by exception (not approved by Finance; the books cannot agree until the money is mapped);
 *   • FEATURE SWITCHES — an ordinary switch previewed and saved with a reason (version 1), turned off (version 2), and rolled
 *     back to version 1 as version 3; a payments switch is previewed as high-impact and refused without the owner's
 *     approval, in head office's words.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['qg02', 'screens', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner';
const BUYER = 'u-buyer';
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!HAVE_BROWSER)('the QG-02 screens through the store computer (lane 1 R4)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await approvedSuppliers(ho, TENANT, 'sup-rice');
    await deliveryPlaces(ho, TENANT, 'store-1');
    await ho.provisionRole(TENANT, BUYER, 'store_manager');
    // One offer for the funding page: a product and the offer's definition (synthetic).
    const post = (path: string, body: unknown) => ho.request({ method: 'POST', path, userId: OWNER, tenantId: TENANT, idempotencyKey: `seed-${randomUUID()}`, body });
    const product = await post('/v1/catalogue/products/soap-a/publish', { product: { sku: 'SKU-SOAP-A', name: 'Soap A', baseUom: 'each', primaryCategoryId: 'home', taxClass: '3401', lifecycle: 'active' }, categories: [{ categoryId: 'home', name: 'Home care', parentId: null }] });
    if (product.status !== 201) throw new Error(`product: ${JSON.stringify(product.body)}`);
    const offer = await post('/v1/promotions/mb-soap/definition', { startsAt: new Date(Date.now() - 86_400_000).toISOString(), endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), kind: 'multibuy', productIds: ['soap-a'], multibuyQty: 3, multibuyPriceMinor: 9_900 });
    if (offer.status !== 201) throw new Error(`offer: ${JSON.stringify(offer.body)}`);

    dir = await mkdtemp(join(tmpdir(), 'sre-qg02-screens-'));
    const packFile = join(dir, 'store-pack.json');
    const everything = [...new Set(['identity.self.read', 'inventory.movement.append', 'purchase.order.propose', 'purchase.order.approve', 'promotion.launch', 'finance.journal.post', 'platform.flag.write', ...ERP_NAVIGATION.map((i) => i.requires)])];
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [{ id: 'owner', name: 'Owner', permissions: everything }, { id: 'buyer', name: 'Buyer', permissions: ['identity.self.read', 'purchase.commitment.read', 'purchase.order.propose'] }],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: BUYER, roleId: 'buyer', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the box's origin as `who`; head office's API carried on that origin, as that person. */
  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(req.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: req.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    expect(res?.status(), `${path} is served by the store computer`).toBe(200);
    return { page, errors };
  };
  const says = (page: Page, selector: string, pattern: RegExp): Promise<unknown> => page.waitForFunction(
    ([sel, src]) => new RegExp(src!).test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel!)?.textContent ?? ''),
    [selector, pattern.source], { timeout: 15_000 },
  );

  it('Dock diary: book a door, an overlap refused, arrived then done — and in Tamil', async () => {
    const { page, errors } = await open(OWNER, '/dock-diary/');
    await page.waitForSelector('#book:not([hidden])');
    const d = day(1);
    await page.fill('#b-store', 'store-1'); await page.fill('#b-door', 'dock-1');
    await page.fill('#b-from', `${d}T10:00`); await page.fill('#b-until', `${d}T11:00`);
    await page.fill('#b-supplier', 'sup-rice'); await page.fill('#b-orders', 'PO-7');
    await page.click('#b-book');
    await says(page, '#b-status', /^Booked\.$/);
    await page.fill('#b-from', `${d}T10:30`); await page.fill('#b-until', `${d}T11:30`);
    await page.click('#b-book');
    await says(page, '#b-status', /^Head office refused: /);
    await page.fill('#d-store', 'store-1'); await page.fill('#d-date', d);
    await page.click('#d-show');
    await page.waitForSelector('#day-rows li[data-status="booked"]');
    expect(await page.textContent('#day-rows li[data-status="booked"]')).toMatch(/Door dock-1 .* Booked/);
    expect(await page.textContent('#day-rows li[data-status="booked"]')).toContain('Supplier: sup-rice · PO-7');
    await page.click('#day-rows li[data-status="booked"] button[data-act="arrived"]');
    await page.waitForSelector('#day-rows li[data-status="arrived"]');
    await page.click('#day-rows li[data-status="arrived"] button[data-act="completed"]');
    await page.waitForSelector('#day-rows li[data-status="completed"]');
    expect(await page.$$('#day-rows li[data-status="completed"] button')).toHaveLength(0);
    await page.click('#lang');
    await says(page, '#book-h', /^வாசலை முன்பதிவு செய்$/);
    expect(errors).toEqual([]);
  });

  it('Standing orders: a buyer proposes; the buyer is offered no approval; a second person approves with a reason', async () => {
    const buyer = await open(BUYER, '/blanket-orders/');
    await buyer.page.waitForSelector('#propose:not([hidden])');
    await buyer.page.fill('#p-supplier', 'sup-rice'); await buyer.page.fill('#p-ceiling', '10,000');
    await buyer.page.fill('#p-from', day(-1)); await buyer.page.fill('#p-to', day(90)); await buyer.page.fill('#p-deliver', 'store-1');
    await buyer.page.fill('#p-lines', 'rice-5kg, 400, 20\ndal-1kg, 120');
    await buyer.page.click('#p-propose');
    await says(buyer.page, '#p-status', /^Done — head office recorded it\.$/);
    await buyer.page.waitForSelector('#list-rows li[data-status="proposed"]');
    expect(await buyer.page.textContent('#list-rows li[data-status="proposed"]')).toContain('Proposed — not approved yet');
    expect(await buyer.page.$$('#list-rows button[data-act="approve"]'), 'the proposer is offered no approval').toHaveLength(0);

    const owner = await open(OWNER, '/blanket-orders/');
    await owner.page.click('#l-show');
    await owner.page.waitForSelector('#list-rows li[data-status="proposed"] button[data-act="approve"]');
    await owner.page.click('#list-rows li[data-status="proposed"] button[data-act="approve"]');
    await says(owner.page, '#l-status', /^Write why you approve first\.$/);
    await owner.page.fill('#list-rows li[data-status="proposed"] input.approve-why', 'annual rice and dal terms agreed');
    await owner.page.click('#list-rows li[data-status="proposed"] button[data-act="approve"]');
    await owner.page.waitForSelector('#list-rows li[data-status="approved"]');
    const row = await owner.page.textContent('#list-rows li[data-status="approved"]');
    expect(row).toContain('In force today');
    expect(row).toContain('Ceiling ₹10,000.00');
    expect(row).toContain('Left ₹10,000.00');
    expect(row).toContain('proposed by u-buyer · approved by u-owner');
    expect(row).toContain('Product rice-5kg @ ₹400.00 · Called off 0 / Most 20 · 20 left');
    expect(buyer.errors).toEqual([]); expect(owner.errors).toEqual([]);
  });

  it('Supplier offer funding: recorded without Finance\'s approval is flagged, and the register shows it by exception', async () => {
    const { page, errors } = await open(OWNER, '/promotion-funding/');
    await page.waitForSelector('#agree:not([hidden])');
    await page.click('#r-show');
    await says(page, '#register-rows', /No supplier funds an offer yet\./);
    await page.fill('#a-offer', 'no-such-offer'); await page.fill('#a-supplier', 'sup-soap'); await page.fill('#a-rate', '5');
    await page.click('#a-record');
    await says(page, '#a-status', /^Head office refused: /);
    await page.fill('#a-offer', 'mb-soap'); await page.fill('#a-cap', '100');
    await page.click('#a-record');
    await says(page, '#a-status', /^Recorded — flagged "not approved" until Finance approves it\.$/);
    await page.waitForSelector('#register-rows li[data-offer="mb-soap"]');
    const line = await page.textContent('#register-rows li[data-offer="mb-soap"]');
    expect(line).toContain('₹5.00 A unit · Cap ₹100.00');
    expect(line).toContain('Units sold under the offer: 0');
    expect(line).toContain('⚠ Not approved by Finance');
    expect(await page.textContent('#r-from')).toContain('names no income account');
    expect(errors).toEqual([]);
  });

  it('Feature switches: preview, save with a reason, turn off, roll back — and a payments switch needs the owner\'s approval', async () => {
    const { page, errors } = await open(OWNER, '/switches/');
    await page.waitForSelector('#change:not([hidden])');
    await page.fill('#ch-key', 'offers.festive_banner');
    await page.click('#ch-preview');
    await says(page, '#ch-said', /^Now: not set \(off\) becomes On\. An ordinary switch/);
    await page.click('#ch-save');
    await says(page, '#ch-status', /^Write why first/);
    await page.fill('#ch-reason', 'Diwali week');
    await page.click('#ch-save');
    await says(page, '#ch-status', /^Saved — a new version\.$/);
    await page.waitForSelector('#history-rows li[data-version="1"]');
    await page.selectOption('#ch-state', 'off'); await page.fill('#ch-reason', 'festival over');
    await page.click('#ch-save');
    await page.waitForSelector('#history-rows li[data-version="2"]');
    expect(await page.getAttribute('#board-rows li[data-key="offers.festive_banner"]', 'data-state')).toBe('false');
    await page.fill('#history-rows li[data-version="1"] input.back-why', 'one more weekend');
    await page.click('#history-rows li[data-version="1"] button[data-act="back"]');
    await page.waitForSelector('#history-rows li[data-version="3"]');
    expect(await page.textContent('#history-rows li[data-version="3"]')).toContain('restored version 1');
    await page.waitForSelector('#board-rows li[data-key="offers.festive_banner"][data-state="true"]');

    await page.fill('#ch-key', 'payments.upi_intent'); await page.selectOption('#ch-state', 'on');
    await page.click('#ch-preview');
    await says(page, '#ch-said', /High-impact: the owner must approve exactly this change first/);
    await page.fill('#ch-reason', 'try the new UPI flow');
    await page.click('#ch-save');
    await says(page, '#ch-status', /^Head office refused: Switch payments\.upi_intent is high-impact/);
    expect(errors).toEqual([]);
  });
});
