import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, pinOf } from '../support/till-operator';

/**
 * **PF-05 in a real browser — Hold on the served screen, reload, Recall, sell (Wave 4 · M12-FR-02).**
 *
 * The audit's demand, exactly: an actual served Hold → reload → Recall → sale. The box serves the real till; a real
 * Chromium signs the cashier in through the screen, rings two items, taps **Hold** (the basket goes to the box and the
 * till clears), reloads the page (the browser forgets everything), sees the screen say a basket is on hold, taps
 * **Recall**, gets the same two lines back, and the sale lands on the box's disk at the held total. Skips where no
 * browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'held', 'basket', 'key'].join('-').padEnd(48, '0');

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    nextReceipt(): Promise<string>;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    operator(): string | undefined;
    payableMinor(): number;
  };
}

describe.skipIf(!HAVE_BROWSER)('the served till keeps a held basket through a reload (audit PF-05)', () => {
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

  const signInOnScreen = async (page: Page): Promise<void> => {
    await page.click('#signin');
    await page.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])');
    await page.keyboard.type('u-lanecash');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#sheet:not([hidden]) #entry[aria-label]', { timeout: 5_000 });
    await page.keyboard.type(pinOf('u-lanecash'));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-lanecash', undefined, { timeout: 5_000 });
  };
  it('Hold → reload → the screen says a basket is held → Recall → the same two lines → sold at the held total', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-held-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await signInOnScreen(page);

    await page.evaluate(() => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 2 });
      w.posSession!.scan({ productId: 'P2', description: 'Sunflower oil 1L', unitPriceMinor: 18_000, qty: 1 });
    });
    const total = await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.payableMinor());

    // Hold, on the screen: the box keeps it, the till clears.
    // (Items went in through the session, not the scanner, so the screen has not redrawn; Hold reads the basket itself.)
    await page.click('#hold');
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } | null } }).document.getElementById('hold')?.textContent === 'Recall', undefined, { timeout: 5_000 });
    expect(await page.locator('#lines tr').count()).toBe(0);

    // The page is reloaded: the browser forgets everything. The screen still says a basket is on hold — the box knows.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.operator() === 'u-lanecash', undefined, { timeout: 15_000 });
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } | null } }).document.getElementById('empty')?.textContent?.includes('on hold') === true, undefined, { timeout: 5_000 });
    expect(await page.locator('#hold').textContent()).toBe('Recall');

    // Recall, on the screen: the same two lines come back.
    await page.click('#hold');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#lines tr').length === 2, undefined, { timeout: 5_000 });
    expect(await page.locator('#lines tr td:first-child').allTextContents()).toEqual(['Toor dal 1kg', 'Sunflower oil 1L']);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.payableMinor())).toBe(total);

    // And it is paid for, on this box's disk, at the total it was held at.
    await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      const n = await w.posSession!.nextReceipt();
      await w.posSession!.tenderCash(`S-${n}`, n, new Date().toISOString());
    });
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { total: number }] : []));
    expect(sold).toEqual([expect.objectContaining({ total })]);
    const states = (await readLog(join(dir, 'held-bills.log'))).flatMap((r) => (r.ok ? [(JSON.parse(r.record) as { state: string }).state] : []));
    expect(states).toEqual(['suspended', 'resumed']);
  });

  it('a held basket can be given up from More, with a preset reason: the store computer keeps it on the record with who and why, and it can no longer be recalled (PF-05)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-give-up-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await signInOnScreen(page);
    await page.evaluate(() => {
      (globalThis as unknown as PosWindow).posSession!.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    });
    await page.click('#hold');
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } | null } }).document.getElementById('hold')?.textContent === 'Recall', undefined, { timeout: 5_000 });

    // More → Give up a held basket → the basket → the reason.
    await page.click('#more');
    await page.click('#pay-kinds button:has-text("Give up a held basket")');
    await page.waitForSelector('#pay:not([hidden]) #pay-title:has-text("Which held basket is being given up?")');
    await page.click('#pay-kinds button:has-text("Toor dal 1kg")');
    await page.waitForSelector('#pay:not([hidden]) #pay-title:has-text("Why is it being given up?")');
    await page.click('#pay-kinds button:has-text("Customer left without it")');
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await page.textContent('#refusal-text')).toContain('Basket given up');
    await page.click('#refusal-ok');

    // Nothing is on hold any more: the screen no longer says a basket is on hold, and More no longer offers to give one up.
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } | null } }).document.getElementById('empty')?.textContent?.includes('on hold') === false, undefined, { timeout: 5_000 });
    await page.click('#more');
    expect(await page.locator('#pay-kinds button:has-text("Give up a held basket")').count()).toBe(0);
    await page.click('#pay-cancel');

    // The store computer kept it — never deleted — with who gave it up and why.
    const records = (await readLog(join(dir, 'held-bills.log'))).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));
    expect(records.map((r) => r['state'])).toEqual(['suspended', 'abandoned']);
    expect(JSON.stringify(records[1])).toContain('u-lanecash');
    expect(JSON.stringify(records[1])).toContain('customer_left');
  });
});

