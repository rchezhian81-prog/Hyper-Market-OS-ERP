import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **The whole one-PC till, in a real browser: the box serves its own screen and takes its own sale.**
 *
 * This is the deployable arrangement, proven end to end. ONE edge process serves the real POS shell
 * (the screens server, exactly as the container entry point runs it) AND owns the write socket; a
 * real Chromium opens the served screen on that box's loopback origin, rings a sale through the shell
 * the cashier actually uses (`window.posSession`), and the sale lands durably on the box's disk and
 * is queued for the cloud. The commit crosses from the screen's port to the socket's port — the
 * cross-origin hop that increment 1 unblocked — so this exercises the served shell, the CORS answer
 * and the durable commit as one thing, the way an install on one shop PC does.
 *
 * It is the ground the install steps stand on: it proves a browser till committing a real sale on a
 * single machine, rather than asserting it. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'one', 'pc', 'signing', 'key'].join('-').padEnd(48, '0');

/** The slice of the served POS shell's globals the test drives — the cashier's own surface. */
interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
  };
}

describe.skipIf(!HAVE_BROWSER)('the one-PC till serves its own screen and takes a sale', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // Build the CURRENT POS bundle so the browser runs this branch's shell, not a stale artifact —
    // the same thing an install does before opening the till.
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('a sale rung on the served screen lands on this box\'s disk and is queued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-'));
    dirs.push(dir);
    // The edge exactly as a one-PC install runs it: the write socket on the lane port the POS shell
    // posts to (its built-in default), and the screens server pointed at this repo's app shells.
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => edge.stop());
    expect(edge.lane?.port, 'the lane socket must be on the port the POS shell posts to').toBe(8090);

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    // Open the till the way a cashier does — the screen served by this same box.
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    // Ring one item and take cash — the whole of a sale, driven through the shell's own surface.
    const receipt = await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      return w.posSession!.tenderCash('S-1', 'R-0001', '2026-08-28T10:00:00Z');
    });
    expect(receipt).toBe('R-0001');

    // The sale is durably on this box's disk — the commit crossed from the screen's port to the
    // socket's, and the socket accepted it (increment 1) and wrote it before answering.
    const records = await readLog(edge.log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && (JSON.parse(records[0].record) as { id: string }).id).toBe('S-1');

    // And queued for the cloud — durable AND on its way, the two halves of a sale that is not lost.
    expect(edge.outbox.unsentCount()).toBe(1);
  });
});
