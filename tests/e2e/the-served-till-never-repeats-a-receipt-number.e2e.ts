import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInOnPage } from '../support/till-operator';

/**
 * **PF-04 in a real browser — reload the served till, open a second tab: no receipt number is ever handed out twice
 * (Wave 4 · M01-FR-02 · M12-FR-02).**
 *
 * The audit reproduced it on the real till: after a reload, the next bill restarted at the first number of the range. Here
 * the box serves the real till screen with a published range for its lane; a real Chromium rings a bill, reloads the page,
 * rings another, opens a second tab and rings a third — every number is the box's, in order, never repeated, and every
 * bill is on the box's disk with its own. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'receipt', 'numbers', 'key'].join('-').padEnd(48, '0');

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    nextReceipt(): Promise<string>;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    newSale(): void;
    operator(): string | undefined;
  };
}

describe.skipIf(!HAVE_BROWSER)('the served till never repeats a receipt number (audit PF-04)', () => {
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

  const ring = (page: Page, saleId: string): Promise<string> => page.evaluate(async (id) => {
    const w = globalThis as unknown as PosWindow;
    w.posSession!.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 12_000, qty: 1 });
    const done = await w.posSession!.tenderCash(id, await w.posSession!.nextReceipt(), new Date().toISOString());
    w.posSession!.newSale();
    return done;
  }, saleId);
  const open = async (port: number, context: Awaited<ReturnType<Browser['newContext']>>): Promise<Page> => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    return page;
  };

  it('a bill, a reload, a bill, a second tab, a bill: R-L1-0001, 0002, 0003 — each on the box\'s disk once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-numbers-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: { receiptSeries: [{ laneId: 'lane-1', prefix: 'R-L1-', padTo: 4, rangeStart: 1, rangeEnd: 9999 }] } }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());

    const page = await open(edge.screens!.port, context);
    await signInOnPage(page);
    expect(await ring(page, 'S-1')).toBe('R-L1-0001');

    // The cashier reloads the till: the browser forgets everything it counted. The box does not.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    if (await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.operator()) === undefined) await signInOnPage(page);
    expect(await ring(page, 'S-2')).toBe('R-L1-0002');

    // A second tab on the same till (a new tab is a new page session: the cashier signs in there too).
    const second = await open(edge.screens!.port, context);
    await signInOnPage(second);
    expect(await ring(second, 'S-3')).toBe('R-L1-0003');

    const numbers = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [(JSON.parse(r.record) as { number: string }).number] : []));
    expect(numbers).toEqual(['R-L1-0001', 'R-L1-0002', 'R-L1-0003']);
  });
});
