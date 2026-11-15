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

/**
 * **OB-773 (owner, 15 Nov 2026, choice 3 B · audit C-8) — in a real browser, the office pages served by the store computer,
 * over head office's REAL routes and approval engine (head office reached as the signed-in person, as the hosted pages are).**
 *   • The store manager opens Product details: the page says he can propose changes; the save button says "Send for the
 *     owner's approval" (and in Tamil); he changes the maker and sends it — the page says nothing has changed yet; head office
 *     holds the item unchanged. He sends a new barcode the same way, and a GST rate from the GST page.
 *   • The owner opens Approvals: the change waits for him with the before and the after; he approves with a reason; the page
 *     says head office has made it; the item now carries it. He refuses the barcode with a reason; nothing changes.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['ob773', 'catalogue', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner';
const MANAGER = 'u-mgr';
const OWNER_WORDS = ['identity.self.read', 'catalogue.pack.read', 'catalogue.pack.publish', 'catalogue.tax.approve', 'org.branch.read'];
const MANAGER_WORDS = ['identity.self.read', 'catalogue.pack.read', 'catalogue.change.propose', 'org.branch.read'];
const SALT = { sku: 'SKU-SALT', name: 'Synthetic Salt 1kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '25010020', lifecycle: 'active', mrpHistory: [{ value: { minor: 2_800, currency: 'INR' }, effectiveFrom: '2026-01-01' }], safety: { allergens: [], countryOfOrigin: 'India' } };

type Doc = { document: { getElementById(id: string): { textContent: string | null } | null } };

describe.skipIf(!HAVE_BROWSER)('OB-773: the store manager sends a catalogue change for the owner\'s approval; the owner approves it on Approvals', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER) =>
    ho.request({ method, path, userId, tenantId: TENANT, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const ok = async (p: ReturnType<typeof req>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager');
    await ok(req('POST', '/v1/catalogue/tax-classes/25010020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null, regulated: ['food'] }), 'category');
    await ok(req('POST', '/v1/catalogue/products/SALT/publish', { product: SALT }), 'publish SALT');

    dir = await mkdtemp(join(tmpdir(), 'sre-ob773-'));
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
  const held = async () => ((await req('GET', '/v1/catalogue/products/SALT')).body as { product: Record<string, unknown>; version: number });

  it('the manager sends an item change and a barcode; the owner sees the before and after, approves one (made) and refuses the other (nothing changes)', async () => {
    const before = await held();
    const m = await open(MANAGER, '/product-details/?product=SALT');
    await says(m.page, 'result', /^You can propose changes to this product\./);
    await says(m.page, 'save', /^Send for the owner’s approval$/);
    expect(await m.page.isDisabled('#save')).toBe(false);
    expect(await m.page.isDisabled('#save-pack')).toBe(true); // the pack, bundle and substitutes stay the owner's
    await m.page.fill('#r-manufacturer', 'Synthetic Salt Works');
    await m.page.click('#save');
    await says(m.page, 'record-status', /^Write the reason first\.$/);
    await m.page.fill('#r-why', 'the maker is printed on the new pack (synthetic)');
    await m.page.click('#save');
    await says(m.page, 'record-status', /^Sent for the owner’s approval\. Nothing has changed yet/);
    expect((await held()).version).toBe(before.version);
    expect((await held()).product['manufacturer']).toBeUndefined();

    await m.page.click('#tab-codes');
    await says(m.page, 'add-barcode', /^Send for the owner’s approval$/);
    await m.page.fill('#b-code', '8901234567890');
    await m.page.selectOption('#b-kind', 'ean');
    await m.page.fill('#b-why', 'barcode on the new pack (synthetic)');
    await m.page.click('#add-barcode');
    await says(m.page, 'codes-status', /^Sent for the owner’s approval\. Nothing has changed yet/);
    expect((await req('GET', '/v1/catalogue/barcodes/8901234567890')).status).toBe(404);

    await m.page.click('#lang');
    await says(m.page, 'save', /^உரிமையாளரின் ஒப்புதலுக்கு அனுப்பு$/);
    expect(m.errors).toEqual([]);

    // The owner's Approvals page: both wait for him, with the before and the after.
    const o = await open(OWNER, '/approvals/');
    const itemRow = o.page.locator('#waiting li', { hasText: 'Item change: Synthetic Salt 1kg' });
    await itemRow.waitFor();
    await expect.poll(() => itemRow.innerText()).toMatch(/Manufacturer: nothing → Synthetic Salt Works/);
    await expect.poll(() => itemRow.innerText()).toMatch(/A store manager's change to an item, a barcode or a GST rate/);
    await itemRow.locator('input.reason').fill('checked the pack (synthetic)');
    await itemRow.locator('button.approve').click();
    await says(o.page, 'result-text', /^Approved\. Head office has made the change\.$/);
    expect((await held()).product['manufacturer']).toBe('Synthetic Salt Works');
    expect((await held()).version).toBe(before.version + 1);

    const codeRow = o.page.locator('#waiting li', { hasText: 'New barcode 8901234567890' });
    await expect.poll(() => codeRow.innerText()).toMatch(/New barcode: nothing → 8901234567890 \(ean\)/);
    await codeRow.locator('input.reason').fill('that code belongs to the 500 g pack (synthetic)');
    await codeRow.locator('button.reject').click();
    await says(o.page, 'result-text', /^Rejected\./);
    expect((await req('GET', '/v1/catalogue/barcodes/8901234567890')).status).toBe(404);
    expect(o.errors).toEqual([]);

    // The manager's own list says which was made and which was refused, with the owner's reason.
    const a = await open(MANAGER, '/approvals/');
    const mine = a.page.locator('#mine');
    await expect.poll(() => mine.innerText()).toMatch(/Approved by u-owner and made — the change is in the catalogue\./);
    await expect.poll(() => mine.innerText()).toMatch(/Rejected by u-owner: that code belongs to the 500 g pack \(synthetic\)/);
  }, 180_000);

  it('the GST page: the manager\'s button says "Send for the owner\'s approval"; a first rate for a new class waits for the owner', async () => {
    const m = await open(MANAGER, '/tax-rates/');
    await says(m.page, 'page-status', /^You can propose a GST rate\./);
    await m.page.fill('#hsn', '04051000'); await m.page.click('#open');
    await says(m.page, 'record-h', /^HSN 04051000$/);
    await says(m.page, 'g-save', /^Send for the owner’s approval$/);
    expect(await m.page.isDisabled('#c-save')).toBe(true); // the cess is not part of OB-773
    await m.page.fill('#g-from', '01/12/2026'); await m.page.fill('#g-rate', '12');
    await m.page.fill('#why', 'butter comes in next month (synthetic)');
    await m.page.click('#g-save');
    await says(m.page, 'record-status', /^Sent for the owner’s approval\. Nothing has changed yet/);
    expect((await req('GET', '/v1/catalogue/tax-classes/04051000/rates')).body).toMatchObject({ count: 0 });
    const inbox = (await req('GET', '/v1/approvals/requests')).body as { waitingForMe: { kind: string; subjectRef: string }[] };
    expect(inbox.waitingForMe.some((r) => r.kind === 'catalogue_change' && r.subjectRef === 'hsn:04051000')).toBe(true);
    expect(m.errors).toEqual([]);
  }, 120_000);
});
