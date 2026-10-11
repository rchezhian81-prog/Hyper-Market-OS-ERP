import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox } from '../support/till-operator';

/**
 * **D04-FR-05 · M12-FR-01 — the till drives the customer display, with no network, in a real browser.**
 *
 * The box restores head office's signed catalogue (ghee at ₹640 with a launched 10% offer) from its own disk and serves
 * the real till. A second window on the same till computer opens the customer display (`/pos/customer-display.html`).
 * The cashier scans the ghee's barcode on the till: the display — which had said Welcome — shows the line, the saving
 * and the amount to pay, from the till's own basket over a BroadcastChannel. With the network cut, a second scan still
 * reaches the display. The display never shows the cashier's sign-in. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'display', 'signing', 'key'].join('-').padEnd(48, '0');
const day = (offset: number): string => new Date(Date.now() + offset * 864e5).toISOString();

interface PosWindow { readonly posSession?: { payableMinor(): number } }

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version: 3, builtAt: day(0),
    products: [{ productId: 'P1', sku: 'GHEE-1L', name: 'Amul Ghee Gold 1L', baseUom: 'each', unitPriceMinor: 64_000, taxBps: 500, mrpMinor: 70_000, status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }],
    promotions: [{ id: 'ghee-10', kind: 'percent_off' as const, percentBps: 1000, productIds: ['P1'], startsAt: day(-1), endsAt: day(30), status: 'active' as const }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: day(0) });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

describe.skipIf(!HAVE_BROWSER)('the served till drives the customer display (D04-FR-05)', () => {
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

  it('a scan on the till shows on the display — the line, the saving and the amount to pay — and keeps working offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-display-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const context = await browser.newContext();
    stops.push(() => context.close());

    const display = await context.newPage();
    await display.goto(`${base}/pos/customer-display.html`, { waitUntil: 'load' });
    expect(await display.textContent('#welcome')).toBe('Welcome');
    expect(await display.locator('#bill').isHidden()).toBe(true);

    const till = await context.newPage();
    await till.goto(`${base}/pos/`, { waitUntil: 'load' });
    await till.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await till.bringToFront();
    await till.keyboard.type('8901234567890');
    await till.keyboard.press('Enter');
    await till.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.payableMinor() === 57_600, undefined, { timeout: 5_000 });

    await display.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#lines tr').length === 1, undefined, { timeout: 5_000 });
    expect(await display.locator('#lines tr').first().textContent()).toContain('Amul Ghee Gold 1L');
    expect(await display.locator('#lines tr td').nth(2).textContent()).toBe('₹640.00');
    expect(await display.textContent('#saved')).toBe('You saved ₹64.00');
    expect(await display.textContent('#pay-amount')).toBe('₹576.00');
    expect(await display.textContent('#lane')).toBe('Till lane-1');
    expect(await display.locator('#welcome').isHidden()).toBe(true);
    // Nothing about who is at the till reaches the customer's screen.
    expect(await display.textContent('body')).not.toMatch(/u-lanecash|PIN|Sign/);

    // The cable is cut: the display is fed by the till computer itself, so a second scan still shows.
    await context.setOffline(true);
    await till.bringToFront();
    await till.keyboard.type('8901234567890');
    await till.keyboard.press('Enter');
    await display.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('pay-amount')?.textContent === '₹1,152.00', undefined, { timeout: 5_000 });
    await context.setOffline(false);
  });

  it('the display opened in Tamil speaks Tamil', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-display-ta-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const display = await context.newPage();
    await display.goto(`http://127.0.0.1:${edge.screens!.port}/pos/customer-display.html?lang=ta`, { waitUntil: 'load' });
    expect(await display.textContent('#welcome')).toBe('வருக');
    expect(await display.getAttribute('html', 'lang')).toBe('ta');
  });
});
