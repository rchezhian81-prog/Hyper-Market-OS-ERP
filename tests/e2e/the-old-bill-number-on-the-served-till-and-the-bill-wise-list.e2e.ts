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
 * **OB-264 (owner, 20 Oct 2026, "Key old bill number") on the served till and the evening check, in a real Chromium against a
 * real store box, English and Tamil.**
 *
 * In the mirror pilot, after the one "Paid on old system" button the till asks for the OLD BILL NUMBER — a typed field
 * (letters, digits, "-" and "/"). Cancelled or not a bill number (a phone number), nothing is saved and the basket stays.
 * Typed in small letters it is kept in capitals, on the sale on the box. The same old bill keyed again is refused by the
 * store computer, in words naming the new bill that holds it, and nothing is saved; the basket stays and is saved under its
 * own number. A mirror refund asks for the old bill number and finds the sale by it; a number no sale carries is said.
 * The migration screen's "Running both" lists the day's mirror bills bill by bill — new bill, old bill, amount, refunded —
 * and points to the evening check from the old system's files for the comparison itself (OB-263).
 * Then all again in Tamil. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'old', 'bill', 'key'].join('-').padEnd(48, '0');
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  // The migration screen is served once the box has its cutover's terms (§34.1).
  migrationPolicy: { cutoverId: 'CUT-1', requiredCleanDays: 3 },
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 500, status: 'active' }],
};

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; mirrorPilot(): boolean; basket(): unknown[] } }

