import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';

/**
 * **Pilot-first audit, fix round 1 (OB-739 · OB-773) — four till faults, through the cashier's own buttons in a real
 * Chromium against a real store box.**
 *
 *  - **D-4** Qty: the panel shows the line's quantity now, greyed; the first digit keyed REPLACES it — 3 is 3 (it used to be
 *    13), 1 then 2 is 12, OK with nothing typed keeps the quantity, and 0 keeps the panel open with words.
 *  - **D-5** Cash with no float out is refused in plain words with the next step (More → Take float), nothing is charged,
 *    and card / UPI still work. With the float out, cash is taken and More offers Close till — the blind count closes it.
 *    (pos-cashier.md "Cash movements and Close till": Close till is offered when a float is out; the spec is silent on cash
 *    before a float, so the till refuses it — the owner's fix-round words.)
 *  - **D-6** UPI is asked about the UPI app or sound box — never "the card machine" — in English and Tamil; a card still
 *    asks the card machine.
 *  - **D-14** OK on an empty Cash panel keeps it open and says what to key (and so does too little cash).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['pilot', 'fix', 'till', 'round', 'one', 'key'].join('-').padEnd(48, '0');

/** A store pack with a ₹100 cash tolerance and one ₹480 item. */
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 1000, taxBps: 0, status: 'active' }],
});

type Doc = { document: { querySelector(s: string): { textContent: string | null } | null } };
type Box = { textContent: string | null; classList: { contains(c: string): boolean } };
const entryNow = (e: unknown): { entry: string; fresh: boolean } => ({ entry: (e as Box).textContent ?? '', fresh: (e as Box).classList.contains('fresh') });

interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; basket(): readonly { qty: number; voided?: boolean }[]; newSale(): void };
}

