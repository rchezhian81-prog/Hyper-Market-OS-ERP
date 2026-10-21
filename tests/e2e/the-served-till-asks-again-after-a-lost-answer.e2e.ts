import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';

/**
 * **The served till, in a real Chromium against a real store box, when the box's answer to a sale is lost (audit A8).**
 *
 * The box SAVES the sale and its answer never reaches the page; the box then stops answering for a while. The till does
 * not say "Do not take money" and does not let the sale be rung again: it covers the screen with "Checking with the store
 * computer — do not ring this again" (in English, and in Tamil after the language button), keeps asking by itself, and
 * once the box answers shows the sale as done — with ONE sale on the box's disk. A reload while it is checking does not
 * escape the check: the page asks the box about that sale before anything else.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'lost', 'answer', 'key'].join('-').padEnd(48, '0');
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
};

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; state(): string } }

describe.skipIf(!HAVE_BROWSER)('the served till asks the store computer again when its answer to a sale is lost (A8)', () => {
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

  /** A box and its till page; `wire.down` makes the page's sale posts fail; the FIRST is saved by the box, then lost. */
  const till = async (): Promise<{ page: Page; edge: EdgeProcess; wire: { down: boolean; posts: number } }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-a8-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: PACK }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const wire = { down: false, posts: 0 };
    await page.route('**/lane/sales', async (route: Route) => {
      wire.posts += 1;
      if (wire.posts === 1) {
        await route.fetch();       // the box saves the sale…
        wire.down = true;          // …and from here it stops answering for a while
        await route.abort('connectionreset');
        return;
      }
      if (wire.down) { await route.abort('connectionrefused'); return; }
      await route.continue();
    });
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { page, edge, wire };
  };
  const ringAndPayCash = async (page: Page): Promise<void> => {
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
  };

  it('covers the till with "checking" (English, then Tamil), never "do not take money"; when the box answers: done, ONE sale', async () => {
    const { page, edge, wire } = await till();
    await ringAndPayCash(page);

    await page.waitForSelector('#checking:not([hidden])', { timeout: 10_000 });
    const title = (await page.textContent('#checking-title')) ?? '';
    const text = (await page.textContent('#checking-text')) ?? '';
    expect(title).toContain('do not ring this again');
    expect(text).toMatch(/does not know whether sale \S+ was saved/);
    expect(`${title} ${text}`).not.toMatch(/do not take money|not ready to take payment/i);
    expect(await page.isHidden('#refusal')).toBe(true);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.state())).toBe('unconfirmed');

    // Tamil, from the cover's own language button (nothing under the cover can be pressed).
    await page.click('#checking-lang');
    expect((await page.textContent('#checking-title')) ?? '').toContain('கடை கணினியிடம் சரிபார்க்கிறது');
    expect((await page.textContent('#checking-text')) ?? '').toContain('மீண்டும் பில் செய்ய வேண்டாம்');
    expect(await page.textContent('#checking-now')).toBe('இப்போதே மீண்டும் கேள்');

    // Still down: it keeps asking by itself, and keeps covering the till.
    await page.waitForFunction("(document.getElementById('checking-asked')?.textContent ?? '') !== ''", undefined, { timeout: 10_000 });
    expect(await page.isVisible('#checking')).toBe(true);
    await page.click('#checking-lang'); // back to English

    // The box answers again: the SAME sale is answered "saved" — the till says the sale is done.
    wire.down = false;
    await page.click('#checking-now');
    await page.waitForSelector('#checking', { state: 'hidden', timeout: 10_000 });
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await page.getAttribute('#refusal', 'data-tone')).toBe('success');
    expect(await readLog(edge.log.path)).toHaveLength(1);
    expect(wire.posts).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('a reload while checking does not escape it: the page asks the box about that sale first, and says "saved"', async () => {
    const { page, edge, wire } = await till();
    await ringAndPayCash(page);
    await page.waitForSelector('#checking:not([hidden])', { timeout: 10_000 });

    wire.down = false; // the box is back, but this page is reloaded before it asks again
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.getAttribute('#refusal', 'data-tone')).toBe('success');
    expect((await page.textContent('#refusal-text')) ?? '').toMatch(/says it was saved/);
    expect(await page.isHidden('#checking')).toBe(true);
    expect(await readLog(edge.log.path)).toHaveLength(1);
  }, 60_000);
});
