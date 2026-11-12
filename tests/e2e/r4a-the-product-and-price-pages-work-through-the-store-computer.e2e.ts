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
import { decide } from '../support/approval-request';
import { deliveryPlaces } from '../support/approved-supplier';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { askedThenConfirmed, writeCounter } from './lib/confirm-sheet';

/** U2: the shared date field is read as a shop person writes it (dd/mm/yyyy); the page sends ISO. */
const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * **Round 4a — the product-master and price-list pages, in a real browser, served by the store computer, over head office's
 * REAL routes (M03-FR-01..04 · M05-FR-01 · M01-FR-01 · WF-01 · re-audit G-1 · ADR-0024 · §28).**
 *
 * The store computer serves each page; head office's API surface runs in memory with its real routes, permission checks
 * and approval engine, and every `/v1` call reaches it as the signed-in person, on the box's own origin. Through Chromium:
 *   • Product details: the owner fills in the manufacturer, allergens, storage and the nutrition panel and saves a new
 *     version; gives a barcode; defines a case of 12 and reads 2 cases as 24; defines a bundle; sets substitutes; a change
 *     of a published product's tax class waits for Finance — asked on the page, approved by the accountant in her own
 *     session, then saved naming her. A manager reads it with every control off; the accountant is not given the page.
 *   • Categories: the manager proposes a category, is told it needs the owner, asks; the owner approves; the manager saves
 *     it. The report by category rolls a variant up under its parent.
 *   • Duplicates and merges: the look-alike pair is listed; the manager proposes keeping one; only the owner sees Approve;
 *     he approves, then reverses it.
 *   • GST and cess rates: the first rate of a class is recorded; a change waits for Finance and is recorded once the
 *     accountant approves; a manager reads it with every control off.
 *   • Price lists: head office's figures are read and shown; a dated store price within the set size is saved; a move
 *     beyond it waits for the owner's approval and is saved naming him; a store goes into a zone; a manager's request to
 *     switch app prices on is approved by the owner and then switched off.
 *   • Offer results: every offer with where it stands; one measured against the days before it; the owner stops it with a
 *     reason, sealed on the audit trail; a manager reads it.
 *   • Organisation: a department is given its categories only with the other owner's approval; its report by day reads.
 *   • Tamil words on each page.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['r4a', 'products', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner';
const OWNER2 = 'u-owner-2';
const MANAGER = 'u-mgr';
const ACCOUNTANT = 'u-acct';
const STORE = 'store-1';
const RULES = {
  approvalLimitMinor: 500_000, marginFloorBps: 2_000, nearExpiryDays: 30,
  reporting: { laggingAfterMinutes: 5, staleAfterMinutes: 60 },
  service: { returnWindowDays: 7, approvalThresholdMinor: 200_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 5_000, compensationCapMinor: 50_000 },
  journalPrefixes: { takings: 'TK', tax: 'TX', refunds: 'RF' }, dormantAfterDays: 60, aiStaleAfterMinutes: 60,
  merchandising: { refillAtBp: 5_000, countStaleAfterMinutes: 120, refillRole: 'store_manager' },
  writeOffMaterialThresholdMinor: 50_000,
  checklist: [{ itemId: 'close-1', description: 'Count every till blind', blocking: true }],
};
const OWNER_WORDS = ['identity.self.read', 'catalogue.pack.read', 'catalogue.pack.publish', 'catalogue.category.propose', 'catalogue.category.approve', 'catalogue.merge.propose',
  'catalogue.merge.approve', 'catalogue.tax.approve', 'price.change.propose', 'price.change.approve', 'price.zone.manage', 'org.branch.read', 'platform.setup.write', 'reporting.report.read', 'org.structure.approve', 'promotion.read', 'promotion.launch'];
const MANAGER_WORDS = ['identity.self.read', 'promotion.read', 'promotion.launch', 'catalogue.pack.read', 'catalogue.category.propose', 'catalogue.merge.propose', 'price.change.propose', 'org.branch.read', 'reporting.report.read'];
const ACCOUNTANT_WORDS = ['identity.self.read', 'catalogue.tax.approve', 'org.branch.read', 'reporting.report.read'];

type Doc = { document: { getElementById(id: string): { textContent: string | null } | null } };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

describe.skipIf(!HAVE_BROWSER)('Round 4a: the product and price pages work through the store computer, on head office\'s real routes', () => {
  let browser: Browser;
  let ho: ApiHarness;
  let edge: EdgeProcess;
  let dir: string;
  const stops: (() => Promise<void>)[] = [];
  const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = OWNER) =>
    ho.request({ method, path, userId, tenantId: TENANT, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }) });
  const ok = async (p: ReturnType<typeof req>, what: string) => { const r = await p; if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  const product = (id: string, extra: Record<string, unknown> = {}) => ({
    sku: `SKU-${id}`, name: `Synthetic ${id}`, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '10063020', lifecycle: 'active',
    mrpHistory: [{ value: { minor: 10_000, currency: 'INR' }, effectiveFrom: '2026-01-01' }], safety: { allergens: [], countryOfOrigin: 'India' }, ...extra,
  });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    ho = apiHarness();
    await ho.seedOwner(TENANT, OWNER);
    await ho.provisionOwner(TENANT, OWNER2);
    await ho.provisionRole(TENANT, MANAGER, 'store_manager');
    await ho.provisionRole(TENANT, ACCOUNTANT, 'accountant');
    await deliveryPlaces(ho, TENANT, STORE);
    await ok(req('POST', `/v1/stores/${STORE}/rules`, RULES), 'store rules');
    await ok(req('POST', '/v1/catalogue/tax-classes/10063020/rates/2017-07-01', { rateBps: 500 }), 'tax');
    await ok(req('POST', '/v1/catalogue/tax-classes/19053100/rates/2017-07-01', { rateBps: 1_800 }), 'tax 2');
    await ok(req('POST', '/v1/catalogue/categories/grocery', { name: 'Grocery', parentId: null, regulated: ['food'] }), 'category');
    for (const id of ['DAL', 'RICE', 'RICE-5', 'OIL']) await ok(req('POST', `/v1/catalogue/products/${id}/publish`, { product: product(id, id === 'RICE-5' ? { parentProductId: 'RICE', attributes: {}, name: 'Synthetic RICE 5 kg' } : {}) }), `publish ${id}`);
    // A look-alike of OIL: the same name and brand under another id.
    await ok(req('POST', '/v1/catalogue/products/OIL-2/publish', { product: product('OIL-2', { name: 'Synthetic OIL', brand: 'Synthetic', sku: 'SKU-OIL-2' }) }), 'look-alike');
    await ok(req('POST', '/v1/catalogue/products/OIL/publish', { product: product('OIL', { brand: 'Synthetic' }) }), 'brand');
    await ok(req('POST', '/v1/inventory/movements', { movementId: 'rx-dal', productId: 'DAL', locationId: STORE, kind: 'received', quantityMinor: 10, uom: 'EA', occurredAt: new Date(Date.now() - 86_400_000).toISOString(), enteredBy: OWNER, unitCostMinor: 7_000 }), 'receive');
    await ok(req('POST', '/v1/org/nodes/D-GROCERY', { kind: 'department', name: 'Grocery department', parentId: STORE, companyId: 'C-FIXTURE' }), 'department');

    dir = await mkdtemp(join(tmpdir(), 'sre-r4a-'));
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE },
      roles: [{ id: 'owner', name: 'Owner', permissions: OWNER_WORDS }, { id: 'manager', name: 'Store manager', permissions: MANAGER_WORDS }, { id: 'accountant', name: 'Accountant', permissions: ACCOUNTANT_WORDS }],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: OWNER2, roleId: 'owner', branchScope: 'all' }, { userId: MANAGER, roleId: 'manager', branchScope: 'all' }, { userId: ACCOUNTANT, roleId: 'accountant', branchScope: 'all' }],
    }), 'utf8');
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile, EDGE_SCREEN_TRUST_FORWARDED_USER: '1',
    }, () => {}))!;
  }, 240_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  /** A page on the box's origin as `who`; head office's API carried on that origin as that person. */
  const open = async (who: string, path: string): Promise<{ page: Page; errors: string[]; status: number | undefined }> => {
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
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    return { page, errors, status: res?.status() };
  };
  const says = async (page: Page, id: string, re: RegExp): Promise<void> => {
    try {
      await page.waitForFunction(([el, src]) => new RegExp(src!).test((globalThis as unknown as Doc).document.getElementById(el!)?.textContent ?? ''), [id, re.source] as const);
    } catch {
      throw new Error(`#${id} says ${JSON.stringify(await page.textContent(`#${id}`))}, not ${String(re)}`);
    }
  };
  // U5: a page's summary figures are the chrome's cards — a figure is read by its card's label, not a page-own id
  const card = async (page: Page, label: string, re: RegExp): Promise<void> => {
    const value = page.locator('.sre-summary-card', { hasText: label }).locator('.sre-summary-value');
    await expect.poll(() => value.textContent(), { timeout: 15_000, message: `the "${label}" card` }).toMatch(re);
  };
  const inbox = async (who: string) => (await req('GET', '/v1/approvals/requests', undefined, who)).body as { waitingForMe: { requestId: string; kind: string; subjectRef: string }[] };
  const approveWaiting = async (checker: string, kind: string, subjectRef: string) => {
    const r = (await inbox(checker)).waitingForMe.find((x) => x.kind === kind && x.subjectRef === subjectRef);
    expect(r, `${kind} ${subjectRef} waits for ${checker}`).toBeDefined();
    expect((await decide(ho, TENANT, checker, r!.requestId, 'approved', 'checked (synthetic)')).status).toBe(201);
  };

  it('Product details: the owner records the safety facts, codes, a case, a bundle and substitutes; a tax-class change waits for Finance; a manager reads only; the accountant is not given the page', async () => {
    const { page, errors, status } = await open(OWNER, '/product-details/?product=DAL');
    expect(status).toBe(200);
    await says(page, 'v-state', /^On sale$/);
    await page.fill('#r-manufacturer', 'Synthetic Mills');
    await page.click('#save');
    await says(page, 'record-status', /^Saved\.$/);
    // Owner 2A: the safety, label and nutrition facts of a published product save on their own route, with a reason.
    await page.fill('#s-storage', 'Cool and dry');
    await page.fill('#s-ingredients', 'Split pigeon peas');
    for (const [k, v] of [['energyKcal', '343'], ['proteinG', '22'], ['carbohydrateG', '63'], ['totalSugarsG', '3'], ['addedSugarsG', '0'], ['totalFatG', '1.5'], ['saturatedFatG', '0.3'], ['transFatG', '0'], ['cholesterolMg', '0'], ['sodiumMg', '17']]) await page.fill(`#n-${k}`, v!);
    await page.click('#save');
    await says(page, 'record-status', /^You changed the safety, label or nutrition facts: save them with/);
    await page.click('#save-safety');
    await says(page, 'safety-status', /^Write the reason first\.$/);
    await page.fill('#s-why', 'label read off the pack (synthetic)');
    await page.click('#save-safety');
    await says(page, 'safety-status', /^Saved — version \d+\.$/);
    const held = ((await req('GET', '/v1/catalogue/products/DAL')).body as { product: { manufacturer: string; safety: { storageConditions: string; ingredients: string; nutrition: { proteinG: number }; allergens: string[] } } }).product;
    expect(held).toMatchObject({ manufacturer: 'Synthetic Mills', safety: { storageConditions: 'Cool and dry', ingredients: 'Split pigeon peas', nutrition: { proteinG: 22 }, allergens: [] } });

    // A nutrition panel that does not add up is refused in head office's words.
    await page.fill('#n-totalSugarsG', '99');
    await page.fill('#s-why', 'correcting the panel (synthetic)');
    await page.click('#save-safety');
    await says(page, 'safety-status', /Head office refused: .*the total sugars cannot be more than the carbohydrate/);
    await page.fill('#n-totalSugarsG', '3');

    await page.click('#tab-codes');
    await page.fill('#b-code', 'DAL-0001'); await page.selectOption('#b-kind', 'internal');
    await page.click('#add-barcode');
    await page.locator('#barcode-list li[data-code="DAL-0001"]').waitFor();
    await page.fill('#pk-level-0', 'ea'); await page.fill('#pk-count-0', '1');
    await page.fill('#pk-level-1', 'case'); await page.fill('#pk-count-1', '12');
    await page.click('#save-pack');
    await says(page, 'codes-status', /^Saved\.$/);
    await page.fill('#cv-qty', '2'); await page.selectOption('#cv-level', 'case');
    await page.click('#convert');
    await says(page, 'codes-status', /^2 case = 24 ea$/);

    await page.click('#tab-bundle');
    await page.fill('#bd-prod-0', 'RICE'); await page.fill('#bd-qty-0', '1');
    await page.fill('#bd-prod-1', 'OIL'); await page.fill('#bd-qty-1', '1');
    await page.click('#save-bundle');
    await says(page, 'bundle-status', /^Write the reason first\.$/);
    await page.fill('#bd-why', 'festival combo (synthetic)');
    await page.click('#save-bundle');
    await says(page, 'bundle-status', /^Saved\.$/);
    expect(((await req('GET', '/v1/catalogue/bundles/DAL')).body as { bundle: { components: unknown[] } }).bundle.components).toEqual([{ productId: 'RICE', quantityMinor: 1 }, { productId: 'OIL', quantityMinor: 1 }]);

    await page.click('#tab-subs');
    await page.fill('#sb-list', 'OIL, RICE'); await page.fill('#sb-why', 'nearest staples (synthetic)');
    await page.click('#save-subs');
    await says(page, 'subs-status', /^Saved\./);
    await page.locator('#subs-list li', { hasText: 'RICE' }).waitFor();

    // A published product's tax class changes only with Finance: asked here, approved by the accountant, then saved.
    await page.click('#tab-record');
    await page.fill('#r-taxClass', '19053100');
    await page.click('#save');
    await says(page, 'record-status', /^This needs a second person: .*Finance approver/);
    await page.fill('#r-why', 'reclassified by the CA (synthetic)');
    await page.click('#ask-approval');
    await says(page, 'record-status', /^Asked\./);
    await page.click('#save');
    await says(page, 'record-status', /^Still waiting for the second person/);
    await approveWaiting(ACCOUNTANT, 'hsn_class_change', 'product:DAL');
    await page.click('#save');
    await says(page, 'record-status', new RegExp(`^Saved with the approval of ${ACCOUNTANT}\\.$`));
    expect(((await req('GET', '/v1/catalogue/products/DAL')).body as { product: { taxClass: string } }).product.taxClass).toBe('19053100');

    await page.click('#lang');
    await says(page, 'record-h', /^பதிவு$/);
    expect(errors).toEqual([]);

    // The manager reads it with every control off; head office refuses the manager's publish all the same.
    const m = await open(MANAGER, '/product-details/?product=DAL');
    await says(m.page, 'result', /^You can read this product\./);
    expect(await m.page.isDisabled('#save')).toBe(true);
    expect(await m.page.isDisabled('#r-name')).toBe(true);
    expect((await req('POST', '/v1/catalogue/products/DAL/publish', { product: product('DAL') }, MANAGER)).status).toBe(403);
    // The accountant holds no catalogue read: the store computer does not give her the page.
    expect((await open(ACCOUNTANT, '/product-details/')).status).toBe(403);
  }, 180_000);

  it('Product details (owner 2A): two people open the same product; the first saves its safety facts, the second is told plainly in English and Tamil and nothing is overwritten', async () => {
    const a = await open(OWNER, '/product-details/?product=RICE');
    const b = await open(OWNER2, '/product-details/?product=RICE');
    for (const p of [a.page, b.page]) await says(p, 'v-state', /^On sale$/);
    const before = (await req('GET', '/v1/catalogue/products/RICE')).body as { version: number };

    await a.page.fill('#s-storage', 'Store below 25 °C');
    await a.page.fill('#s-why', 'pack reprint (synthetic)');
    await a.page.click('#save-safety');
    await says(a.page, 'safety-status', new RegExp(`^Saved — version ${before.version + 1}\\.$`));

    await b.page.fill('#s-ingredients', 'Rice, nothing else');
    await b.page.fill('#s-why', 'my own edit (synthetic)');
    await b.page.click('#save-safety');
    await says(b.page, 'safety-status', /^Someone else saved this product after you opened it\. Nothing of yours was saved\. Press “Reload”/);
    expect(await b.page.isVisible('#safety-reload')).toBe(true);
    await b.page.click('#lang');
    await says(b.page, 'safety-status', /^நீங்கள் திறந்த பிறகு வேறொருவர் இந்தப் பொருளைச் சேமித்துவிட்டார்/);
    await says(b.page, 'safety-reload', /^மீண்டும் ஏற்று$/);
    await b.page.click('#lang');

    // Head office kept the first person's change and none of the second's.
    const held = (await req('GET', '/v1/catalogue/products/RICE')).body as { version: number; product: { safety: { storageConditions?: string; ingredients?: string } } };
    expect(held.version).toBe(before.version + 1);
    expect(held.product.safety.storageConditions).toBe('Store below 25 °C');
    expect(held.product.safety.ingredients).toBeUndefined();

    // Reload shows what head office holds now; the second person's change made again then lands, keeping the first's.
    await b.page.click('#safety-reload');
    await b.page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { value: string } | null } }).document.getElementById('s-storage')?.value === 'Store below 25 °C');
    expect(await b.page.isVisible('#safety-reload')).toBe(false);
    await b.page.fill('#s-ingredients', 'Rice, nothing else');
    await b.page.fill('#s-why', 'my own edit, after reloading (synthetic)');
    await b.page.click('#save-safety');
    await says(b.page, 'safety-status', new RegExp(`^Saved — version ${before.version + 2}\\.$`));
    expect(((await req('GET', '/v1/catalogue/products/RICE')).body as { product: { safety: Record<string, unknown> } }).product.safety).toMatchObject({ storageConditions: 'Store below 25 °C', ingredients: 'Rice, nothing else' });
    expect([...a.errors, ...b.errors]).toEqual([]);
  }, 120_000);

  it('Categories: a manager\'s proposal waits for the owner and is then saved; the report by category rolls a variant up', async () => {
    const { page, errors } = await open(MANAGER, '/product-categories/');
    await page.locator('#rows tr[data-id="grocery"]').waitFor();
    await page.fill('#f-id', 'snacks'); await page.fill('#f-name', 'Snacks'); await page.check('#reg-food');
    await page.click('#save');
    await says(page, 'form-status', /^A new or changed category is approved by the owner\./);
    await page.fill('#f-why', 'new aisle (synthetic)');
    await page.click('#ask');
    await says(page, 'form-status', /^Asked\./);
    await approveWaiting(OWNER, 'category_define', 'snacks');
    await page.click('#save');
    await says(page, 'form-status', /^Saved\.$/);
    await page.locator('#rows tr[data-id="snacks"]').waitFor();
    expect(((await req('GET', '/v1/catalogue/categories')).body as { categories: { categoryId: string; approvedBy: string }[] }).categories.find((c) => c.categoryId === 'snacks')).toMatchObject({ approvedBy: OWNER });

    await page.click('#tab-variants');
    await page.selectOption('#v-cat', 'grocery');
    await page.click('#run');
    await page.locator('#v-families li[data-product="RICE"]', { hasText: 'Synthetic RICE 5 kg' }).waitFor();
    expect(await page.textContent('#v-makers')).toContain('not recorded');
    await page.click('#lang');
    await says(page, 'list-h', /^வகைப் பட்டியல்$/);
    expect(errors).toEqual([]);
    expect((await open(ACCOUNTANT, '/product-categories/')).status).toBe(403);
  }, 120_000);

  it('Duplicates and merges: the manager proposes, only the owner decides, and a merge can be reversed', async () => {
    const m = await open(MANAGER, '/product-merges/');
    const pair = m.page.locator('#pairs li', { hasText: 'Synthetic OIL' });
    await pair.first().waitFor();
    await pair.first().locator('button[data-act="keepA"]').click();
    await m.page.fill('#m-why', 'the same oil entered twice (synthetic)');
    await m.page.click('#propose');
    await says(m.page, 'propose-status', /^Proposed\./);
    await m.page.click('#tab-merges');
    const row = m.page.locator('#merges li[data-status="pending"]');
    await row.waitFor();
    expect(await row.locator('button').count()).toBe(0);
    expect(m.errors).toEqual([]);

    const o = await open(OWNER, '/product-merges/');
    await o.page.click('#tab-merges');
    await o.page.locator('#merges li[data-status="pending"] button[data-act="approve"]').click();
    await says(o.page, 'merges-status', /^Merged\./);
    await o.page.locator('#merges li[data-status="approved"] button[data-act="reverse"]').click();
    await says(o.page, 'merges-status', /^Reversed\./);
    await o.page.locator('#merges li[data-status="reversed"]').waitFor();
    expect(o.errors).toEqual([]);
  }, 120_000);

  it('GST and cess rates: a first rate is recorded; a change waits for the accountant and is then recorded naming her; a manager reads only', async () => {
    const { page, errors } = await open(OWNER, '/tax-rates/');
    await page.locator('#rows tr[data-id="10063020"]').waitFor();
    await page.fill('#hsn', '24039910'); await page.click('#open');
    await says(page, 'record-h', /^HSN 24039910$/);
    await page.fill('#g-from', '01/07/2017'); await page.fill('#g-rate', '28');
    await page.click('#g-save');
    await says(page, 'record-status', /^Recorded\.$/);
    await page.fill('#c-from', '01/07/2017'); await page.fill('#c-adv', '61'); await page.fill('#c-spec', '0'); await page.fill('#c-per', '1');
    await page.click('#c-save');
    await says(page, 'record-status', /^Recorded\.$/);
    await page.fill('#g-from', '01/12/2026'); await page.fill('#g-rate', '40');
    await page.click('#g-save');
    await says(page, 'record-status', /^This is a tax change/);
    await page.fill('#why', 'GST 2.0 slab (synthetic)');
    await page.click('#ask');
    await says(page, 'record-status', /^Asked\./);
    await approveWaiting(ACCOUNTANT, 'tax_rate_change', '24039910');
    await page.click('#g-save');
    await says(page, 'record-status', new RegExp(`^Recorded with the approval of ${ACCOUNTANT}\\.$`));
    await page.locator('#gst-list li[data-from="2026-12-01"]').waitFor();
    // The cess change goes the same way.
    await page.fill('#c-from', '01/12/2026'); await page.fill('#c-adv', '0');
    await page.click('#c-save');
    await says(page, 'record-status', /^This is a tax change/);
    await page.click('#ask');
    await says(page, 'record-status', /^Asked\./);
    await approveWaiting(ACCOUNTANT, 'cess_rate_change', '24039910');
    await page.click('#c-save');
    await says(page, 'record-status', new RegExp(`^Recorded with the approval of ${ACCOUNTANT}\\.$`));
    await page.click('#lang');
    await says(page, 'gst-h', /^GST விகிதம்$/);
    expect(errors).toEqual([]);

    const m = await open(MANAGER, '/tax-rates/');
    await m.page.locator('#rows tr[data-id="10063020"]').click();
    await says(m.page, 'record-h', /^HSN 10063020$/);
    expect(await m.page.isDisabled('#g-save')).toBe(true);
  }, 120_000);

  it('Price lists: head office\'s figures are shown; a dated price within the size is saved; a big move waits for the owner; zones and the app-price switch', async () => {
    const { page, errors, status } = await open(MANAGER, '/price-lists/?product=DAL');
    expect(status).toBe(200);
    await page.fill('#p-ref', STORE);
    await page.fill('#p-from', ddmm(today));
    await page.click('#read-basis');
    await says(page, 'v-mrp', /^₹100\.00$/);
    await says(page, 'v-cost', /^₹70\.00$/);
    await says(page, 'v-floor', /^20\.00%$/);
    await says(page, 'v-now', /^none yet$/);
    await page.fill('#p-price', '90');
    await page.click('#save');
    await says(page, 'price-status', new RegExp(`^Saved\\. ₹90\\.00 from ${today}`));
    await page.locator('#history tr td', { hasText: '₹90.00' }).first().waitFor();
    // A move beyond the owner's set size: from ₹90 to ₹100 is 11.1% (more than 10%).
    await page.fill('#p-from', '01/01/2030');
    await page.fill('#p-price', '100');
    await page.click('#save');
    await says(page, 'price-status', /^This needs a second person: .*OB-291/);
    await page.fill('#p-why', 'new season (synthetic)');
    await page.click('#ask');
    await says(page, 'price-status', /^Asked\./);
    const waiting = (await inbox(OWNER)).waitingForMe.find((x) => x.kind === 'price_list_entry');
    expect(waiting).toBeDefined();
    expect((await decide(ho, TENANT, OWNER, waiting!.requestId, 'approved', 'fine (synthetic)')).status).toBe(201);
    await page.click('#save');
    await says(page, 'price-status', new RegExp(`Saved with the approval of ${OWNER}\\.$`));

    await page.click('#tab-channels');
    const app = page.locator('#switches li[data-subject="channel:app"]');
    await app.locator('input').fill('app-only offer trial (synthetic)');
    await app.locator('button[data-act="on"]').click();
    await says(page, 'channel-status', /^Asked\./);
    expect(await page.locator('#pending li[data-request] button').count()).toBe(0);
    await page.click('#lang');
    await says(page, 'prices-h', /^தேதியிட்ட விலைகள்$/);
    expect(errors).toEqual([]);

    const o = await open(OWNER, '/price-lists/');
    await o.page.click('#tab-channels');
    const pending = o.page.locator('#pending li[data-request]');
    await pending.locator('input').fill('trial approved (synthetic)');
    await pending.locator('button[data-act="approve"]').click();
    await says(o.page, 'channel-status', /^Done\.$/);
    await o.page.locator('#switches li[data-subject="channel:app"][data-state="on"]').waitFor();
    const on = o.page.locator('#switches li[data-subject="channel:app"]');
    await on.locator('input').fill('trial over (synthetic)');
    await on.locator('button[data-act="off"]').click();
    await o.page.locator('#switches li[data-subject="channel:app"][data-state="off"]').waitFor();
    await o.page.click('#tab-zones');
    await o.page.fill('#z-store', STORE); await o.page.fill('#z-zone', 'coast');
    await o.page.click('#z-save');
    await says(o.page, 'zone-status', /^Saved\.$/);
    await o.page.locator('#zones tr[data-store="store-1"]', { hasText: 'coast' }).waitFor();
    expect(o.errors).toEqual([]);
    expect((await open(ACCOUNTANT, '/price-lists/')).status).toBe(403);
  }, 180_000);

  it('Offer results: every offer with where it stands; one measured against the days before it; the owner stops it with a reason', async () => {
    const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();
    await ok(req('POST', '/v1/promotions/rice-10/definition', { kind: 'percent_off', percentBps: 1000, productIds: ['RICE'], startsAt: day(-1), endsAt: day(30) }), 'define');
    await ok(req('POST', '/v1/promotions/rice-10/launch', { description: '10% off rice', normalPrice: { minor: 9_000, currency: 'INR' }, promoPrice: { minor: 8_100, currency: 'INR' }, unitCost: { minor: 6_000, currency: 'INR' }, baselineUnits: 100, expectedUnits: 200 }), 'launch');
    await ok(req('POST', '/v1/promotions/later/definition', { kind: 'amount_off', amountOffMinor: 500, productIds: ['OIL'], startsAt: day(10), endsAt: day(20) }), 'define later');
    const m = await open(MANAGER, '/offer-results/');
    await m.page.locator('#rows tr[data-id="rice-10"][data-status="active"]').waitFor();
    await card(m.page, 'Running now', /^1$/);
    await card(m.page, 'Recorded, not started', /^1$/);
    await m.page.locator('#rows tr[data-id="rice-10"]').click();
    await says(m.page, 'rule', /^Percent off on RICE/);
    await m.page.click('#measure');
    await card(m.page, 'Units: offer · before', /^0 · 0$/);
    await says(m.page, 'baseline-say', /the same number of days just before it started/);
    expect(await m.page.isHidden('#stop-row')).toBe(false);
    expect(m.errors).toEqual([]);

    const o = await open(OWNER, '/offer-results/');
    await o.page.locator('#rows tr[data-id="rice-10"]').click();
    await o.page.click('#stop');
    await says(o.page, 'record-status', /^Write why first\.$/);
    await o.page.fill('#s-why', 'ended early (synthetic)');
    // U1 · OB-698: the consequence-and-confirm sheet names the offer; Go back sends nothing; Confirm sends once.
    await askedThenConfirmed(o.page, () => o.page.click('#stop'), /Stop the offer rice-10 now/, writeCounter(o.page));
    await says(o.page, 'record-status', /^Stopped\./);
    await o.page.locator('#rows tr[data-id="rice-10"][data-status="stopped"]').waitFor();
    expect(((await req('GET', '/v1/promotions/rice-10/definition')).body as { status: string }).status).toBe('stopped');
    const trail = (await ho.store.readStream(TENANT, streamName(STREAM.audit, 'domain-trail'), { type: 'AuditRecordSealed' })).map((e) => e.event.payload as { action: string; actorId: string; reason?: string });
    expect(trail.find((a) => a.action === 'promotion.stop')).toMatchObject({ actorId: OWNER, reason: 'ended early (synthetic)' });
    await o.page.click('#lang');
    await says(o.page, 'list-h', /^சலுகைகள்$/);
    expect(o.errors).toEqual([]);
    expect((await open(ACCOUNTANT, '/offer-results/')).status).toBe(403);
  }, 120_000);

  it('Organisation: a department is given its categories only with the other owner\'s approval, and its report by day reads', async () => {
    const { page, errors } = await open(OWNER, '/organisation/');
    const dept = page.locator('#depts li[data-department="D-GROCERY"]');
    await dept.waitFor();
    await dept.locator('input[data-role="cats"]').fill('grocery');
    await dept.locator('input[data-role="why"]').fill('the grocery aisle (synthetic)');
    await dept.locator('button[data-act="save-categories"]').click();
    await dept.locator('p.status', { hasText: 'Asked' }).waitFor();
    await approveWaiting(OWNER2, 'org_structure_change', 'department:D-GROCERY');
    await dept.locator('button[data-act="save-categories"]').click();
    await page.locator('#depts li[data-department="D-GROCERY"] p.facts', { hasText: 'Owns: grocery' }).waitFor();
    await page.locator('#depts li[data-department="D-GROCERY"] p.status', { hasText: 'Saved' }).waitFor();
    await page.locator('#depts li[data-department="D-GROCERY"] button[data-act="report"]').click();
    await page.locator('#depts li[data-department="D-GROCERY"] p.status', { hasText: `Grocery department on ${today}: ₹0.00 from 0 products` }).waitFor();
    await page.click('#lang');
    await says(page, 'dept-h', /^பிரிவுகளும் அவற்றின் வகைகளும்$/);
    expect(errors).toEqual([]);
  }, 120_000);
});
