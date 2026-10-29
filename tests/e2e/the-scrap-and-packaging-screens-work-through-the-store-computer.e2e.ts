import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { theEvening, pinTheEveningClock, pinThePageClock } from '../support/evening-clock';

/**
 * **The Scrap and recycling page (M28-FR-02) and the Packaging and crates page (M28-FR-03) in a real browser, served by the
 * store computer, over head office's real routes (OB-380).**
 *
 * The real store computer serves the pages (as the person the front signed in); head office's API surface runs in memory and
 * every `/v1` call reaches it as that person, on the box's own origin. Through Chromium:
 *   • the owner records a cardboard sale with no evidence — head office records it (never refuses) and the review then
 *     shows the money, the weight, "not yet in the books" and the findings; marking it taken into the books clears that;
 *   • a branch-limited store manager may review but is not offered recording; another branch is refused in head office's
 *     words; the page speaks Tamil;
 *   • the manager registers a returnable crate, records 10 received and 12 sent out with deliveries — the position shows
 *     −2 on hand, NEGATIVE said in words (never clamped to zero), and 12 still out.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['salvage', 'screen', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner'; const MANAGER = 'u-mgr';
// The shop's own date, at an evening UTC moment (19:30 UTC — already tomorrow in the shop), pinned so the evening case is
// proven whenever this runs: the review's window is the shop's today, and the disposal recorded "now" must fall in it.
const EVENING = theEvening();
const TODAY = EVENING.shopDate;

describe.skipIf(!HAVE_BROWSER)('the Scrap and Packaging pages through the store computer (M28-FR-02 · M28-FR-03)', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    pinTheEveningClock(EVENING);
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager', ['store-1']);

    dir = await mkdtemp(join(tmpdir(), 'sre-salvage-screen-'));
    const packFile = join(dir, 'store-pack.json');
    const everything = [...new Set(['identity.self.read', 'scrap.sale.record', 'scrap.review.read', 'inventory.movement.append', ...ERP_NAVIGATION.map((i) => i.requires)])];
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [
        { id: 'owner', name: 'Owner', permissions: everything },
        { id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'scrap.review.read', 'inventory.availability.read', 'inventory.movement.append'] },
      ],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: MANAGER, roleId: 'manager', branchScope: ['store-1'] }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); vi.useRealTimers(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the box's origin as `who`; head office's API carried on that origin, as that person. */
  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    await pinThePageClock(context);
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const raw = req.postData();
      const answer = await ho.request({
        method: req.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        // A branch-limited person's own sign-in names their branch (as head office's identity server issues it).
        ...(who === MANAGER ? { branchId: 'store-1' } : {}),
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

  it('scrap: recorded without evidence (flagged, never refused), reviewed, marked into the books; a manager reviews only her branch', async () => {
    const { page: p, errors } = await open(OWNER, '/scrap/');
    await p.waitForSelector('#record:not([hidden])');
    expect(await p.inputValue('#v-from')).toBe(TODAY);
    expect(await p.inputValue('#s-by')).toBe(OWNER);
    await p.fill('#s-branch', 'store-1'); await p.selectOption('#s-category', 'cardboard'); await p.selectOption('#s-disposal', 'sold');
    await p.fill('#s-kg', '12.5'); await p.fill('#s-proceeds', '250');
    await p.click('#s-record');
    await says(p, '#s-status', /^Recorded at head office\. It is NOT in the books until finance takes it up/);

    await p.fill('#v-branch', 'store-1');
    await p.click('#v-show');
    await p.waitForSelector('#finding-rows li[data-flag="not_posted_to_finance"]');
    const figures = await p.textContent('#v-figures');
    expect(figures).toContain('Money₹250.00');
    expect(figures).toContain('Weight12.5 kg');
    expect(figures).toContain('Not yet in the books₹250.00');
    expect(await p.textContent('#finding-rows')).toContain('No evidence (slip, receipt or photograph)');
    expect(await p.textContent('#rate-rows')).toContain('Cardboard · ₹20,000.00 per tonne');

    await p.click('#finding-rows li[data-flag="not_posted_to_finance"] button[data-act="posted"]');
    await says(p, '#v-status', /^Marked as taken into the books\.$/);
    await says(p, '#v-figures', /Not yet in the books₹0\.00/);
    expect(await p.$$('#finding-rows li[data-flag="not_posted_to_finance"]')).toHaveLength(0);
    expect(errors).toEqual([]);

    const m = await open(MANAGER, '/scrap/');
    await m.page.waitForSelector('#review:not([hidden])');
    expect(await m.page.isHidden('#record'), 'a manager without scrap.sale.record is not offered recording').toBe(true);
    await m.page.fill('#v-branch', 'store-2');
    await m.page.click('#v-show');
    await says(m.page, '#v-status', /^Head office refused: /);
    await m.page.fill('#v-branch', 'store-1');
    await m.page.click('#v-show');
    await says(m.page, '#v-figures', /Disposals1/);
    await m.page.click('#lang');
    await says(m.page, '#review-h', /^ஒரு கிளையை மதிப்பாய்வு செய்$/);
    expect(m.errors).toEqual([]);
  });

  it('packaging: a returnable crate registered, received and sent out — the position shows negative as negative, and what is still out', async () => {
    const { page: p, errors } = await open(MANAGER, '/packaging/');
    await p.waitForSelector('#register:not([hidden])');
    await p.click('#q-show');
    await says(p, '#q-status', /^Write the item code and the branch code\.$/);

    await p.fill('#i-item', 'crate-blue'); await p.fill('#i-name', 'Blue crate'); await p.selectOption('#i-kind', 'reusable_crate');
    await p.check('#i-returnable'); await p.fill('#i-deposit', '50');
    await p.click('#i-save');
    await says(p, '#i-status', /^Saved at head office\.$/);

    const move = async (kind: string, qty: string): Promise<void> => {
      await p.fill('#m-item', 'crate-blue'); await p.fill('#m-branch', 'store-1'); await p.selectOption('#m-kind', kind); await p.fill('#m-qty', qty);
      await p.evaluate(() => { (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } } }).document.getElementById('m-status').textContent = ''; });
      await p.click('#m-record');
      await says(p, '#m-status', /^Recorded at head office\.$/);
    };
    await move('received', '10');
    await move('issued_to_delivery', '12');

    await p.fill('#q-item', 'crate-blue'); await p.fill('#q-branch', 'store-1');
    await p.click('#q-show');
    await p.waitForSelector('#q-figures [data-figure="onHand"]');
    expect(await p.textContent('#q-figures [data-figure="onHand"]')).toBe('Blue crate · On hand-2');
    expect(await p.textContent('#q-figures [data-figure="inCirculation"]')).toBe('Still out (not come back)12');
    expect(await p.isVisible('#q-negative')).toBe(true);
    expect(await p.textContent('#q-negative')).toMatch(/NEGATIVE — more went out than was ever recorded coming in/);

    // Another branch is refused by head office, in its words.
    await p.fill('#q-branch', 'store-2');
    await p.click('#q-show');
    await says(p, '#q-status', /^Head office refused: /);
    expect(errors).toEqual([]);
  });
});
