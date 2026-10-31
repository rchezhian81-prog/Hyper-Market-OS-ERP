import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { approvedSuppliers, deliveryPlaces } from '../support/approved-supplier';
import { buildStorePackSections } from '../../services/api/src/store-pack-builder';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Screen gap audit (31 Oct 2026) Round A — the office pages the audit found empty or contradictory, in a real browser,
 * served by a real store computer, over head office's real routes.**
 *
 * The store computer's setup is the pack head office BUILDS from its own records (`buildStorePackSections`) — built
 * before the order and the approval below exist, so the store computer's own figures are stale and only head office's
 * live answer can make Today right. Through Chromium, as the signed-in person:
 *   • Waste: the write-off head office committed at this store is listed (before: never sent, the page empty for ever);
 *   • Category rules: head office's category is listed, flagged "no rules in force" (before: never sent);
 *   • Checklists: a day with no checklists says "There are no checklists for today", never "Every checklist is signed";
 *   • Company report: a company with no open branch says so, and never "Every expected branch has reported";
 *   • Today: one approval waiting at head office and one open order are counted (before: 0 and 0), each tile saying where
 *     its number came from — and the approval is counted only for the person who may decide it (not the one who asked);
 *   • the three AI pages say, in English and Tamil, that the assistants are off until Release 8 (OB-561).
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const TENANT = randomUUID();
const OWNER = 'u-owner'; const MANAGER = 'u-mgr';
const STORE = 'store-1';
const TODAY = shopDateIn(new Date().toISOString());

