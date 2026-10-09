import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInOnPage } from '../support/till-operator';

/**
 * **PF-07 in a real browser, through the till's own Void button — the void and its reason are on the store computer's
 * disk, queued for head office, before the line leaves the bill (Wave 4 · M15-FR-01).**
 *
 * The audit reproduced the void reason disappearing. Here a real Chromium on the served till rings two items, taps the
 * first line, taps Void, chooses "Scanned twice" and confirms: the line is voided on the screen, and the store computer's
 * log holds the void — the product, its value, the reason and the cashier it verified — queued to go. Skips where no
 * browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'void', 'evidence', 'key'].join('-').padEnd(48, '0');

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    basket(): { lineId: string; voided: boolean }[];
  };
}

describe.skipIf(!HAVE_BROWSER)('the served till keeps the void and its reason (audit PF-07)', () => {
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

  it('tap the line → Void → "Scanned twice" → OK: voided on the screen, on the box\'s disk with the reason, queued for head office', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-void-'));
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
    await signInOnPage(page);
    await page.evaluate(() => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 });
      w.posSession!.scan({ productId: 'P2', description: 'Sugar 1kg', unitPriceMinor: 5_000, qty: 2 });
    });
    // The items went in through the session, so the screen has not drawn them yet: Hold, then Recall, redraws the basket
    // from the store computer (PF-05) — the same two lines.
    await page.click('#hold');
    await page.waitForFunction(() => /on hold/i.test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#empty')?.textContent ?? ''), undefined, { timeout: 5_000 });
    await page.click('#hold');
    await page.waitForSelector('#lines tr:nth-child(2)', { timeout: 5_000 });

    await page.click('#lines tr:first-child');
    await page.click('#void');
    await page.waitForSelector('#sheet:not([hidden]) #reasons button', { timeout: 5_000 });
    await page.locator('#reasons button', { hasText: 'Scanned twice' }).click();
    await page.click('#sheet-ok');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().some((l) => l.voided), undefined, { timeout: 5_000 });

    const voids = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []))
      .filter((e) => e.type === 'TillActivityRecorded');
    expect(voids.map((e) => [e.payload['productId'], e.payload['valueMinor'], e.payload['reason'], e.payload['cashierId']])).toEqual([['P1', 64_000, 'scanned_twice', 'u-lanecash']]);
    expect(edge.deviceEventsOutbox.pending().some((i) => i.event.type === 'TillActivityRecorded')).toBe(true);
  });
});
