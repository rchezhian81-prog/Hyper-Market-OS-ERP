import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { servedTill, scan, refusalSaid, basket, removeDir, type ServedTill } from './lib/r3-till';

/**
 * **SF-08 (R3 · OB-139 "A") in a real browser on the real till, served by a real store computer, no cloud.** Batch B-1 of
 * paneer is recalled and B-2 is not, on head office's SIGNED pack:
 *
 *   • a 2D code carrying B-1 is refused BY NAME — the panel names the product and the batch — and nothing joins the bill;
 *   • a 2D code carrying B-2 sells, and its line shows the batch;
 *   • the plain 1D barcode of paneer cannot say which batch it is, so it is refused (the whole product);
 *   • curd, not recalled, sells from its 1D barcode exactly as before.
 *
 * Screenshots for the owner only when SRE_SHOTS names a directory. Skips where no browser binary is present. Synthetic data.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const PANEER = '8901000000019';
const CURD = '8901000000026';

describe.skipIf(!HAVE_BROWSER)('SF-08: the served till refuses only the recalled batch', () => {
  let browser: Browser;
  const open: (ServedTill & { dir: string })[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const t of open.splice(0)) { await t.stop(); await removeDir(t.dir); } });

  it('B-1 refused by name, B-2 sells with its batch on the line, the plain barcode blocks paneer, curd sells', async () => {
    const till = await servedTill(browser, 'sf08', [
      { productId: 'p-paneer', sku: 'PANEER', name: 'Paneer 200g', baseUom: 'ea', unitPriceMinor: 90_00, taxBps: 500, status: 'active', recallBlock: true, blockedBatches: ['B-1'] },
      { productId: 'p-curd', sku: 'CURD', name: 'Curd 400g', baseUom: 'ea', unitPriceMinor: 45_00, taxBps: 500, status: 'active' },
    ], [{ code: PANEER, productId: 'p-paneer', kind: 'standard' }, { code: CURD, productId: 'p-curd', kind: 'standard' }]);
    open.push(till);
    const { page } = till;

    await scan(page, `(01)0${PANEER}(17)991231(10)B-1`);
    expect(await refusalSaid(page)).toMatch(/Paneer 200g" batch B-1 is under recall/);
    expect(await basket(page)).toEqual([]);

    await scan(page, `(01)0${PANEER}(17)991231(10)B-2`);
    expect(await refusalSaid(page)).toBeNull();
    await page.waitForFunction(() => (globalThis as unknown as { posSession: { basket(): unknown[] } }).posSession.basket().length === 1);
    expect((await basket(page))[0]).toMatchObject({ productId: 'p-paneer', batchId: 'B-2' });
    expect(await page.textContent('#lines')).toContain('Paneer 200g · Batch B-2');

    await scan(page, PANEER);
    expect(await refusalSaid(page)).toMatch(/Paneer 200g" is under recall/);
    await scan(page, CURD);
    expect(await refusalSaid(page)).toBeNull();
    await page.waitForFunction(() => (globalThis as unknown as { posSession: { basket(): unknown[] } }).posSession.basket().length === 2);
    if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'till-recalled-batch-only.png') }); }
  });
});