describe.skipIf(!HAVE_BROWSER)('the old bill number on the served till and on the evening check\'s bill-wise list (OB-264)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const box = async (): Promise<{ page: Page; edge: EdgeProcess }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-old-bill-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_GUEST_SALES_ONLY: '1', EDGE_MIRROR_PILOT: '1',
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
  /** Tender → the one "Paid on old system" button → the old bill number question. */
  const payOnOld = async (page: Page, title: string): Promise<void> => {
    await page.click('#tender');
    await page.waitForSelector('#pay:not([hidden])');
    await page.click('#pay-kinds button:first-child');
    await shows(page, 'sheet', 'sheet-title', title);
    expect(await page.isVisible('#entry-text')).toBe(true);
    expect(await page.isVisible('#keypad')).toBe(false);
  };
  const sales = async (edge: EdgeProcess): Promise<{ number: string; oldErpBillNumber?: string; tradingDay: string }[]> =>
    (await readLog(edge.log.path)).map((r) => JSON.parse(r.ok ? r.record : '{}') as { number: string; oldErpBillNumber?: string; tradingDay: string });
  const refundAsks = async (page: Page, title: string, refund = 'Refund'): Promise<void> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    await page.click(`#pay-kinds button:text-is("${refund}")`);
    await shows(page, 'sheet', 'sheet-title', title);
  };

  it('asked after "Paid on old system", judged, kept in capitals, never keyed twice; the refund finds the sale by it; the bill-wise list — English and Tamil', async () => {
    const { page, edge } = await box();
    await scan(page, 1);

    // ── Cancelled: nothing saved, the basket stays.
    await payOnOld(page, 'Old bill number');
    expect(await page.textContent('#entry-hint')).toContain('Type the bill number printed on the old system\'s bill');
    await page.click('#sheet-cancel');
    expect(await sales(edge)).toEqual([]);

    // ── A phone number: refused in words, nothing saved.
    await payOnOld(page, 'Old bill number');
    await page.fill('#entry-text', '9876543210');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining('That looks like a phone, Aadhaar or card number, not a bill number') });
    expect(await sales(edge)).toEqual([]);

    // ── Typed in small letters, ended with Enter (as a scanner would): kept in capitals, on the sale on the box.
    await payOnOld(page, 'Old bill number');
    await page.fill('#entry-text', 'old/77');
    await page.keyboard.press('Enter');
    expect(await said(page)).toMatchObject({ title: expect.stringContaining('Recorded — paid on old system'), text: expect.stringContaining('Old bill: OLD/77') });
    await expect.poll(async () => (await sales(edge)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await sales(edge);
    expect(first!.oldErpBillNumber).toBe('OLD/77');

    // ── The same old bill again: the store computer refuses it, naming new bill 1; nothing saved; the basket stays.
    await scan(page, 1);
    await payOnOld(page, 'Old bill number');
    await page.fill('#entry-text', 'OLD/77');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining(`Old bill number OLD/77 is already keyed on another sale (new bill ${first!.number})`) });
    expect(await sales(edge)).toHaveLength(1);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().length)).toBe(1);
    await payOnOld(page, 'Old bill number');
    await page.fill('#entry-text', 'OLD/78');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining('Old bill: OLD/78') });
    await expect.poll(async () => (await sales(edge)).map((s) => s.oldErpBillNumber), { timeout: 10_000 }).toEqual(['OLD/77', 'OLD/78']);

    // ── A mirror refund: the till asks for the old bill number; one no sale carries is said; OLD/77 finds sale 1.
    await refundAsks(page, 'Old bill number on the customer\'s bill');
    await page.fill('#entry-text', 'OLD/99');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining('No sale on this store computer carries that old bill number') });
    await refundAsks(page, 'Old bill number on the customer\'s bill');
    await page.fill('#entry-text', 'old/77');
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'Which item is coming back?');
    expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => (x.textContent ?? '').trim()))).toEqual([expect.stringMatching(/Toor dal 1kg — can return 1/i)]);
    await page.click('#pay-cancel');

    // ── Tamil: the question, the refusal, the refund's question and its "not found", in Tamil.
    await page.click('#lang');
    await scan(page, 1);
    await payOnOld(page, 'பழைய பில் எண்');
    await page.fill('#entry-text', '9876543210');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining('தொலைபேசி, ஆதார் அல்லது கார்டு எண் போலத் தெரிகிறது') });
    await payOnOld(page, 'பழைய பில் எண்');
    await page.fill('#entry-text', 'SRE 1');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining('இது பழைய பில் எண் அல்ல') });
    await payOnOld(page, 'பழைய பில் எண்');
    await page.fill('#entry-text', 'OLD/77');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining(`பழைய பில் எண் OLD/77 ஏற்கனவே வேறொரு விற்பனையில் பதிவாகியுள்ளது (புதிய பில் ${first!.number})`) });
    await refundAsks(page, 'வாடிக்கையாளரின் பில்லில் உள்ள பழைய பில் எண்', 'திரும்பப் பணம்');
    await page.fill('#entry-text', 'OLD/99');
    await page.click('#sheet-ok');
    expect(await said(page)).toMatchObject({ text: expect.stringContaining('அந்தப் பழைய பில் எண்ணுடன் இந்தக் கடை கணினியில் எந்த விற்பனையும் இல்லை') });
    expect(await sales(edge)).toHaveLength(2);

    // ── The evening check: "Running both" lists the day's mirror bills, bill by bill — English, then Tamil.
    const day = first!.tradingDay;
    const office = await page.context().newPage();
    const errors: string[] = [];
    office.on('pageerror', (e) => errors.push(String(e)));
    await office.goto(`http://127.0.0.1:${edge.screens!.port}/migration/`, { waitUntil: 'load' });
    await office.waitForFunction(() => (globalThis as unknown as { migrationSession?: unknown }).migrationSession !== undefined, undefined, { timeout: 10_000 });
    await office.click('#tab-both');
    await office.fill('#day-date', day);
    await office.dispatchEvent('#day-date', 'change');
    await office.waitForSelector('#bills:not([hidden]) #bills-table');
    expect(await office.textContent('#bills-title')).toBe('Bill by bill (mirror pilot)');
    expect(await office.textContent('#bills-lead')).toContain('The comparison with the old system\'s own bill list is in the evening check from the old system\'s files, above (OB-263).');
    const rows = await office.$$eval('#bills-table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim())));
    expect(rows.map((r) => r.slice(0, 2))).toEqual([[first!.number, 'OLD/77'], [(await sales(edge))[1]!.number, 'OLD/78']]);
    expect(rows[0]![2]).toMatch(/480/);
    expect(await office.$$eval('#bills-table thead th', (ths) => ths.map((th) => th.textContent))).toEqual(['New bill', 'Old bill', 'Amount', 'Refunded']);
    // Another day: none listed, said so.
    await office.fill('#day-date', '2001-01-01');
    await office.dispatchEvent('#day-date', 'change');
    await office.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('bills-list')?.textContent?.includes('No sale keyed on the new till on this day yet.') === true);
    await office.fill('#day-date', day);
    await office.dispatchEvent('#day-date', 'change');
    await office.click('#lang');
    expect(await office.textContent('#bills-title')).toBe('பில் வாரியாக (மிரர் பைலட்)');
    expect(await office.$$eval('#bills-table thead th', (ths) => ths.map((th) => th.textContent))).toEqual(['புதிய பில்', 'பழைய பில்', 'தொகை', 'திருப்பித் தரப்பட்டது']);
    expect(errors).toEqual([]);
  }, 120_000);
});
