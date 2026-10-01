import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';

/**
 * **The one-PC till takes its float, its pickup and its blind-count close through the SCREEN, on the store box, and a
 * reload changes nothing (SP-4c · audit finding F10 · M14-FR-01 · M14-FR-02).**
 *
 * The cashier's own controls in a real Chromium against a real edge: More → Take float → keypad; ring a sale; More → Cash to
 * safe; More → Close till → count the notes → the box answers with the difference. Every figure but the count is the
 * box's; the till shows the store computer's words. The page is reloaded mid-shift and the till still knows a float is
 * out — because the box knows, not the browser. A second shift closes SHORT: the box asks why, the cashier picks a reason
 * from the chips, and the headline tells them to call the manager.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'closes', 'signing', 'key'].join('-').padEnd(48, '0');

/** A store pack with the shop's cut-off and a ₹100 cash tolerance, and one sellable item. */
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});

interface PosWindow {
  readonly posSession?: {
    hasCatalogue(): boolean;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    signIn(cashierId: string): void;
    operator(): string | undefined;
    newSale(): void;
  };
}

describe.skipIf(!HAVE_BROWSER)('the one-PC till takes its float, pickup and blind-count close on the store box, through the screen (F10)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** Key an amount in rupees on the sheet's keypad and press OK — the way a cashier does. */
  const keyAmount = async (page: Page, rupees: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of rupees) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
  };
  /** Read the words the till is showing, then dismiss them. */
  const shown = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const title = (await page.textContent('#refusal-title')) ?? '';
    const text = (await page.textContent('#refusal-text')) ?? '';
    await page.click('#refusal-ok');
    return { title, text };
  };
  /** Open More and read what the till offers right now. */
  const moreOffers = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, label: string): Promise<void> => { await page.click(`#pay-kinds button:text-is("${label}")`); };
  /** Scan the pack's ₹480 item the way a scanner does (keystrokes + Enter) and take exact cash for it. */
  const ring = async (page: Page, saleId: string, at: string): Promise<string> => {
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    expect(await page.textContent('#total')).toBe('₹480.00');
    return page.evaluate(async ([id, when]) => {
      const w = globalThis as unknown as PosWindow;
      const r = await w.posSession!.tenderCash(id!, `R-${id}`, when!);
      w.posSession!.newSale();
      return r;
    }, [saleId, at]);
  };

  it('float → sale → pickup → reload → blind count: balanced, every record on the box; then a short second shift needs a reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-closes-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const open = async (): Promise<void> => {
      await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
      await page.waitForFunction(() => {
        const w = globalThis as unknown as PosWindow;
        return w.posSession !== undefined && w.posSession.hasCatalogue();
      }, undefined, { timeout: 15_000 });
    };
    await open();
    await page.click('#signin');
    await page.keyboard.type('u-lanecash');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-lanecash');

    // No float out: the till offers to take one, and not a pickup or a close.
    expect(await moreOffers(page)).toEqual(['Take float (open the till)', 'Refund', 'Exchange']);
    await choose(page, 'Take float (open the till)');
    await keyAmount(page, '2000');
    expect(await shown(page)).toMatchObject({ title: 'Float taken — the till is open', text: expect.stringContaining('₹2,000.00') });
    let records = (await readLog(edge.tillCashLog.path)).map((r) => readTillCashRecord(JSON.parse((r as { record: string }).record)));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'movement', movementKind: 'float_issue', amountMinor: 200_000, custodianId: 'u-lanecash', laneId: 'lane-1' });

    // A ₹480 cash sale (rung NOW — the shift's window opened with the float a moment ago), then ₹500 to the safe.
    expect(await ring(page, 'S-1', new Date().toISOString())).toBe('R-S-1');
    expect(await moreOffers(page)).toEqual(['Cash to safe', 'Refund', 'Exchange', 'Close till']); // the float is out: no second float offered
    await choose(page, 'Cash to safe');
    await keyAmount(page, '500');
    expect(await shown(page)).toMatchObject({ title: 'Moved to the safe', text: expect.stringContaining('₹500.00') });

    // A reload: the browser forgets everything; the till still knows a float is out, because the BOX knows.
    await open();
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-lanecash');
    expect(await moreOffers(page)).toEqual(['Cash to safe', 'Refund', 'Exchange', 'Close till']);
    await page.click('#pay-cancel');

    // Close: count the notes blind — nothing on the panel says what should be there. 2,000 + 480 − 500 = ₹1,980:
    // three ₹500, four ₹100, four ₹20.
    await moreOffers(page);
    await choose(page, 'Close till');
    await page.waitForSelector('#count:not([hidden])');
    expect(await page.textContent('#count')).not.toMatch(/expected|1,980/);
    for (let i = 0; i < 3; i += 1) await page.click('button[aria-label="one more ₹500.00"]');
    for (let i = 0; i < 4; i += 1) await page.click('button[aria-label="one more ₹100.00"]');
    for (let i = 0; i < 4; i += 1) await page.click('button[aria-label="one more ₹20.00"]');
    expect(await page.textContent('#count-total')).toContain('₹1,980.00');
    await page.click('#count-ok');
    expect(await shown(page)).toMatchObject({ title: 'The drawer balances exactly.', text: expect.stringContaining('Till closed') });
    records = (await readLog(edge.tillCashLog.path)).map((r) => readTillCashRecord(JSON.parse((r as { record: string }).record)));
    expect(records.map((r) => r?.kind)).toEqual(['movement', 'movement', 'close']);
    expect(records[2]).toMatchObject({
      kind: 'close', cashierId: 'u-lanecash', laneId: 'lane-1', openingFloatMinor: 200_000, cashSalesMinor: 48_000, pickupsMinor: 50_000, cashRefundsMinor: 0,
      countedMinor: 198_000, expectedMinor: 198_000, varianceMinor: 0, exceptionRaised: false, toleranceMinor: 10_000, toleranceKnown: true,
      denominations: [{ denominationMinor: 50_000, count: 3 }, { denominationMinor: 10_000, count: 4 }, { denominationMinor: 2_000, count: 4 }],
    });
    expect(edge.tillCashOutbox.unsentCount()).toBe(3);

    // A second shift, closed ₹300 short: the box asks why, the cashier picks a reason, the headline says call the manager.
    expect(await moreOffers(page)).toEqual(['Take float (open the till)', 'Refund', 'Exchange']);
    await choose(page, 'Take float (open the till)');
    await keyAmount(page, '2000');
    await shown(page);
    await moreOffers(page);
    await choose(page, 'Close till');
    await page.waitForSelector('#count:not([hidden])');
    for (let i = 0; i < 3; i += 1) await page.click('button[aria-label="one more ₹500.00"]');
    for (let i = 0; i < 2; i += 1) await page.click('button[aria-label="one more ₹100.00"]');
    await page.click('#count-ok');
    // The reason sheet: the difference is named now that the count is made, and the reasons are chips, never free text.
    await page.waitForSelector('#sheet:not([hidden])');
    expect(await page.textContent('#sheet-title')).toContain('Short by ₹300.00');
    expect(await page.$$eval('#reasons button', (b) => b.length)).toBeGreaterThanOrEqual(4);
    await page.click('#reasons button:text-is("Wrong change given")');
    await page.click('#sheet-ok');
    const short = await shown(page);
    expect(short.title).toBe('Short by ₹300.00');
    expect(short.text).toMatch(/call the manager/i);
    records = (await readLog(edge.tillCashLog.path)).map((r) => readTillCashRecord(JSON.parse((r as { record: string }).record)));
    expect(records.at(-1)).toMatchObject({ kind: 'close', varianceMinor: -30_000, exceptionRaised: true, reasonCode: 'wrong_change', countedMinor: 170_000 });
  }, 60_000);
});
