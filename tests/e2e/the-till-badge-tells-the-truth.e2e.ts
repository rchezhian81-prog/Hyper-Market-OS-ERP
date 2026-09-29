import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **The till's sync badge tells the truth, in a real browser, from the real box (Stage G slice 2 · design
 * system §1 rule 4 · P-08).**
 *
 * The badge used to read "Online · Unsent: 0" whatever was true — a constant in the shell, never a fact. Now the
 * served till asks the box that serves it (`GET /lane/sync-status` on the same socket the sale is saved through)
 * and shows, in words as well as a colour: whether the box answers at all, whether the box can reach head office,
 * how many sales the BOX is holding, and when head office last answered. Proven on the deployable one-PC
 * arrangement: one edge process serves the till and owns the lane socket; a real Chromium opens the served page.
 *
 *   • a box with no cloud → the badge says there is no head office link (never "Online"), and Unsent: 0;
 *   • a sale rung through the shell → Unsent: 1, and that is the box's outbox count, not the browser's;
 *   • the box stops answering → the badge says OFFLINE — the store box is not answering — because a sale posted
 *     now would be refused, and the cashier must know that before the customer pays.
 *
 * Skips where no browser binary is present, like its siblings.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['till', 'badge', 'truth', 'signing', 'key'].join('-').padEnd(48, '0');

interface PosWindow {
  laneWriteBase?: string;
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
  };
  readonly posBadge?: { refresh(): Promise<void>; state(): { asked: boolean; reachable: boolean } };
}

describe.skipIf(!HAVE_BROWSER)('the served till\'s sync badge shows what the box knows', () => {
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

  it('no head office link → says so; a sale → the BOX\'s unsent count; the box gone → OFFLINE in words', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-badge-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const w = globalThis as unknown as PosWindow;
      return w.posSession !== undefined && w.posBadge !== undefined;
    }, undefined, { timeout: 15_000 });

    // The box told the page where its socket is; the badge asked it.
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).laneWriteBase)).toBe('http://127.0.0.1:8090');
    await page.evaluate(() => (globalThis as unknown as PosWindow).posBadge!.refresh());
    const words = (await page.textContent('#conn-text'))!;
    expect(words).toContain('No head office link');
    expect(words).not.toMatch(/^Online/);
    expect(await page.textContent('#unsent')).toBe('Unsent: 0');
    expect(await page.getAttribute('#conn-dot', 'class')).toContain('degraded');

    // Ring a sale through the shell's own surface: it lands on the BOX, and the box's count is what the badge shows.
    await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Aachi Sambar Powder 200g', unitPriceMinor: 6_500, qty: 1 });
      await w.posSession!.tenderCash('S-1', 'R-0001', '2026-09-29T10:00:00Z');
    });
    expect(edge.outbox.unsentCount()).toBe(1);
    await page.evaluate(() => (globalThis as unknown as PosWindow).posBadge!.refresh());
    expect(await page.textContent('#unsent')).toBe('Unsent: 1');

    // The box vanishes (the page is pointed at a port nothing listens on — the same thing the cashier sees when
    // the edge process has died). The badge must say OFFLINE and why, before anybody takes payment.
    await page.evaluate(() => { (globalThis as unknown as PosWindow).laneWriteBase = 'http://127.0.0.1:1'; });
    await page.evaluate(() => (globalThis as unknown as PosWindow).posBadge!.refresh());
    const gone = (await page.textContent('#conn-text'))!;
    expect(gone).toMatch(/^Offline — the store box is not answering/);
    expect(await page.getAttribute('#conn-dot', 'class')).toContain('error');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posBadge!.state())).toMatchObject({ asked: true, reachable: false });
  });
});
