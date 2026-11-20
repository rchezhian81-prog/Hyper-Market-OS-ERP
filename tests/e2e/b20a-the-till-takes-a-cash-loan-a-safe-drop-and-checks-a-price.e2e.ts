import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';

/**
 * **Batch 20a · T1 and T2 at the till, in a real Chromium against a real store computer with NO head office (P-01):**
 *
 *   • T1 (M14-FR-01): More → "Cash loan (change added to the drawer)" and "Safe drop (cashier puts cash in the safe)", beside
 *     the float and the pickup — each keyed, confirmed with what will be recorded and in whose name, and recorded on the store
 *     computer before the cashier is told. A safe drop bigger than the drawer is refused in words. The close is still BLIND
 *     (nothing on the count panel says what should be there); after the count it says the shift's float, loans, pickups and
 *     safe drops.
 *   • T2 (M12-FR-01 "price enquiry"): More → "Price check (does not add to the bill)" — by a few letters (or a scan) it says
 *     the price, the MRP and the offer in force, and the bill stays EMPTY; no sale is written.
 * English and Tamil. Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['b20a', 'till', 'loan', 'price', 'key'].join('-').padEnd(48, '0');
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();
const POLICIES = { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' };

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version: 3, builtAt: day(0),
    products: [
      { productId: 'P1', sku: 'DAL-1', name: 'Toor dal 1kg', baseUom: 'each', unitPriceMinor: 48_000, taxBps: 0, mrpMinor: 52_000, status: 'active' },
      { productId: 'P2', sku: 'OIL-1', name: 'Groundnut oil 1 L', baseUom: 'each', unitPriceMinor: 19_000, taxBps: 500, status: 'active' },
    ],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }, { code: '8901234567906', productId: 'P2', kind: 'standard' }],
    promotions: [{ id: 'dal-10', kind: 'percent_off' as const, percentBps: 1000, productIds: ['P1'], startsAt: day(-1), endsAt: day(30), status: 'active' as const }],
  } as unknown as CatalogueSnapshot;
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: day(0) });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): unknown[]; operator(): string | undefined } }

describe.skipIf(!HAVE_BROWSER)('batch 20a — the till: a cash loan, a safe drop, and a price check that adds nothing', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name) }); };

  const keyAmount = async (page: Page, rupees: string): Promise<string> => {
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of rupees) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await page.waitForSelector('#sheet:not([hidden]) #consequence:not([hidden])');
    const said = (await page.textContent('#sheet')) ?? '';
    await page.click('#sheet-ok');
    return said;
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

  it('float → cash loan → safe drop (a too-big one refused) → price check adds nothing → blind close says each kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-b20a-till-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: { policies: POLICIES, lossPreventionRules: [] } }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, deviceScaleFactor: 1 });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);

    // No float out: no loan or drop offered yet; the price check is there.
    const before = await moreOffers(page);
    expect(before).toContain('Price check (does not add to the bill)');
    expect(before).not.toContain('Cash loan (change added to the drawer)');
    await choose(page, 'Take float (open the till)');
    await keyAmount(page, '2000');
    await shown(page);

    // The float is out: Pickup, Cash loan and Safe drop sit side by side under "Cash drawer".
    const open = await moreOffers(page);
    expect(open.slice(0, 3)).toEqual(['Pickup (manager takes cash to the safe)', 'Cash loan (change added to the drawer)', 'Safe drop (cashier puts cash in the safe)']);
    await shot(page, 'b20a-till-more-cash-drawer-en-1366.png');
    await choose(page, 'Cash loan (change added to the drawer)');
    const loanSaid = await keyAmount(page, '500');
    expect(loanSaid).toContain('₹500.00 will be recorded as change added to this drawer (a cash loan).');
    expect(await shown(page)).toMatchObject({ title: 'Cash loan recorded — change added to the drawer', text: expect.stringContaining('₹500.00') });

    // A safe drop bigger than the drawer: refused in words, nothing recorded.
    await moreOffers(page);
    await choose(page, 'Safe drop (cashier puts cash in the safe)');
    await keyAmount(page, '9000');
    expect((await shown(page)).text).toContain('The drawer does not hold that much');
    await moreOffers(page);
    await choose(page, 'Safe drop (cashier puts cash in the safe)');
    expect(await keyAmount(page, '1000')).toContain('₹1,000.00 will be recorded as dropped from this drawer into the safe.');
    expect(await shown(page)).toMatchObject({ title: 'Safe drop recorded' });
    const moves = (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [readTillCashRecord(JSON.parse(r.record))] : []));
    expect(moves.map((m) => (m?.kind === 'movement' ? [m.movementKind, m.amountMinor, m.custodianId] : m?.kind))).toEqual([['float_issue', 200_000, 'u-lanecash'], ['loan', 50_000, 'u-lanecash'], ['safe_drop', 100_000, 'u-lanecash']]);

    // T2: a price check by a few letters — the answer, and the bill stays empty; no sale is written.
    await moreOffers(page);
    await choose(page, 'Price check (does not add to the bill)');
    await page.waitForSelector('#sheet:not([hidden]) #entry-text');
    await page.fill('#entry-text', 'toor');
    await page.waitForSelector('#finds button');
    await page.click('#finds button:nth-child(1)');
    const priced = await (async () => { await page.waitForSelector('#refusal:not([hidden])'); await shot(page, 'b20a-till-price-check-en-1366.png'); return shown(page); })();
    expect(priced.title).toBe('Price check — Toor dal 1kg');
    expect(priced.text).toContain('Toor dal 1kg: ₹480.00. MRP ₹520.00. Offer: 10% off');
    expect(priced.text).toContain('Nothing was added to the bill.');
    // …and by a scan into the same panel.
    await moreOffers(page);
    await choose(page, 'Price check (does not add to the bill)');
    await page.waitForSelector('#sheet:not([hidden]) #entry-text');
    await page.fill('#entry-text', '8901234567906');
    await page.press('#entry-text', 'Enter');
    expect((await shown(page)).text).toContain('Groundnut oil 1 L: ₹190.00. No offer on this item now.');
    expect(await page.$$eval('#lines tr', (r) => r.length)).toBe(0);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length)).toBe(0);
    expect((await readLog(edge.log.path)).length).toBe(0); // no sale on the store computer

    // Tamil: the same choices in Tamil, and a price check in Tamil.
    await page.click('#lang');
    const ta = await moreOffers(page);
    expect(ta).toContain('பணக் கடன் (டிராயருக்குச் சில்லறை சேர்)');
    expect(ta).toContain('பெட்டகத்தில் போடு (காசாளர் பணத்தைப் பெட்டகத்தில் போடுகிறார்)');
    expect(ta).toContain('விலை பார் (பில்லில் சேர்க்காது)');
    await shot(page, 'b20a-till-more-cash-drawer-ta-1366.png');
    await choose(page, 'விலை பார் (பில்லில் சேர்க்காது)');
    await page.waitForSelector('#sheet:not([hidden]) #entry-text');
    await page.fill('#entry-text', '8901234567890');
    await page.press('#entry-text', 'Enter');
    await page.waitForSelector('#refusal:not([hidden])');
    await shot(page, 'b20a-till-price-check-ta-1366.png');
    expect((await shown(page)).text).toContain('பில்லில் எதுவும் சேர்க்கப்படவில்லை');
    await page.click('#lang');

    // The close is blind; afterwards it says each kind. 2,000 + 500 − 1,000 = ₹1,500: three ₹500.
    await moreOffers(page);
    await choose(page, 'Close till');
    await page.waitForSelector('#count:not([hidden])');
    expect(await page.textContent('#count')).not.toMatch(/1,500|loan|safe drop/i);
    for (let i = 0; i < 3; i += 1) await page.click('button[aria-label="one more ₹500.00"]');
    await page.click('#count-ok');
    await page.waitForSelector('#refusal:not([hidden])');
    await shot(page, 'b20a-till-close-says-each-kind-en-1366.png');
    const closed = await shown(page);
    expect(closed.title).toBe('The drawer balances exactly.');
    expect(closed.text).toContain('This shift: float ₹2,000.00 · cash loans ₹500.00 · pickups ₹0.00 · safe drops ₹1,000.00.');
    const records = (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [readTillCashRecord(JSON.parse(r.record))] : []));
    expect(records.at(-1)).toMatchObject({ kind: 'close', openingFloatMinor: 250_000, pickupsMinor: 100_000, expectedMinor: 150_000, varianceMinor: 0, loansMinor: 50_000, safeDropsMinor: 100_000 });
  }, 120_000);
});
