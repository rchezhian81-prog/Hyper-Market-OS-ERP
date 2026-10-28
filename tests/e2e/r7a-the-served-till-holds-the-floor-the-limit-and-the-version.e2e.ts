import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { readLog } from '../../edge/store-edge/src/file-log';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInOnPage, pinOf } from '../support/till-operator';

/**
 * **OB-500 · OB-501 (R7-A) in a real browser, on the till the store computer serves, with NO head office at all.**
 *
 *   • OB-500 — the store pack says Ghee's lowest price is ₹500 and the manager may take ₹100 off a line. Through the till's
 *     own More → "Change price of the selected line": ₹450 is refused at once, in English and then in Tamil, before any
 *     manager is asked; ₹520 (₹120 off) is refused when the manager approves (above their ₹100); ₹550 goes through.
 *   • OB-501 — the store pack says this build is below the minimum supported version. A scan on an empty till is refused
 *     in plain words ("Update this till"). A bill that was already in progress when the rule arrived (the box's badge poll)
 *     is finished and paid; the next bill is refused; the bill on the box's disk carries the store computer's mark.
 *
 * Skips where no browser binary is present. Screenshots only when SRE_SHOTS names a directory. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['r7a', 'till', 'floor', 'version', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const GHEE = '8900000000808';
const SOAP = '8900000000815';
const PEOPLE = [
  { userId: 'u-lanecash', displayName: 'Lane Cashier' },
  { userId: 'u-manager', displayName: 'Manager', permissions: ['pos.sale.sync', 'pos.return.approve', 'pos.override.approve'] },
];
const TILL_CONTROLS = { floors: { 'P-GHEE': 50_000 }, floorsNotKnown: ['P-SOAP'], overrideLimits: { 'u-manager': { state: 'limit', limitMinor: 10_000 } }, limitsVersion: 1, ownerApprovers: ['u-owner'] };
const TOO_NEW = { currentVersion: '99.0.0', previousVersion: '98.0.0', minimumSupportedVersion: '98.0.0' };

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 5, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-GHEE', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'ea', unitPriceMinor: 64_000, taxBps: 1200, status: 'active' },
      // R8-A · OB-520: never received at a cost — no known floor.
      { productId: 'P-SOAP', sku: 'SOAP-1', name: 'New soap', baseUom: 'ea', unitPriceMinor: 4_000, taxBps: 1800, status: 'active' },
    ],
    barcodes: [{ code: GHEE, productId: 'P-GHEE', kind: 'standard' }, { code: SOAP, productId: 'P-SOAP', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; basket(): { lineId: string; unitPriceMinor: number }[]; applyVersionPolicy(p: unknown): { verdict: string } };
  readonly posBadge?: { refresh(): Promise<void> };
}

const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
  + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').startsWith(${JSON.stringify(startsWith)}); })()`,
  undefined, { timeout: 15_000 },
);
const sheetTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'sheet', 'sheet-title', s);
const panelTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'pay', 'pay-title', s);
/** Wait for the refusal panel to say these words (never read in the same tick as the change — CI flakes on that). */
const refusalSays = (page: Page, words: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById('refusal'); return p !== null && !p.hidden && (p.textContent || '').includes(${JSON.stringify(words)}); })()`,
  undefined, { timeout: 15_000 },
);

describe.skipIf(!HAVE_BROWSER)('R7-A: the served till holds the lowest price, the manager\'s limit and the app version — offline', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function till(pack: Record<string, unknown>): Promise<{ edge: EdgeProcess; page: Page }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r7a-till-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    // No cloud configured: the store computer and the till judge on their own (P-01).
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      ...await prepareTillBox({ dir, key: KEY, people: PEOPLE, pack: { version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [], ...pack } }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    await signInOnPage(page);
    return { edge, page };
  }
  const scan = async (page: Page, code: string): Promise<void> => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const askNewPrice = async (page: Page, rupees: string, lang: 'en' | 'ta' = 'en'): Promise<void> => {
    await page.click('#lines tr:first-child');
    await page.click('#more');
    await panelTitled(page, lang === 'en' ? 'More' : 'மேலும்');
    await page.click(`#pay-kinds button:text-is("${lang === 'en' ? 'Change price of the selected line' : 'தேர்ந்த வரியின் விலையை மாற்று'}")`);
    await page.waitForSelector('#sheet:not([hidden])', { timeout: 15_000 });
    for (const digit of rupees) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
  };
  const managerApproves = async (page: Page): Promise<void> => {
    await sheetTitled(page, 'Manager: scan your badge or key your staff ID');
    await page.keyboard.type('u-manager');
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: your till PIN');
    await page.keyboard.type(pinOf('u-manager'));
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: why is this allowed?');
    await page.click('#reasons button:text-is("Damaged pack, sold as is")');
    await page.click('#sheet-ok');
  };

  it('OB-500: ₹450 refused at the till (English, then Tamil) before a manager is asked; ₹120 off refused above the manager\'s ₹100; ₹90 off goes through', async () => {
    const { edge, page } = await till({ tillControls: TILL_CONTROLS });
    await scan(page, GHEE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);

    await askNewPrice(page, '450');
    await refusalSays(page, 'below the lowest price this item may be sold at (₹500.00)');
    if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'till-below-lowest-price.png') }); }
    await page.click('#refusal-ok');

    await page.click('#lang'); // Tamil
    await page.waitForFunction("document.documentElement.lang === 'ta'");
    await askNewPrice(page, '450', 'ta');
    await refusalSays(page, 'குறைந்தபட்ச விலைக்கு (₹500.00) கீழே');
    await page.click('#refusal-ok');
    await page.click('#lang'); // back to English
    await page.waitForFunction("document.documentElement.lang !== 'ta'");

    await askNewPrice(page, '520');
    await managerApproves(page);
    await refusalSays(page, 'more than Manager\'s limit of ₹100.00');
    await page.click('#refusal-ok');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket()[0]!.unitPriceMinor)).toBe(64_000);

    await askNewPrice(page, '550');
    await managerApproves(page);
    await shows(page, 'refusal', 'refusal-title', 'Price changed');
    await page.click('#refusal-ok');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket()[0]!.unitPriceMinor)).toBe(55_000);
    const onBox = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []))
      .filter((e) => e.type === 'TillActivityRecorded');
    expect(onBox.map((e) => [e.payload['kind'], e.payload['toUnitMinor'], e.payload['valueMinor'], e.payload['approvedBy']])).toEqual([['price_override', 55_000, 9_000, 'u-manager']]);
  }, 120_000);

  it('OB-520 (R8-A): a product with no known floor — the till says only the owner can approve; the box refuses the manager, offline', async () => {
    const { page } = await till({ tillControls: TILL_CONTROLS });
    await scan(page, SOAP);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await askNewPrice(page, '35');
    await sheetTitled(page, 'Manager: scan your badge or key your staff ID');
    await page.waitForFunction("(document.getElementById('entry-hint')?.textContent || '').includes('Only the owner can approve a price cut on this item')", undefined, { timeout: 15_000 });
    await page.keyboard.type('u-manager');
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: your till PIN');
    await page.keyboard.type(pinOf('u-manager'));
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: why is this allowed?');
    await page.click('#reasons button:text-is("Damaged pack, sold as is")');
    await page.click('#sheet-ok');
    await refusalSays(page, 'only the owner can approve a price cut of ₹5.00');
    await page.click('#refusal-ok');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket()[0]!.unitPriceMinor)).toBe(4_000);
  }, 120_000);

  it('OB-501: a too-old build refuses a new bill in plain words; a bill already in progress is finished and paid; the next is refused; the box marks the bill', async () => {
    const { edge, page } = await till({ versionPolicy: TOO_NEW });
    await scan(page, GHEE);
    await refusalSays(page, 'a new bill cannot be started until the till is updated');
    expect(await page.textContent('#refusal-title')).toBe('Update this till');
    if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'till-update-this-till.png') }); }
    await page.click('#refusal-ok');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length)).toBe(0);

    // A bill that was already on the till when the rule arrived: start one with the rule lifted, then let the box's badge
    // poll bring the rule back mid-bill — the bill is finished, never interrupted.
    await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.applyVersionPolicy(null));
    await scan(page, GHEE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await page.evaluate(() => (globalThis as unknown as PosWindow).posBadge!.refresh());
    await scan(page, GHEE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 2);
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    await page.click('#refusal-ok');

    // The next bill is refused.
    await scan(page, GHEE);
    await refusalSays(page, 'too old');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length)).toBe(0);

    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    expect(JSON.parse(first.record)).toMatchObject({ appVersion: '0.0.0', storeComputerVersionCheck: { verdict: 'upgrade_required', minimumSupportedVersion: '98.0.0' } });
  }, 120_000);
});
