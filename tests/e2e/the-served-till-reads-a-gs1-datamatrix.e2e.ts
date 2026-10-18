import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { readLog } from '../../edge/store-edge/src/file-log';
import { servedTill, scan, refusalSaid, basket, payCash, removeDir, type ServedTill } from './lib/r3-till';

/**
 * **D-20 (R3) in a real browser on the real till, served by a real store computer, no cloud.** A 2D scanner sends the raw
 * DataMatrix element string — symbology identifier, AIs back to back, a group separator (Ctrl+]) after the batch:
 *
 *   • the code is read offline into GTIN, batch and use-by; the line carries the batch;
 *   • batch B-3 is under an approved markdown and is charged ₹45.00, not ₹90.00;
 *   • an expired batch (use-by 1 Jan 2020) is refused by name;
 *   • the same product's plain 1D barcode rings at ₹90.00 with no batch, exactly as before;
 *   • paid in cash, the sale on the store computer's disk keeps the batch and its use-by on the line.
 *
 * Screenshots for the owner only when SRE_SHOTS names a directory. Skips where no browser binary is present. Synthetic data.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const PANEER = '8901000000019';

describe.skipIf(!HAVE_BROWSER)('D-20: the served till reads a GS1 DataMatrix', () => {
  let browser: Browser;
  const open: (ServedTill & { dir: string })[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const t of open.splice(0)) { await t.stop(); await removeDir(t.dir); } });

  it('raw DataMatrix → batch on the line and the markdown price; an expired batch refused; 1D unchanged; the disk keeps the batch', async () => {
    const till = await servedTill(browser, 'd20', [
      { productId: 'p-paneer', sku: 'PANEER', name: 'Paneer 200g', baseUom: 'ea', unitPriceMinor: 90_00, taxBps: 500, status: 'active', batchPrices: [{ batchId: 'B-3', unitPriceMinor: 45_00 }] },
    ], [{ code: PANEER, productId: 'p-paneer', kind: 'standard' }]);
    open.push(till);
    const { page, edge } = till;

    // ]d2 + (01) GTIN + (10) batch, FNC1, (17) use-by — the raw string a DataMatrix decodes to.
    await scan(page, `]d2010${PANEER}10B-3`, '17991231');
    expect(await refusalSaid(page)).toBeNull();
    await page.waitForFunction(() => (globalThis as unknown as { posSession: { basket(): unknown[] } }).posSession.basket().length === 1);
    expect((await basket(page))[0]).toMatchObject({ productId: 'p-paneer', batchId: 'B-3', unitPriceMinor: 45_00 });
    expect(await page.textContent('#lines')).toContain('Paneer 200g · Batch B-3');
    expect(await page.textContent('#total')).toBe('₹45.00');

    // The printed form of an EXPIRED batch: refused by name, nothing added.
    await scan(page, `(01)0${PANEER}(17)200101(10)B-OLD`);
    expect(await refusalSaid(page)).toMatch(/Paneer 200g" is past its use-by date \(2020-01-01\)/);
    expect(await basket(page)).toHaveLength(1);

    // A Digital Link web address on a QR code — read as text, never fetched.
    await scan(page, `https://id.gs1.org/01/0${PANEER}/10/B-4?17=991231`);
    expect(await refusalSaid(page)).toBeNull();
    // The plain 1D barcode: the product's own price, no batch.
    await scan(page, PANEER);
    await page.waitForFunction(() => (globalThis as unknown as { posSession: { basket(): unknown[] } }).posSession.basket().length === 3);
    const rows = await basket(page);
    expect(rows.map((r) => [r.batchId ?? null, r.unitPriceMinor])).toEqual([['B-3', 45_00], ['B-4', 90_00], [null, 90_00]]);
    expect(await page.textContent('#total')).toBe('₹225.00');
    if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'till-reads-a-datamatrix.png') }); }

    await payCash(page);
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    const saved = JSON.parse(first.record) as { lines: { batchId?: string; batchExpiry?: string; unitPriceMinor: number }[] };
    expect(saved.lines.map((l) => [l.batchId ?? null, l.batchExpiry ?? null, l.unitPriceMinor])).toEqual([['B-3', '2099-12-31', 45_00], ['B-4', '2099-12-31', 90_00], [null, null, 90_00]]);
  });
});
