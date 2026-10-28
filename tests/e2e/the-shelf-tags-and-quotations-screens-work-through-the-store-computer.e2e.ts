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
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **The Shelf tags page (OB-505 · B3) and the Quotations page (OB-506 · M12-FR-02) in a real browser, served by the store
 * computer, over head office's real routes (OB-380).**
 *
 * The real store computer serves the pages (as the person the front signed in); head office's API surface runs in memory with
 * a published, signed price pack, and every `/v1` call reaches it as that person on the box's own origin. Through Chromium:
 *   • shelf tags: the manager finds the dal by name, adds it and the rice by code, makes English-and-Tamil tags — each shows
 *     the till's price, the MRP and the price per kg; the ghee whose net quantity cannot be divided is refused by name; the
 *     tags are drawn in real millimetres at the judged heights, and the print view shows only the tags; Tamil;
 *   • quotations: the manager makes a quotation (a promised price), gets its eight-digit number, lists it, voids it with a
 *     reason and sees it voided; a cashier is not offered making one and head office refuses her the list; Tamil.
 * Synthetic data only. Without a browser binary it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['shelf', 'quote', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner'; const MANAGER = 'u-mgr'; const CASHIER = 'u-cash';
const STORE = 'store-1';
const PX_PER_MM = 96 / 25.4;
const TODAY = shopDateIn(new Date().toISOString());
const LONG_NAME = 'Cold pressed virgin coconut oil family value pack with a free steel ladle and recipe booklet 500 ml';
const PT_PER_MM = 72 / 25.4;

/** The pages of a PDF the browser printed: how many, and each page's size in millimetres. */
function pdfPages(pdf: Buffer): { count: number; sizesMm: [number, number][] } {
  const raw = pdf.toString('latin1');
  const count = (raw.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  const sizesMm = [...raw.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
    .map((m) => [Math.round((Number(m[3]) - Number(m[1])) / PT_PER_MM), Math.round((Number(m[4]) - Number(m[2])) / PT_PER_MM)] as [number, number]);
  return { count, sizesMm };
}

describe.skipIf(!HAVE_BROWSER)('the Shelf tags and Quotations pages through the store computer (OB-505 · OB-506)', () => {
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
    await ho.provisionRole(TENANT, CASHIER, 'cashier', [STORE]);
    const post = async (path: string, body: unknown): Promise<void> => {
      const r = await ho.request({ method: 'POST', path, userId: OWNER, tenantId: TENANT, idempotencyKey: `k-${randomUUID()}`, body });
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    };
    await post('/v1/catalogue/tax-classes/07139010/rates/2017-07-01', { rateBps: 500 });
    for (const [id, sku, name, code, net, price, mrp] of [
      ['p-dal', 'DAL-500', 'Toor dal 500 g', '8901000000019', '500 g', 7_200, 8_000],
      ['p-rice', 'RICE-25', 'Ponni rice 25 kg', '8901000000033', '25 kg', 145_000, 150_000],
      ['p-ghee', 'GHEE-JAR', 'Ghee jar', '8901000000040', 'one jar', 60_000, 65_000],
      ['p-long', 'OIL-LONG', LONG_NAME, '8901000000057', '500 ml', 21_000, 23_000],
    ] as const) {
      await post(`/v1/catalogue/products/${id}/publish`, { product: { sku, name, baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '07139010', lifecycle: 'draft', safety: { netQuantity: net }, mrpHistory: [{ value: { minor: mrp, currency: 'INR' }, effectiveFrom: '2026-01-01' }] }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] });
      await post(`/v1/prices/list/${id}/entries/e1`, { scope: 'store', scopeRef: STORE, priceMinor: price, mrpMinor: mrp, costMinor: 1, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY });
      await post(`/v1/catalogue/products/${id}/barcodes/${code}`, { kind: 'ean' });
    }
    await post('/v1/catalogue/products/p-dal/content', { nameTa: 'துவரம் பருப்பு', reason: 'Tamil name for the shelf tag' });
    // R8-B · OB-525: the dal came into the store at ₹70.00 (an opening-stock receipt) — head office knows its floor there.
    await post('/v1/inventory/goods-receipt/opening-dal', { warehouseId: STORE, receivedOnDate: TODAY, currency: 'INR', lines: [{ lineId: 'L1', productId: 'p-dal', orderedMinor: 20, countedMinor: 20, uom: 'ea', unitCost: { minor: 7_000, currency: 'INR' }, condition: 'good' }] });
    await post('/v1/catalogue/pack', { storeId: STORE });

    dir = await mkdtemp(join(tmpdir(), 'sre-shelf-quote-screen-'));
    const packFile = join(dir, 'store-pack.json');
    const everything = [...new Set(['identity.self.read', 'pos.quotation.write', ...ERP_NAVIGATION.map((i) => i.requires)])];
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: STORE, branchId: STORE },
      roles: [
        { id: 'owner', name: 'Owner', permissions: everything },
        { id: 'manager', name: 'Store manager', permissions: ['identity.self.read', 'catalogue.pack.read', 'pos.quotation.read', 'pos.quotation.write'] },
        { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'catalogue.pack.read', 'pos.quotation.read'] },
      ],
      roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }, { userId: MANAGER, roleId: 'manager', branchScope: [STORE] }, { userId: CASHIER, roleId: 'cashier', branchScope: [STORE] }],
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

  it('shelf tags: found, chosen, made lawful in English and Tamil, one refused by name, drawn in millimetres, printed alone', async () => {
    const { page: p, errors } = await open(MANAGER, '/shelf-tags/');
    await p.waitForSelector('#choose:not([hidden])');
    await p.fill('#f-text', 'dal');
    await p.click('#f-find');
    await p.waitForSelector('#f-rows li button[data-code="8901000000019"]');
    await p.click('#f-rows li button[data-code="8901000000019"]');
    await p.fill('#t-codes', `${await p.inputValue('#t-codes')}\nRICE-25\nGHEE-JAR`);
    await p.selectOption('#t-lang', 'both');
    await p.selectOption('#t-size', 'shelf-70x38');
    await p.click('#t-make');
    await says(p, '#t-status', /^2 tag\(s\) ready to print\.$/);
    // OB-549: English AND Tamil on the small 70 × 38 mm stock — both names, field labels in English only — fits at the lawful
    // heights, so nothing is cut off and nothing is refused (the page measures every tag before it prints).
    expect(await p.locator('#sheet .tag[data-overflow]').count()).toBe(0);
    expect((await p.textContent('#t-print-status'))?.trim() ?? '').toBe('');
    const dal = p.locator('#sheet .tag[data-product="p-dal"]');
    const dalText = await dal.innerText();
    expect(dalText).toContain('Toor dal 500 g');
    expect(dalText).toContain('துவரம் பருப்பு');
    expect(dalText).toContain('₹72.00');
    expect(dalText).toMatch(/MRP ₹80\.00/);
    expect(dalText).toMatch(/₹144\.00 per kg/);
    expect(dalText).toMatch(/You save ₹8\.00/);
    expect(dalText).not.toContain('அ.சி.வி'); // the field labels are in English only (OB-549); the names stay in both
    expect(await p.locator('#sheet .tag[data-product="p-rice"]').innerText()).toMatch(/₹58\.00 per kg/);
    expect(await p.textContent('#refused-rows')).toMatch(/GHEE-JAR · Ghee jar — its net quantity is missing or cannot be read/);
    // Real millimetres: the 70 × 38 mm stock, and the price printed at its judged 8 mm (font ≥ 8 / 0.7 mm).
    const box = await dal.boundingBox();
    expect(Math.round(box!.width / PX_PER_MM)).toBe(70);
    expect(Math.round(box!.height / PX_PER_MM)).toBe(38);
    const priceFont = await dal.locator('.price').evaluate((n) => (globalThis as unknown as { getComputedStyle(e: unknown): { fontSize: string } }).getComputedStyle(n).fontSize);
    expect(parseFloat(priceFont) / PX_PER_MM).toBeGreaterThanOrEqual(8 / 0.7 - 0.05);
    // The print view: the tags alone.
    await p.emulateMedia({ media: 'print' });
    expect(await p.isVisible('#sheet .tag[data-product="p-dal"]')).toBe(true);
    const shown = await p.evaluate(() => {
      const g = globalThis as unknown as { document: { getElementById(id: string): unknown }; getComputedStyle(e: unknown): { visibility: string } };
      return ['choose', 't-print', 'page-intro', 'sheet'].map((id) => g.getComputedStyle(g.document.getElementById(id)).visibility);
    });
    expect(shown).toEqual(['hidden', 'hidden', 'hidden', 'visible']);
    await p.emulateMedia({ media: 'screen' });
    await p.click('#lang');
    await says(p, '#choose-h', /^பொருட்களைத் தேர்ந்தெடுங்கள்$/);
    expect(await p.textContent('#refused-rows')).toMatch(/நிகர அளவு இல்லை/);
    expect(errors).toEqual([]);
  });

  /** What the page asked the browser to print on: the @page rule it injected for this print (size and margin). */
  const pageRule = (p: Page): Promise<{ size: string; margin: string } | null> => p.evaluate(() => {
    const g = globalThis as unknown as { document: { getElementById(id: string): { sheet: { cssRules: ArrayLike<{ cssRules?: ArrayLike<{ type: number; style: { getPropertyValue(k: string): string } }> }> } } } };
    for (const media of Array.from(g.document.getElementById('print-css').sheet.cssRules)) {
      for (const rule of Array.from(media.cssRules ?? [])) if (rule.type === 6) return { size: rule.style.getPropertyValue('size'), margin: rule.style.getPropertyValue('margin') };
    }
    return null;
  });
  const printStyles = (p: Page): Promise<{ breakAfter: string; border: string }[]> => p.evaluate(() => {
    const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<unknown> }; getComputedStyle(e: unknown): { breakAfter: string; borderTopStyle: string } };
    return Array.from(g.document.querySelectorAll('#sheet .tag')).map((n) => ({ breakAfter: g.getComputedStyle(n).breakAfter, border: g.getComputedStyle(n).borderTopStyle }));
  });
  /** Count the browser print dialogs the page opens (the real one would block a headless browser). */
  const countPrints = (p: Page): Promise<void> => p.evaluate(() => {
    const w = globalThis as unknown as { print: () => void; printed: number };
    w.printed = 0; w.print = () => { w.printed += 1; };
  });
  const printed = (p: Page): Promise<number> => p.evaluate(() => (globalThis as unknown as { printed: number }).printed);
  const make = async (p: Page, codes: string, language: string, size: string): Promise<void> => {
    await p.fill('#t-codes', codes);
    await p.selectOption('#t-lang', language);
    await p.selectOption('#t-size', size);
    await p.click('#t-make');
    // The page clears its status on the click and says the outcome once the new sheet is drawn.
    await p.waitForFunction(() => ((globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } } }).document.getElementById('t-status').textContent ?? '') !== '');
    await p.waitForSelector('#sheet-section:not([hidden])');
  };

  it('OB-505: on the label printer (the default) each tag prints alone on a page the label\'s own size, no margin, no cut line; an ordinary printer still gets the sheet', async () => {
    const { page: p, errors } = await open(MANAGER, '/shelf-tags/');
    await p.waitForSelector('#choose:not([hidden])');
    await countPrints(p);
    await make(p, 'DAL-500\nRICE-25', 'en', 'shelf-70x38');
    await says(p, '#t-status', /^2 tag\(s\) ready to print\.$/);
    // The label printer is the default, offered in words; nothing overflows.
    expect(await p.inputValue('#t-mode')).toBe('label');
    expect(await p.locator('#t-mode option').allTextContents()).toEqual(['Label printer (one tag per label)', 'Ordinary printer (sheet to cut)']);
    expect(await p.isHidden('#t-print-status')).toBe(true);
    expect(await p.textContent('#t-hint')).toMatch(/Load 70 × 38 mm labels in the label printer/);
    expect(await pageRule(p)).toEqual({ size: '70mm 38mm', margin: '0px' });
    await p.emulateMedia({ media: 'print' });
    expect(await printStyles(p)).toEqual([{ breakAfter: 'page', border: 'none' }, { breakAfter: 'auto', border: 'none' }]);
    expect(await p.isVisible('#sheet .tag[data-product="p-rice"]')).toBe(true);
    // What the browser actually prints: two pages, each 70 × 38 mm — one tag per label.
    expect(pdfPages(await p.pdf({ preferCSSPageSize: true }))).toEqual({ count: 2, sizesMm: [[70, 38], [70, 38]] });
    await p.emulateMedia({ media: 'screen' });
    await p.click('#t-print');
    expect(await printed(p)).toBe(1);

    // The page size follows the chosen tag stock: the large 100 × 60 mm tag.
    await make(p, 'DAL-500', 'en', 'shelf-100x60');
    expect(await p.textContent('#t-print-status')).toBe('');
    expect(await p.isHidden('#t-print-status')).toBe(true);
    expect(await p.textContent('#t-hint')).toMatch(/Load 100 × 60 mm labels/);
    expect(await pageRule(p)).toEqual({ size: '100mm 60mm', margin: '0px' });
    await p.emulateMedia({ media: 'print' });
    expect(pdfPages(await p.pdf({ preferCSSPageSize: true }))).toEqual({ count: 1, sizesMm: [[100, 60]] });
    await p.emulateMedia({ media: 'screen' });
    await make(p, 'DAL-500\nRICE-25', 'en', 'shelf-70x38');

    // An ordinary printer: the sheet to cut — an 8 mm margin, no forced page per tag, the dashed cut lines.
    await p.selectOption('#t-mode', 'sheet');
    expect(await p.textContent('#t-hint')).toMatch(/cut along the dashed lines/);
    expect(await pageRule(p)).toEqual({ size: '', margin: '8mm' });
    await p.emulateMedia({ media: 'print' });
    expect(await printStyles(p)).toEqual([{ breakAfter: 'auto', border: 'dashed' }, { breakAfter: 'auto', border: 'dashed' }]);
    expect(pdfPages(await p.pdf({ preferCSSPageSize: true, format: 'A4' }))).toEqual({ count: 1, sizesMm: [[210, 297]] });
    await p.emulateMedia({ media: 'screen' });
    await p.click('#t-print');
    expect(await printed(p)).toBe(2);
    await p.click('#lang');
    expect(await p.locator('#t-mode option').allTextContents()).toEqual(['லேபிள் அச்சுப்பொறி (ஒரு லேபிளுக்கு ஒரு சீட்டு)', 'சாதாரண அச்சுப்பொறி (வெட்டி எடுக்கும் தாள்)']);
    expect(await p.inputValue('#t-mode')).toBe('sheet');
    expect(errors).toEqual([]);
  });

  it('OB-505 · P-08: a tag whose long name pushes the price off its label is refused at print, by name, in English and Tamil', async () => {
    const { page: p, errors } = await open(MANAGER, '/shelf-tags/');
    await p.waitForSelector('#choose:not([hidden])');
    await countPrints(p);
    await make(p, 'OIL-LONG\nDAL-500', 'en', 'shelf-70x38');
    await says(p, '#t-status', /^2 tag\(s\) ready to print\.$/);
    await p.waitForSelector('#t-print-status:not([hidden])');
    const said = (await p.textContent('#t-print-status'))!;
    expect(said).toContain('Not printed — these tags do not fit their label');
    expect(said).toContain(LONG_NAME);
    expect(said).not.toContain('Toor dal');
    expect(said).toMatch(/Shorten the product name, or choose the larger tag size/);
    expect(await p.getAttribute('#sheet .tag[data-product="p-long"]', 'data-overflow')).toBe('1');
    expect(await p.getAttribute('#sheet .tag[data-product="p-dal"]', 'data-overflow')).toBeNull();
    await p.click('#t-print');
    expect(await printed(p)).toBe(0);
    await p.selectOption('#t-mode', 'sheet');
    await p.click('#t-print');
    expect(await printed(p)).toBe(0);
    await p.click('#lang');
    await says(p, '#t-print-status', /^அச்சிடப்படவில்லை — இந்தச் சீட்டுகள் லேபிளில் அடங்கவில்லை/);
    expect(await p.textContent('#t-print-status')).toContain(LONG_NAME);
    await p.click('#lang');
    // Without it, the rest prints.
    await make(p, 'DAL-500', 'en', 'shelf-70x38');
    expect(await p.textContent('#t-print-status')).toBe('');
    expect(await p.isHidden('#t-print-status')).toBe(true);
    await p.click('#t-print');
    expect(await printed(p)).toBe(1);
    expect(errors).toEqual([]);
  });

  it('R8-B · OB-525: a price below head office\'s floor is refused; the page asks a second person; approved, the SAME quotation is made', async () => {
    const { page: p, errors } = await open(MANAGER, '/quotations/');
    await p.waitForSelector('#make:not([hidden])');
    expect(await p.isHidden('#q-ask')).toBe(true);
    await p.fill('#q-store', STORE); await p.fill('#q-customer', 'Selvi Traders');
    await p.fill('#l-code', 'DAL-500'); await p.fill('#l-qty', '10'); await p.fill('#l-price', '65');
    await p.click('#l-add');
    await p.waitForSelector('#lines li[data-product="p-dal"]');
    await p.click('#q-make');
    await says(p, '#q-status', /^Head office refused: quoted below the product's floor price: Toor dal 500 g at 65\.00 \(floor 70\.00\)/);
    await p.waitForSelector('#q-ask:not([hidden])');
    await p.click('#q-ask');
    await says(p, '#q-ask-status', /^Approval asked\. .* Its id: areq-/);
    const requestId = ((await p.textContent('#q-ask-status')) ?? '').split(' ').at(-1)!;
    // The owner (who approves prices) approves it in his own session at head office.
    const decided = await ho.request({ method: 'POST', path: `/v1/approvals/requests/${requestId}/decide`, userId: OWNER, tenantId: TENANT, idempotencyKey: `d-${randomUUID()}`, body: { decision: 'approved', reason: 'bulk order for a regular' } });
    expect(decided.status, JSON.stringify(decided.body)).toBeLessThan(300);
    await p.fill('#q-approval', requestId);
    await p.click('#q-make');
    await says(p, '#q-status', /^Quotation made at head office\. Its number — give it to the customer: \d{8}$/);
    expect(await p.isHidden('#q-ask')).toBe(true);
    const number = (await p.textContent('#q-number'))!;
    const asked = await ho.request({ method: 'GET', path: '/v1/pos/quotations', userId: OWNER, tenantId: TENANT });
    expect((asked.body as { quotations: { quotationId: string; marginApprovedBy?: string }[] }).quotations.find((q) => q.quotationId === number)).toMatchObject({ marginApprovedBy: OWNER });
    await p.click('#lang');
    await says(p, '#q-ask-text', /^இந்த விலைக்கு இரண்டாவது நபரின் அனுமதி கேள்$/);
    expect(errors).toEqual([]);
  });

  it('quotations: made with a promised price, numbered, listed, voided with a reason; a cashier is refused the list by head office', async () => {
    const { page: p, errors } = await open(MANAGER, '/quotations/');
    await p.waitForSelector('#make:not([hidden])');
    expect(await p.inputValue('#q-until')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await p.fill('#q-store', STORE); await p.fill('#q-customer', 'Murugan Stores');
    await p.fill('#l-code', 'RICE-25'); await p.fill('#l-qty', '2'); await p.fill('#l-price', '1380');
    await p.click('#l-add');
    await p.waitForSelector('#lines li[data-product="p-rice"]');
    expect(await p.textContent('#lines-total')).toBe('Total: ₹2,760.00');
    await p.click('#q-make');
    // R9-A · OB-532: head office never received the rice at a cost, so its floor is not known — only the OWNER may approve the
    // quotation. The page offers to ask the owner (not "a second person"), for exactly this quotation.
    await says(p, '#q-status', /^Head office refused: head office does not know the lowest price of Ponni rice 25 kg \(never received at a cost\) — only the owner may approve quoting it \(OB-532\)/);
    await p.waitForSelector('#q-ask:not([hidden])');
    await says(p, '#q-ask-text', /^Ask the owner to approve this price$/);
    await p.click('#lang');
    await says(p, '#q-ask-text', /^இந்த விலைக்கு உரிமையாளரின் அனுமதி கேள்$/);
    await p.click('#lang');
    await says(p, '#q-ask-text', /^Ask the owner to approve this price$/);
    await p.click('#q-ask');
    await says(p, '#q-ask-status', /^Owner's approval asked\. .* Its id: areq-/);
    const ownerAsk = ((await p.textContent('#q-ask-status')) ?? '').split(' ').at(-1)!;
    // The manager cannot approve it; the owner does, in his own session at head office.
    expect((await ho.request({ method: 'POST', path: `/v1/approvals/requests/${ownerAsk}/decide`, userId: MANAGER, tenantId: TENANT, idempotencyKey: `d-${randomUUID()}`, body: { decision: 'approved', reason: 'mine' } })).status).toBe(403);
    expect((await ho.request({ method: 'POST', path: `/v1/approvals/requests/${ownerAsk}/decide`, userId: OWNER, tenantId: TENANT, idempotencyKey: `d-${randomUUID()}`, body: { decision: 'approved', reason: 'introductory price for a regular' } })).status).toBeLessThan(300);
    await p.fill('#q-approval', ownerAsk);
    await p.click('#q-make');
    // R8-B · OB-525: head office says it does not know the rice's floor (never a zero floor) — kept on the quotation.
    await says(p, '#q-status', /^Quotation made at head office\. Its number — give it to the customer: \d{8} Head office does not know the floor price of \(never received at a cost\): p-rice\.$/);
    const number = (await p.textContent('#q-number'))!;
    expect(number).toMatch(/^\d{8}$/);

    await p.click('#s-show');
    await p.waitForSelector(`#rows li[data-quotation="${number}"][data-state="issued"]`);
    expect(await p.textContent(`#rows li[data-quotation="${number}"]`)).toMatch(/Murugan Stores · ₹2,760\.00 · Open/);
    await p.fill(`#rows li[data-quotation="${number}"] input[data-act="reason"]`, 'customer bought elsewhere');
    await p.click(`#rows li[data-quotation="${number}"] button[data-act="void"]`);
    await p.waitForSelector(`#rows li[data-quotation="${number}"][data-state="withdrawn"]`);
    expect(await p.textContent(`#rows li[data-quotation="${number}"]`)).toMatch(/voided: customer bought elsewhere/);
    await p.click('#lang');
    await says(p, '#make-h', /^விலைப்புள்ளி உருவாக்கு$/);
    expect(errors).toEqual([]);

    // A cashier the box lets open the page (the list read only) is not offered making one — and head office, which grants a
    // cashier no quotation read at all, refuses the list in its own words.
    const c = await open(CASHIER, '/quotations/');
    await c.page.waitForSelector('#list:not([hidden])');
    expect(await c.page.isHidden('#make')).toBe(true);
    await c.page.click('#s-show');
    await says(c.page, '#s-status', /^Head office refused: /);
    expect(c.errors).toEqual([]);
  });
});
