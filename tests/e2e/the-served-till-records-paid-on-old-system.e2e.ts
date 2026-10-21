import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';

/**
 * **The mirror pilot on the served till (OB-256 · OB-258), in a real Chromium against a real store box.**
 *
 * With the store computer set for the mirror pilot (and guest sales only), the till SAYS so under its header — in English,
 * and in Tamil after the language button. Tender offers ONE way to pay, "Paid on old system" for the whole bill, and the
 * sale lands on the box with that tender and no cash. A refund against the bill offers only "Paid on old system" and says
 * not to take money from the drawer; an Exchange explains it is a refund then a sale. All again in Tamil. With the setting
 * off, none of it shows and "Paid on old system" is never offered.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'mirror', 'tender', 'key'].join('-').padEnd(48, '0');
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  // A high threshold, so the screen walk reaches the outcome without a manager (the approval rule is proven elsewhere).
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 500, status: 'active' }],
};

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; mirrorPilot(): boolean; basket(): unknown[] } }

describe.skipIf(!HAVE_BROWSER)('the served till records "Paid on old system" in the mirror pilot (OB-256 · OB-258)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const till = async (mirror: boolean): Promise<{ page: Page; edge: EdgeProcess }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-mirror-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_GUEST_SALES_ONLY: '1', ...(mirror ? { EDGE_MIRROR_PILOT: '1' } : {}),
      ...await prepareTillBox({ dir, key: KEY, pack: PACK }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { page, edge };
  };
  const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
    `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
    + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').includes(${JSON.stringify(startsWith)}); })()`,
    undefined, { timeout: 15_000 },
  );
  const options = (page: Page): Promise<string[]> => page.$$eval('#pay-kinds button', (b) => b.map((x) => (x.textContent ?? '').trim()));
  const scan = async (page: Page, items: number): Promise<void> => {
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => (globalThis as unknown as PosWindow).posSession!.basket().length === n, items);
  };
  const said = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const out = { title: (await page.textContent('#refusal-title')) ?? '', text: (await page.textContent('#refusal-text')) ?? '' };
    await page.click('#refusal-ok');
    return out;
  };

  it('on: said under the header; Tender offers only "Paid on old system"; the sale lands with it; a refund goes back to it — English and Tamil', async () => {
    const { page, edge } = await till(true);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.mirrorPilot())).toBe(true);
    await page.waitForSelector('#mirror-pilot:not([hidden])');
    expect(await page.textContent('#mirror-pilot')).toContain('Mirror pilot: the customer is billed and pays on the old system');

    // ── A sale, in English: one way to pay, for the whole bill.
    await scan(page, 1);
    await page.click('#tender');
    await shows(page, 'pay', 'pay-title', 'How is the customer paying?');
    expect(await options(page)).toEqual([expect.stringMatching(/^Paid on old system — ₹\s?480(\.00)?$/)]);
    await page.click('#pay-kinds button:first-child');
    // OB-264: the old system's bill number for this bill, typed before it is saved.
    await shows(page, 'sheet', 'sheet-title', 'Old bill number');
    await page.fill('#entry-text', 'OLD/1');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ title: expect.stringContaining('Recorded — paid on old system'), text: expect.stringContaining('No money in this drawer') });
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    const sale = JSON.parse(first!.ok ? first!.record : '{}') as { number: string; oldErpBillNumber: string; tenders: { kind: string; amount: { minor: number } }[]; taxMinor: number };
    expect(sale.oldErpBillNumber).toBe('OLD/1');
    expect(sale.tenders).toEqual([expect.objectContaining({ kind: 'paid_on_old_erp', amount: expect.objectContaining({ minor: 48_000 }) })]);
    expect(sale.taxMinor).toBeGreaterThan(0); // GST inside, as on every bill

    // ── The refund against that bill: only "Paid on old system", and the till says not to open the drawer.
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Refund")');
    // OB-264: in the mirror pilot the customer holds the old system's bill, so the till asks for ITS number.
    await shows(page, 'sheet', 'sheet-title', 'Old bill number on the customer\'s bill');
    await page.fill('#entry-text', 'OLD/1');
    await page.keyboard.press('Enter');
    await shows(page, 'pay', 'pay-title', 'Which item is coming back?');
    await page.click('#pay-kinds button:first-child');
    await shows(page, 'sheet', 'sheet-title', 'How many are coming back?');
    await page.click('#sheet-ok');
    await shows(page, 'sheet', 'sheet-title', 'Why is it coming back?');
    await page.click('#reasons button:text-is("Damaged / faulty")');
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'What condition is the item in?');
    await page.click('#pay-kinds button:text-is("Good — back on the shelf")');
    await shows(page, 'sheet', 'sheet-title', 'How much to refund?');
    for (const digit of '480') await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'How is the refund given?');
    expect(await options(page)).toEqual(['Paid on old system']);
    await page.click('#pay-kinds button:first-child');
    expect(await said(page)).toMatchObject({ title: expect.stringContaining('Refund recorded'), text: expect.stringContaining('Do not take money from this drawer') });
    await expect.poll(async () => (await readLog(edge.returnsLog.path)).length, { timeout: 10_000 }).toBe(1);
    const [back] = await readLog(edge.returnsLog.path);
    expect(JSON.parse(back!.ok ? back!.record : '{}')).toMatchObject({ refundTender: 'paid_on_old_erp', refundMinor: 48_000 });

    // ── An exchange is a refund, then a sale.
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Exchange")');
    expect(await said(page)).toMatchObject({ title: expect.stringContaining('Mirror pilot'), text: expect.stringContaining('exchanges are done on the old till only') });

    // ── Tamil: the strip, the one way to pay, and the outcome.
    await page.click('#lang');
    expect(await page.textContent('#mirror-pilot')).toContain('மிரர் பைலட்: வாடிக்கையாளருக்குப் பழைய பில்லிங் அமைப்பில் பில் போடப்பட்டு');
    await scan(page, 1);
    await page.click('#tender');
    await shows(page, 'pay', 'pay-title', 'வாடிக்கையாளர் எவ்வாறு பணம் தருகிறார்?');
    expect(await options(page)).toEqual([expect.stringMatching(/^பழைய பில்லிங் அமைப்பில் செலுத்தப்பட்டது — ₹\s?480(\.00)?$/)]);
    await page.click('#pay-kinds button:first-child');
    await shows(page, 'sheet', 'sheet-title', 'பழைய பில் எண்');
    await page.fill('#entry-text', 'OLD/2');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ title: expect.stringContaining('பதிவு செய்யப்பட்டது — பழைய பில்லிங் அமைப்பில் செலுத்தப்பட்டது'), text: expect.stringContaining('இந்த டிராயரில் பணம் இல்லை') });
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(2);
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'மேலும்');
    await page.click('#pay-kinds button:text-is("பரிமாற்றம்")');
    expect(await said(page)).toMatchObject({ title: expect.stringContaining('மிரர் பைலட்'), text: expect.stringContaining('பரிமாற்றம் பழைய கல்லாவில் மட்டுமே') });
  }, 90_000);

  it('off: nothing is shown and "Paid on old system" is never offered — for a sale or a refund', async () => {
    const { page } = await till(false);
    expect(await page.isHidden('#mirror-pilot')).toBe(true);
    await scan(page, 1);
    await page.click('#tender');
    await shows(page, 'pay', 'pay-title', 'How is the customer paying?');
    const pay = await options(page);
    expect(pay.join('|')).toMatch(/Cash/);
    expect(pay.join('|')).not.toMatch(/Paid on old system/);
    await page.click('#pay-cancel');
    // A return without a receipt, walked to its "how is the refund given?" step.
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Return without receipt")');
    await shows(page, 'sheet', 'sheet-title', 'Scan the item coming back');
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await shows(page, 'sheet', 'sheet-title', 'How many are coming back?');
    await page.click('#sheet-ok');
    await shows(page, 'sheet', 'sheet-title', 'Why is it coming back?');
    await page.click('#reasons button:text-is("Damaged / faulty")');
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'What condition is the item in?');
    await page.click('#pay-kinds button:text-is("Good — back on the shelf")');
    await shows(page, 'sheet', 'sheet-title', 'How much to refund?');
    for (const digit of '100') await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'How is the refund given?');
    const back = await options(page);
    expect(back).toEqual(expect.arrayContaining(['Cash', 'Card', 'UPI']));
    expect(back).not.toContain('Paid on old system');
  }, 90_000);
});