describe.skipIf(!HAVE_BROWSER)('pilot fix round 1: the till keys a quantity, wants a float for cash, asks UPI in its own words and never closes an empty cash panel', () => {
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

  const start = async (): Promise<{ page: Page; edge: EdgeProcess }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-pilot-fix-till-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: JSON.parse(PACK) as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const w = globalThis as unknown as PosWindow;
      return w.posSession !== undefined && w.posSession.hasCatalogue();
    }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { page, edge };
  };

  const scan = async (page: Page): Promise<void> => {
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
  };
  const keys = async (page: Page, digits: string): Promise<void> => {
    for (const d of digits) await page.click(`#keypad button:text-is("${d}")`);
  };
  const shown = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const title = (await page.textContent('#refusal-title')) ?? '';
    const text = (await page.textContent('#refusal-text')) ?? '';
    await page.click('#refusal-ok');
    return { title, text };
  };
  const payTitle = async (page: Page): Promise<string> => {
    await page.waitForSelector('#pay:not([hidden])');
    return (await page.textContent('#pay-title')) ?? '';
  };
  const pick = async (page: Page, label: RegExp): Promise<void> => {
    await page.waitForSelector('#pay:not([hidden])');
    await page.locator('#pay-kinds button', { hasText: label }).first().click();
  };
  const total = async (page: Page): Promise<string> => (await page.textContent('#total')) ?? '';
  const qtyPanel = async (page: Page): Promise<{ entry: string; fresh: boolean }> => {
    await page.click('#lines tr');
    await page.click('#qty');
    await page.waitForSelector('#sheet:not([hidden])');
    return page.$eval('#entry', entryNow);
  };

  it('D-4: the first digit keyed replaces the quantity shown — 3 is 3, 1·2 is 12, OK alone keeps it, 0 is refused in words', async () => {
    const { page } = await start();
    await scan(page);
    expect(await total(page)).toBe('₹480.00');

    // A line of 1: the panel shows 1, greyed; key 3 → OK → 3 (it was 13).
    expect(await qtyPanel(page)).toEqual({ entry: '1', fresh: true });
    await keys(page, '3');
    expect(await page.$eval('#entry', entryNow)).toEqual({ entry: '3', fresh: false });
    await page.click('#sheet-ok');
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.querySelector('#total')?.textContent === '₹1,440.00');

    // A line of 3: the panel shows 3; key 1, 2 → 12.
    expect(await qtyPanel(page)).toEqual({ entry: '3', fresh: true });
    await keys(page, '12');
    await page.click('#sheet-ok');
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.querySelector('#total')?.textContent === '₹5,760.00');

    // OK with nothing typed keeps the quantity.
    expect(await qtyPanel(page)).toEqual({ entry: '12', fresh: true });
    await page.click('#sheet-ok');
    await page.waitForSelector('#sheet', { state: 'hidden' });
    expect(await total(page)).toBe('₹5,760.00');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket()[0]!.qty)).toBe(12);

    // 0 is refused: the panel stays open and says so, the line keeps 12. Cancel sends nothing.
    await qtyPanel(page);
    await keys(page, '0');
    await page.click('#sheet-ok');
    expect(await page.isVisible('#sheet')).toBe(true);
    expect(await page.textContent('#entry-hint')).toBe('The quantity must be 1 or more. Key the number of items, then OK.');
    await page.click('#sheet-cancel');
    expect(await total(page)).toBe('₹5,760.00');
  }, 60_000);

  it('D-5 · D-6 · D-14: cash refused with no float (card / UPI still work); UPI asks the UPI app; float → an empty cash OK stays open → cash → Close till → blind count', async () => {
    const { page, edge } = await start();
    await scan(page);

    // D-5 (a): no float out — Cash is refused in plain words, with the next step; nothing reaches the box, no panel opens.
    await page.click('#tender');
    await pick(page, /^Cash/);
    expect(await shown(page)).toEqual({
      title: 'No float in the drawer yet',
      text: 'Take the opening float first (More → Take float). Nothing was charged. Card or UPI can still be taken.',
    });
    expect(await page.isHidden('#sheet')).toBe(true);
    expect(edge.outbox.unsentCount()).toBe(0);
    // …in Tamil too.
    await page.click('#lang');
    await page.click('#tender');
    await page.locator('#pay-kinds button').first().click(); // பணம் — the first choice is always cash
    const ta = await shown(page);
    expect(ta.title).toBe('டிராயரில் இன்னும் ஆரம்பப் பணம் இல்லை');
    expect(ta.text).toContain('முதலில் ஆரம்பப் பணத்தை எடுக்கவும் (மேலும் → ஆரம்பப் பணம் எடு). எதுவும் வசூலிக்கப்படவில்லை.');

    // D-6: UPI is asked about the UPI app or sound box — in Tamil, then in English — never the card machine.
    await page.click('#tender');
    await pick(page, /^UPI/);
    const taUpi = await payTitle(page);
    expect(taUpi).toContain('UPI பணம் வந்ததா? கடையின் UPI செயலியையோ ஒலிப்பெட்டியையோ (சவுண்ட் பாக்ஸ்) பார்க்கவும்.');
    expect(taUpi).not.toContain('கார்டு இயந்திரம்');
    await page.click('#pay-cancel');
    await page.click('#lang');
    await page.click('#tender');
    await pick(page, /^UPI/);
    expect(await payTitle(page)).toBe('Did the UPI payment come through? Check the shop\'s UPI app or sound box. — ₹480.00');
    await page.click('#pay-cancel');
    // A card still asks the card machine — and with no float out, card is taken (D-5: only cash needs the float).
    await page.click('#tender');
    await pick(page, /^Card/);
    expect(await payTitle(page)).toBe('What did the card machine say? — ₹480.00');
    await pick(page, /^Approved$/);
    expect((await shown(page)).title).toBe('Approved — Card');
    expect(edge.outbox.unsentCount()).toBe(1);
    // A UPI payment that has not shown is said in UPI words too.
    await scan(page);
    await page.click('#tender');
    await pick(page, /^UPI/);
    await pick(page, /It has not answered/);
    const notYet = await shown(page);
    expect(notYet.text).toContain('The UPI payment has not shown on the shop\'s UPI app or sound box');
    expect(notYet.text).not.toMatch(/card machine/i);
    await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.newSale()); // the customer left; a fresh bill

    // The float: More → Take float → ₹2,000 → OK → the OB-698 confirm.
    await page.click('#more');
    await pick(page, /^Take float/);
    await page.waitForSelector('#sheet:not([hidden])');
    await keys(page, '2000');
    await page.click('#sheet-ok');
    await page.waitForSelector('#sheet:not([hidden]) #consequence:not([hidden])');
    await page.click('#sheet-ok');
    expect((await shown(page)).title).toBe('Float taken — the till is open');

    // D-14: Tender → Cash → OK with nothing keyed keeps the panel open and says what to key; too little does the same.
    await scan(page);
    await page.click('#tender');
    await pick(page, /^Cash/);
    await page.waitForSelector('#sheet:not([hidden])');
    await page.click('#sheet-ok');
    expect(await page.isVisible('#sheet')).toBe(true);
    expect(await page.textContent('#entry-hint')).toBe('Key the cash the customer gave, then OK — or tap Exact ₹480.00. Nothing was charged.');
    await keys(page, '100');
    await page.click('#sheet-ok');
    expect(await page.isVisible('#sheet')).toBe(true);
    expect(await page.textContent('#entry-hint')).toBe('Not enough — the customer still owes ₹380.00');
    expect(edge.outbox.unsentCount()).toBe(1);
    await keys(page, 'C');
    await keys(page, '500');
    await page.click('#sheet-ok');
    expect((await shown(page)).title).toBe('Change due: ₹20.00');
    expect(edge.outbox.unsentCount()).toBe(2);

    // D-5 (b): with the float out, More offers Close till, and the blind count closes it: ₹2,000 + ₹480 = four ₹500, four ₹100, four ₹20.
    await page.click('#more');
    await pick(page, /^Close till$/);
    await page.waitForSelector('#count:not([hidden])');
    expect(await page.textContent('#count')).not.toMatch(/expected|2,480/);
    for (let i = 0; i < 4; i += 1) await page.click('button[aria-label="one more ₹500.00"]');
    for (let i = 0; i < 4; i += 1) await page.click('button[aria-label="one more ₹100.00"]');
    for (let i = 0; i < 4; i += 1) await page.click('button[aria-label="one more ₹20.00"]');
    await page.click('#count-ok');
    expect(await shown(page)).toMatchObject({ title: 'The drawer balances exactly.', text: expect.stringContaining('Till closed') });
    const records = (await readLog(edge.tillCashLog.path)).map((r) => readTillCashRecord(JSON.parse((r as { record: string }).record)));
    expect(records.at(-1)).toMatchObject({ kind: 'close', openingFloatMinor: 200_000, cashSalesMinor: 48_000, countedMinor: 248_000, varianceMinor: 0 });
  }, 90_000);
});
