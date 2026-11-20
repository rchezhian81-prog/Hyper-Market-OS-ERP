import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { apiHarness, type ApiHarness } from '../support/api-harness';

/**
 * **C-7 (15 Nov pilot audit · M03-FR-02 · batch 20d) — in a real browser, on the office pages the store computer serves, over
 * head office's REAL routes and approval engine.**
 *   • The store manager opens Product details → Barcodes and packs: each barcode has "Remove" and "Move to another item". He
 *     moves a wrongly keyed code to the right item with a reason; the page says nothing has changed yet; head office still
 *     has it on the old item. On an item's ONLY barcode the page warns that the tills could then not sell it by scanning;
 *     unticked, head office refuses in plain words; ticked, it is sent.
 *   • The owner opens Approvals: the move waits with the before and the after; he approves; head office makes it.
 *   • Product details then shows the barcode on the right item, and the old item's barcode history keeps the old link: moved,
 *     by whom, approved by whom, why. In Tamil too.
 * Synthetic data only. Without a browser binary it SKIPS. With C7_SHOTS set, screenshots are written there.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['C7_SHOTS'];
const KEY = ['c7', 'catalogue', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner';
const MANAGER = 'u-mgr';
const OWNER_WORDS = ['identity.self.read', 'catalogue.pack.read', 'catalogue.pack.publish', 'catalogue.tax.approve', 'catalogue.change.propose', 'org.branch.read'];
const MANAGER_WORDS = ['identity.self.read', 'catalogue.pack.read', 'catalogue.change.propose', 'org.branch.read'];

type Doc = { document: { getElementById(id: string): { textContent: string | null } | null } };

describe.skipIf(!HAVE_BROWSER)('C-7: a wrongly keyed barcode is moved on Product details and approved on Approvals', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER) =>
    ho.request({ method, path, userId, tenantId: TENANT, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const ok = async (p: ReturnType<typeof req>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  const ownerOf = async (code: string) => { const r = await req('GET', `/v1/catalogue/barcodes/${code}`); return r.status === 200 ? (r.body as { barcode: { productId: string } }).barcode.productId : undefined; };
  const shot = async (page: Page, name: string) => { if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); } };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager');
    await ok(req('POST', '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null }), 'category');
    for (const [id, name, codes] of [['SALT', 'Synthetic Salt 1kg', ['C7-SALT', 'C7-WRONG']], ['SUGAR', 'Synthetic Sugar 1kg', ['C7-SUGAR']], ['OIL', 'Synthetic Oil 1L', ['C7-OIL']]] as const) {
      await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: { sku: `SKU-${id}`, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active', mrpHistory: [{ value: { minor: 2_800, currency: 'INR' }, effectiveFrom: '2026-01-01' }] } }), `publish ${id}`);
      for (const code of codes) await ok(req('POST', `/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'internal' }), `barcode ${code}`);
    }

    dir = await mkdtemp(join(tmpdir(), 'sre-c7-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
      roles: [{ id: 'owner', name: 'Owner', permissions: OWNER_WORDS }, { id: 'manager', name: 'Store manager', permissions: MANAGER_WORDS }],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: MANAGER, roleId: 'manager', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the box's origin as `who`; head office's API carried on that origin as that person. */
  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-sre-user': who } });
    stops.push(() => context.close());
    await context.route('**/v1/**', async (route) => {
      const r = route.request();
      const url = new URL(r.url());
      const raw = r.postData();
      const answer = await ho.request({
        method: r.method() as 'GET', path: url.pathname, userId: who, tenantId: TENANT,
        ...(raw === null ? {} : { body: JSON.parse(raw) as unknown }),
        ...(r.headers()['idempotency-key'] === undefined ? {} : { idempotencyKey: r.headers()['idempotency-key'] }),
        ...(url.search === '' ? {} : { query: Object.fromEntries(url.searchParams) }),
      });
      await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body ?? {}) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    return { page, errors };
  };
  const says = async (page: Page, id: string, re: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([el, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.getElementById(el!)?.textContent ?? ''), [id, re.source] as const);
    } catch {
      throw new Error(`#${id} says ${JSON.stringify(await page.textContent(`#${id}`))}, not ${String(re)}`);
    }
  };

  it('the manager moves a wrong code (nothing changes yet), is warned on an only barcode; the owner approves; the history keeps the old link', async () => {
    const m = await open(MANAGER, '/product-details/?product=SALT');
    await says(m.page, 'result', /^You can propose changes to this product\./);
    await m.page.click('#tab-codes');
    const wrong = m.page.locator('#barcode-list li[data-code="C7-WRONG"]');
    await wrong.waitFor();
    expect(await wrong.locator('button.u-remove').innerText()).toBe('Remove');
    await wrong.locator('button.u-move').click();
    await says(m.page, 'unlink-h', /^Move barcode C7-WRONG to the right item$/);
    await says(m.page, 'unlink-lead', /^A second person approves this on the Approvals page before anything changes\. The tills get it with their next price update — never in the middle of a bill/);
    expect(await m.page.isHidden('#u-only')).toBe(true); // not its only barcode: no warning
    await m.page.click('#u-send');
    await says(m.page, 'unlink-status', /^Pick the item the barcode belongs on\.$/);
    await m.page.fill('#u-to', 'SUGAR');
    await m.page.click('#u-send');
    await says(m.page, 'unlink-status', /^Write the reason first\.$/);
    await m.page.fill('#u-why', 'keyed on salt by mistake; it is printed on the sugar pack (synthetic)');
    await shot(m.page, 'c7-1-move-a-barcode-en');
    await m.page.click('#u-send');
    await says(m.page, 'codes-status', /^Sent for approval\. Nothing has changed yet — the barcode stays on this item until a second person approves it/);
    expect(await m.page.isHidden('#unlink-box')).toBe(true);
    expect(await ownerOf('C7-WRONG')).toBe('SALT');

    // An item's only barcode: warned; unticked, head office refuses in plain words; ticked, it is sent.
    await m.page.fill('#product', 'OIL'); await m.page.click('#show');
    await m.page.click('#tab-codes');
    await m.page.locator('#barcode-list li[data-code="C7-OIL"] button.u-remove').click();
    await says(m.page, 'u-only', /^This is the only barcode on this item\. Without it the tills cannot sell it by scanning — only by finding it by name\.$/);
    expect(await m.page.isVisible('#u-leave')).toBe(true);
    await m.page.fill('#u-why', 'the code belongs to another brand (synthetic)');
    await m.page.click('#u-send');
    await says(m.page, 'unlink-status', /only barcode on Synthetic Oil 1L/);
    await m.page.check('#u-leave');
    await m.page.click('#lang');
    await says(m.page, 'u-send', /^ஒப்புதலுக்கு அனுப்பு$/);
    await says(m.page, 'u-only', /^இந்தப் பொருளில் உள்ள ஒரே பார்கோடு இதுதான்\./);
    await shot(m.page, 'c7-2-only-barcode-warning-ta');
    await m.page.click('#u-send');
    await says(m.page, 'codes-status', /^ஒப்புதலுக்கு அனுப்பப்பட்டது\./);
    await m.page.click('#lang');
    expect(await ownerOf('C7-OIL')).toBe('OIL');
    expect(m.errors).toEqual([]);

    // The owner's Approvals page: the move waits with the before and the after; he approves; head office makes it.
    const o = await open(OWNER, '/approvals/');
    const row = o.page.locator('#waiting li', { hasText: 'Move barcode C7-WRONG' });
    await row.waitFor();
    await expect.poll(() => row.innerText()).toMatch(/Barcode moved: C7-WRONG on Synthetic Salt 1kg \(SALT\) → C7-WRONG on Synthetic Sugar 1kg \(SUGAR\)/);
    await expect.poll(() => row.innerText()).toMatch(/Barcodes of the other item: C7-SUGAR → C7-SUGAR, C7-WRONG/);
    const onlyRow = o.page.locator('#waiting li', { hasText: 'Remove barcode C7-OIL' });
    await expect.poll(() => onlyRow.innerText()).toMatch(/Warning: no barcode left: nothing → Synthetic Oil 1L will have no barcode/);
    await shot(o.page, 'c7-3-approvals-en');
    await row.locator('input.reason').fill('checked the sugar pack (synthetic)');
    await row.locator('button.approve').click();
    await says(o.page, 'result-text', /^Approved\. Head office has made the change\.$/);
    expect(await ownerOf('C7-WRONG')).toBe('SUGAR');
    expect(o.errors).toEqual([]);

    // Product details now: the code is on sugar; salt's history keeps the old link, who and why.
    const after = await open(MANAGER, '/product-details/?product=SALT');
    await after.page.click('#tab-codes');
    await after.page.locator('#barcode-list li[data-code="C7-SALT"]').waitFor();
    expect(await after.page.locator('#barcode-list li[data-code="C7-WRONG"]').count()).toBe(0);
    const moved = after.page.locator('#barcode-history li[data-what="moved_away"]');
    await expect.poll(() => moved.innerText()).toMatch(/^C7-WRONG moved to Synthetic Sugar 1kg \(SUGAR\) · .+ · proposed by u-mgr, approved by u-owner · why: keyed on salt by mistake; it is printed on the sugar pack \(synthetic\)$/);
    await expect.poll(() => after.page.locator('#barcode-history li[data-code="C7-SALT"]').innerText()).toMatch(/on this item now$/);
    await shot(after.page, 'c7-4-history-en');
    await after.page.click('#lang');
    await says(after.page, 'history-h', /^பார்கோடு வரலாறு$/);
    await expect.poll(() => moved.innerText()).toMatch(/^C7-WRONG Synthetic Sugar 1kg \(SUGAR\)-க்கு மாற்றப்பட்டது · /);
    await shot(after.page, 'c7-5-history-ta');
    expect(after.errors).toEqual([]);
  }, 180_000);
});