describe.skipIf(!HAVE_BROWSER)('Round A — the office pages through the store computer', () => {
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
    await ho.provisionRole(TENANT, MANAGER, 'store_manager', [STORE]);
    const post = async (path: string, body: unknown, userId = OWNER): Promise<{ status: number; body: unknown }> => {
      const r = await ho.request({ method: 'POST', path, userId, tenantId: TENANT, ...(userId === OWNER ? {} : { branchId: STORE }), idempotencyKey: `k-${randomUUID()}`, body });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
      return r;
    };
    // Head office's records: a category, stock with a cost, and one write-off at this store.
    await post('/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null });
    await post('/v1/inventory/movements', { movementId: 'rcv-oil', productId: 'OIL', locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'each', occurredAt: `${TODAY}T03:00:00.000Z`, enteredBy: OWNER, unitCostMinor: 5_000 });
    await post('/v1/inventory/write-off/W-1', { productId: 'OIL', locationId: STORE, qty: 2, uom: 'each', lossType: 'damage', reasonCode: 'damage' }, MANAGER);

    // The store computer's setup, as head office builds it NOW (before the order and the approval exist).
    const sections = await buildStorePackSections({ store: ho.store, now: () => new Date().toISOString(), signer: undefined as never, settings: async () => undefined, storeName: async () => undefined }, TENANT, STORE);
    dir = await mkdtemp(join(tmpdir(), 'sre-round-a-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({ ...sections, version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '00:00', storeId: STORE, branchId: STORE } }), 'utf8');

    // After the pack: an open purchase order (proposed, waiting for its second person) and a category change the manager
    // asked for, waiting for the owner at head office.
    await approvedSuppliers(ho, TENANT, 'sup-1');
    await deliveryPlaces(ho, TENANT, STORE);
    await post('/v1/purchase/orders/po-1', { supplierId: 'sup-1', deliverToLocationId: STORE, lines: [{ productId: 'OIL', orderedQty: 5, unitCost: { minor: 5_000, currency: 'INR' } }] }, MANAGER);
    await post('/v1/approvals/requests', { kind: 'category_define', subjectRef: 'dairy', details: { categoryId: 'dairy', name: 'Dairy', parentId: null }, summary: 'Add the Dairy category', reason: 'new chiller', valueMinor: null }, MANAGER);

    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: TEST_PACK_KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
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
        ...(who === OWNER ? {} : { branchId: STORE }),
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
  ).catch(async (e: unknown) => {
    const seen = await page.evaluate((sel) => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector(sel)?.textContent ?? '(none)', selector);
    throw new Error(`${selector} never said ${pattern.source}; it says: ${JSON.stringify(seen)} (${String(e)})`);
  });

  it('Waste: head office\'s write-off at this store is listed, valued, with a true summary line', async () => {
    const { page, errors } = await open(MANAGER, '/waste');
    await says(page, '#rows', /OIL/);
    await says(page, '#total', /₹100\.00/);
    await says(page, '#attention-count', /^No material losses|needed approval$/);
    expect(await page.isHidden('#sample')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('Category rules: head office\'s category is listed and flagged "no rules in force"', async () => {
    const { page, errors } = await open(OWNER, '/category-policy');
    await says(page, '#rows', /grocery/);
    await says(page, '#rows', /No rules in force/);
    await says(page, '#attention-count', /^1 need attention$/);
    expect(errors).toEqual([]);
  });

  it('Checklists: a day with no checklists says so — never "every checklist is signed"; Tamil too', async () => {
    const { page, errors } = await open(OWNER, '/checklist/');
    await says(page, '#work-count', /There are no checklists for today/);
    expect(await page.textContent('#work-count')).not.toMatch(/Every checklist is signed/);
    await says(page, '#state-text', /There are no checklists for today/);
    await page.click('#lang');
    await says(page, '#work-count', /இன்றைக்கு எந்தச் சரிபார்ப்புப் பட்டியலும் இல்லை/);
    expect(errors).toEqual([]);
  });

  it('Company report: a company with no open branch says so, never "every expected branch has reported"', async () => {
    const { page, errors } = await open(OWNER, '/company-report');
    await says(page, '#missing', /no open branch under this company/);
    expect(await page.textContent('#missing')).not.toMatch(/Every expected branch has reported/);
    await says(page, '#reconcile', /Nothing to reconcile/);
    expect(errors).toEqual([]);
  });

  it('Today: the approval waiting at head office and the open order are counted, scoped to the person signed in', async () => {
    const { page, errors } = await open(OWNER, '/manager/');
    // The approvals tile: the store computer's own 0, plus the one waiting for the owner at head office.
    await page.waitForFunction(() => /1 waiting for you at head office/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } } }).document.getElementById('tiles').textContent ?? ''), undefined, { timeout: 15_000 });
    const approvalsTile = page.locator('#tiles .tile', { hasText: 'Approvals waiting' });
    expect((await approvalsTile.locator('.n').textContent())?.trim()).toBe('1');
    await says(page, '#attention', /approvals waiting for you at head office/);
    // The open order: head office's, waiting for its second person — not the stale pack's 0.
    const po = page.locator('li', { hasText: 'Purchase orders open' }).first();
    expect((await po.locator('.n').textContent())?.trim()).toBe('1');
    expect(await po.textContent()).toMatch(/waiting for a second person's approval/);
    expect(errors).toEqual([]);

    // Scoped to the person: the manager ASKED for the category change, so it is not his to decide — head office shows him
    // none waiting (never his own request), while the open order is counted for him too.
    const mgr = await open(MANAGER, '/manager/');
    await mgr.page.waitForFunction(() => /0 waiting for you at head office/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } } }).document.getElementById('tiles').textContent ?? ''), undefined, { timeout: 15_000 });
    expect((await mgr.page.locator('li', { hasText: 'Purchase orders open' }).first().locator('.n').textContent())?.trim()).toBe('1');
    expect(mgr.errors).toEqual([]);
  });

  it('the AI pages say the assistants are off until Release 8, in English and Tamil (OB-561)', async () => {
    for (const path of ['/ai-drafts', '/service-desk', '/ai/']) {
      const { page, errors } = await open(OWNER, path);
      await says(page, '#off-r8', /off until Release 8/);
      await page.click('#lang');
      await says(page, '#off-r8', /வெளியீடு 8 வரை/);
      expect(errors, path).toEqual([]);
    }
  });
});
