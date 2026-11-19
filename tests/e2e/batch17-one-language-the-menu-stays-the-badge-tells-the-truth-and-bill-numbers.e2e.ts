import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { financialYearLabel } from '../../packages/numbering/src/document-numbers';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { apiHarness } from '../support/api-harness';
import { prepareTillBox, pinOf, signInThroughScreen, takeFloatOnPage } from '../support/till-operator';

/**
 * **Batch 17 (owner, 19 Nov 2026, store PC 1.0.2246, signed in as the owner) — in a real Chromium, on a store-PC copy as
 * installed (office PIN sign-in on, the store setup from head office's own builder):**
 *
 *   • D-067 · OB-855 — ONE language at a time. Every office page opens in English only: the menu rows, the page title, Today's
 *     card names, table headings and status words carry no Tamil. Pressing தமிழ் shows Tamil only (no English beside it),
 *     and the next page opens in Tamil — remembered on this device. Pressing English goes back.
 *   • D-068 — the menu does not close by itself or jump to the top: "More" and a workspace the person opened stay open on
 *     the next page, the list keeps its scroll position, and the page being shown is in view.
 *   • D-069 — the badge tells the truth: on the store PC it answers (never "Store computer not answering" while the store
 *     computer is on); with only the till's socket unreachable it says so; with nothing answering it says the till service
 *     is not running.
 *   • D-070 — bill numbers: a freshly installed store computer whose till head office has registered numbers its first sale
 *     1L01/<YY-YY>/00001, and Today's Recent activity shows that number. A till head office has NOT registered numbers under
 *     a temporary 1T01 range, and the till's screen says so plainly and what to do.
 *
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['batch17', 'store', 'pc', 'key'].join('-').padEnd(48, '0');
const DAL = '8901234567890';
const TAMIL = /[஀-௿]/;
const LATIN_WORD = /[A-Za-z]{3,}/;
const OWNER_PERMISSIONS = [...(ROLE_CATALOGUE.find((r) => r.id === 'owner') as unknown as { permissions: readonly string[] }).permissions];
const STORE = 'store-1';

function signedCatalogue(tenantId: string) {
  const snapshot: CatalogueSnapshot = {
    tenantId, version: 3, builtAt: new Date().toISOString(),
    products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, hsnCode: '071360', status: 'active' }],
    barcodes: [{ code: DAL, productId: 'P1', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-owner', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

/** Head office's own `receiptNumbering` section for the store, from the real API (in memory) — with or without lane-1 registered. */
async function headOfficeNumbering(registerTill: boolean): Promise<{ tenantId: string; section: unknown }> {
  const h = apiHarness();
  const tenantId = randomUUID();
  let n = 0;
  const ok = async (path: string, body: unknown): Promise<void> => {
    const r = await h.request({ method: 'POST', path, userId: 'u-owner', tenantId, idempotencyKey: `b17-${n += 1}`, body });
    if (r.status >= 300) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
  };
  await h.seedOwner(tenantId, 'u-owner');
  await h.provisionRole(tenantId, 'u-box', 'store_computer', [STORE]);
  await ok('/v1/org/nodes/SRE', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
  await ok(`/v1/org/nodes/${STORE}`, { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
  await ok(`/v1/stores/${STORE}/settings`, { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
  if (registerTill) await ok('/v1/platform/devices/lane-1/register', { branchId: STORE, kind: 'pos_lane', label: 'Till 1' });
  const served = await h.request({ method: 'GET', path: `/v1/store-packs/${STORE}`, userId: 'u-box', tenantId, branchId: STORE });
  if (served.status !== 200) throw new Error(`store pack: ${served.status} ${JSON.stringify(served.body)}`);
  return { tenantId, section: (served.body as { sections: Record<string, unknown> }).sections['receiptNumbering'] };
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): unknown[] } }

describe.skipIf(!HAVE_BROWSER)('batch 17 — one language at a time, the menu stays, the badge tells the truth, the bill numbers', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name) }); };

  /** A store PC as installed: office PIN sign-in, its lane, the store setup with head office's numbering section. */
  async function storePc(numbering: { tenantId: string; section: unknown }): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-b17-'));
    dirs.push(dir, `${dir}-witness`);
    await writeSignedPack(dir, signedCatalogue(numbering.tenantId));
    const pack = {
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
      servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
      lossPreventionRules: [],
      receiptNumbering: numbering.section,
      // the owner holds the product's own owner role, as head office's store setup says
      roles: [{ id: 'owner', name: 'Owner', permissions: OWNER_PERMISSIONS }],
      roleAssignments: [{ userId: 'u-owner', roleId: 'owner', branchScope: 'all' }],
    };
    const people = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-owner', displayName: 'The Owner' }];
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: numbering.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_OFFICE_SIGN_IN: 'pin',
      ...await prepareTillBox({ dir, key: KEY, pack, people }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.screens!.port}` };
  }
  async function owner(base: string, width = 1366, height = 768): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/manager/`, { waitUntil: 'load' });
    await page.fill('#office-staff', 'u-owner');
    await page.fill('#office-pin', pinOf('u-owner'));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    try { await page.waitForFunction('globalThis.sreChrome !== undefined'); } catch { throw new Error(`${page.url()}: ${(await page.textContent('#office-problem').catch(() => null)) ?? (await page.textContent('h1'))}`); }
    return { context, page, errors };
  }
  const menuRows = (page: Page): Promise<string[]> => page.$$eval('#sre-menu .group-section a', (as) => as.map((a) => (a.textContent ?? '').trim()));
  const go = async (page: Page, url: string): Promise<void> => { await page.goto(url, { waitUntil: 'load' }); await page.waitForFunction('globalThis.sreChrome !== undefined'); };

  it('D-067 · OB-855: English only until தமிழ் is pressed; then Tamil only, remembered on the next page; English again on the switch', async () => {
    const { base } = await storePc(await headOfficeNumbering(true));
    const { page, errors } = await owner(base);
    // Today, in English: the title, the cards, the headings — not one Tamil letter; the menu rows the same
    expect(await page.evaluate('document.documentElement.lang')).toBe('en');
    expect((await page.textContent('#who'))!.trim()).toMatch(/^Today\b/);
    expect(await page.textContent('#who')).not.toMatch(TAMIL);
    expect(await page.$('#who-twin')).toBeNull();
    for (const sel of ['#kpis', '#chart-title', '#recent-title', '#home-title']) {
      const text = await page.textContent(sel);
      if (text !== null) expect(text, `${sel} in English`).not.toMatch(TAMIL);
    }
    const english = await menuRows(page);
    expect(english.length).toBeGreaterThan(5);
    for (const row of english) expect(row, 'a menu row in English').not.toMatch(TAMIL);
    expect(await page.$$eval('#sre-menu [data-twin], #sre-menu .sre-twin', (x) => x.length)).toBe(0);
    await shot(page, 'b17-today-en.png');

    // தமிழ்: the same page in Tamil only — no English twin beside any menu row or the title
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "ta"');
    await expect.poll(async () => (await menuRows(page)).some((r) => TAMIL.test(r))).toBe(true);
    const tamil = await menuRows(page);
    expect(tamil.filter((r) => LATIN_WORD.test(r) && !/\b(GST|UPI|HSN|SKU|PO|ERP|ID|PIN|AI|ESL|OTP|SMS|EPR|CERT|IN|FSSAI|TDS|TCS|BIS|RFQ|Tally|B2B|GSTR-\w+)\b/.test(r)), 'Tamil rows carry no English words').toEqual([]);
    expect((await page.textContent('#who'))!.trim()).toMatch(/^இன்று/);
    expect(await page.textContent('#who')).not.toMatch(/Today/);
    for (const sel of ['#kpis .kpi-label']) {
      for (const label of await page.$$eval(sel, (els) => els.map((e) => (e.textContent ?? '').trim()))) expect(label).not.toMatch(/[A-Za-z]/);
    }
    await shot(page, 'b17-today-ta.png');

    // the choice is remembered on this device: the next page opens in Tamil
    await go(page, `${base}/goods-receipt/`);
    await page.waitForFunction('document.documentElement.lang === "ta"', undefined, { timeout: 10_000 });
    expect(await page.textContent('#lang')).toContain('English');
    await shot(page, 'b17-goods-receipt-ta.png');
    // and English again on the switch — remembered too
    await page.click('#lang');
    await page.waitForFunction('document.documentElement.lang === "en"');
    await go(page, `${base}/manager/`);
    await page.waitForTimeout(300);
    expect(await page.evaluate('document.documentElement.lang')).toBe('en');
    expect(await page.textContent('#who')).not.toMatch(TAMIL);
    expect(errors).toEqual([]);
  }, 180_000);

  it('D-068: "More" and an opened workspace stay open on the next page; the list keeps its place; the page shown is in view', async () => {
    const { base } = await storePc(await headOfficeNumbering(true));
    const { page, errors } = await owner(base, 1366, 600);
    const more = '#sre-menu .sre-more-toggle';
    expect(await page.getAttribute(more, 'aria-expanded')).toBe('false');
    await page.click(more);
    // open the last workspace under "More" that holds an office page, and scroll the list down to it
    const pick = await page.evaluate(`(() => {
      const sections = [...document.querySelectorAll('#sre-menu .sre-more .group-section')].reverse();
      for (const s of sections) {
        const links = [...s.querySelectorAll('a')].filter((a) => /^\\/(users|audit-log|admin|setup|branches|switches|keys|access-review|failed-jobs|store-computers|fleet)\\//.test(a.getAttribute('href') || ''));
        if (links.length > 0) return { key: s.dataset.key, href: links[links.length - 1].getAttribute('href') };
      }
      return null;
    })()`) as { key: string; href: string } | null;
    expect(pick).not.toBeNull();
    const key = pick!.key;
    const last = page.locator(`#sre-menu .sre-more .group-section[data-key="${key}"]`);
    if ((await last.locator('.group-toggle').getAttribute('aria-expanded')) !== 'true') await last.locator('.group-toggle').click();
    const target = last.locator(`a[href="${pick!.href}"]`);
    await target.scrollIntoViewIfNeeded();
    const scrolled = await page.evaluate('document.querySelector("#sre-menu .groups").scrollTop') as number;
    expect(scrolled).toBeGreaterThan(100);
    const href = await target.getAttribute('href');
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), target.click()]);
    await page.waitForFunction('globalThis.sreChrome !== undefined');
    // nothing closed by itself
    expect(await page.getAttribute(more, 'aria-expanded')).toBe('true');
    expect(await page.getAttribute(`#sre-menu .group-section[data-key="${key}"] .group-toggle`, 'aria-expanded')).toBe('true');
    // not back at the top: the list stands where it was, and the page being shown is in view
    const after = await page.evaluate('document.querySelector("#sre-menu .groups").scrollTop') as number;
    expect(after).toBeGreaterThan(100);
    const inView = await page.evaluate(`(() => { const l = document.querySelector('#sre-menu .groups'); const a = l.querySelector('a[aria-current="page"]'); if (!a) return null;
      const lr = l.getBoundingClientRect(); const ar = a.getBoundingClientRect(); return ar.top >= lr.top - 1 && ar.bottom <= lr.bottom + 1; })()`);
    expect(inView, `the current row (${href}) is in view`).toBe(true);
    await shot(page, 'b17-menu-kept.png');
    // a page opened from the TOP of the list keeps "More" open too, and its row is in view
    await go(page, `${base}/manager/`);
    expect(await page.getAttribute(more, 'aria-expanded')).toBe('true');
    const todayInView = await page.evaluate(`(() => { const l = document.querySelector('#sre-menu .groups'); const a = l.querySelector('a[aria-current="page"]');
      const lr = l.getBoundingClientRect(); const ar = a.getBoundingClientRect(); return ar.top >= lr.top - 1 && ar.bottom <= lr.bottom + 1; })()`);
    expect(todayInView).toBe(true);
    // the person closes "More": it stays closed
    await page.click(more);
    await go(page, `${base}/approvals/`); // a daily page (a page that lives under "More" opens it, as before)
    expect(await page.getAttribute(more, 'aria-expanded')).toBe('false');
    expect(errors).toEqual([]);
  }, 180_000);

  it('D-069: on the store PC the badge answers; the till socket alone unreachable is said; nothing answering says the till service is not running', async () => {
    const { base } = await storePc(await headOfficeNumbering(true));
    const { page } = await owner(base);
    // Today on the store PC: whatever figures it lacks, the store computer answers — never "Not connected" or "not answering"
    await page.waitForFunction('!/Checking/.test(document.getElementById("conn-text").textContent)');
    expect(await page.textContent('#conn-text')).not.toMatch(/^Not connected|not answering|not running/);
    await go(page, `${base}/goods-receipt/`);
    // the store PC answers: never "not answering"
    await page.waitForFunction('!/Checking/.test(document.getElementById("conn-text").textContent)');
    const said = (await page.textContent('#conn-text'))!;
    expect(said).not.toMatch(/not answering|not running/i);
    expect(await page.getAttribute('#sre-badge', 'data-tone')).not.toBe('error');
    await shot(page, 'b17-badge-store-pc.png');
    // only the till's socket unreachable from this page (its other port): said as that, in plain words
    const laneBase = await page.evaluate('window.laneWriteBase') as string;
    await page.route(`${laneBase}/**`, (r) => r.abort('connectionrefused'));
    await page.evaluate('window.sreChrome.badge.refresh()');
    await page.waitForFunction('document.getElementById("conn-text").textContent === "Store computer on, but its till service did not answer this page"');
    expect(await page.getAttribute('#sre-badge', 'data-tone')).toBe('error');
    // nothing answering at all: the till service is not running
    await page.route(`${base}/sre-box/**`, (r) => r.abort('connectionrefused'));
    await page.evaluate('window.sreChrome.badge.refresh()');
    await page.waitForFunction('document.getElementById("conn-text").textContent === "Till service not running on this computer"');
    // in Tamil, the same in Tamil only
    await page.click('#lang');
    await page.waitForFunction('document.getElementById("conn-text").textContent === "இந்தக் கணினியில் விற்பனை முனையச் சேவை இயங்கவில்லை"');
    await page.click('#lang');
  }, 180_000);

  async function ringASale(base: string): Promise<{ page: Page; context: BrowserContext; receipt: string }> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${base}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    await takeFloatOnPage(page);
    await page.keyboard.type(DAL);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await page.click('#tender');
    await page.waitForFunction('(() => { const t = document.getElementById("pay-title"); return t && (t.textContent || "").includes("How is the customer paying?"); })()');
    await page.click('#pay-kinds button:first-child');
    await page.waitForFunction('(() => { const t = document.getElementById("sheet-title"); return t && (t.textContent || "").includes("Cash received"); })()');
    await page.click('#quick button:first-child');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    return { page, context, receipt: (await page.textContent('#refusal-receipt')) ?? '' };
  }

  it('D-070: a fresh store PC whose till head office registered numbers its first sale 1L01/YY-YY/00001, and Today lists it', async () => {
    const yy = financialYearLabel(new Date().toISOString());
    const numbering = await headOfficeNumbering(true);
    expect(numbering.section).toMatchObject({ formatA: { storeNumber: 1, laneCodes: { 'lane-1': 'L01' } } });
    const { edge, base } = await storePc(numbering);
    const { page: till, receipt } = await ringASale(base);
    const bill = `1L01/${yy}/00001`;
    expect(receipt).toContain(bill);
    expect(receipt).not.toMatch(/temporary range/);
    const sale = (await readLog(edge.log.path)).map((r) => (r.ok ? JSON.parse(r.record) as { number: string } : null))[0]!;
    expect(sale.number).toBe(bill);
    await shot(till, 'b17-till-first-bill.png');
    // the office: Today's Recent activity shows the bill under its format-A number
    const { page } = await owner(base);
    await page.waitForFunction(`[...document.querySelectorAll('#recent tr[data-sale] td')].some((td) => td.textContent === ${JSON.stringify(bill)})`, undefined, { timeout: 15_000 });
    await shot(page, 'b17-today-recent-bill.png');
  }, 180_000);

  it('D-070: a till head office has not registered numbers under a temporary 1T01 range, and the till says so and what to do', async () => {
    const yy = financialYearLabel(new Date().toISOString());
    const numbering = await headOfficeNumbering(false);
    expect(numbering.section).toMatchObject({ formatA: { storeNumber: 1, laneCodes: {} } });
    const { base } = await storePc(numbering);
    const { page, receipt } = await ringASale(base);
    expect(receipt).toContain(`1T01/${yy}/00001`);
    // the till's own words under the bill: what happened and what to do
    const said = (await page.textContent('#refusal-text')) ?? '';
    expect(said).toContain(`1T01/${yy}/00001`);
    expect(said).toMatch(/Head office has not given this till its lane code \(L01, L02, …\) yet/);
    expect(said).toMatch(/register this till on the Tills & devices page/);
    await shot(page, 'b17-till-no-code.png');
  }, 180_000);
});
