import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { readLog } from '../../edge/store-edge/src/file-log';
import { servedTill, scan, refusalSaid, basket, payCash, removeDir, type ServedTill } from './lib/r3-till';
import { signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **B13 (R3 · OB-138) in a real browser on the real till, served by a real store computer, no cloud.** Head office's
 * signed pack carries a gold ring with its hallmark HUID AB12CD and a gold chain with none:
 *
 *   • the chain is refused BY NAME — it has no HUID recorded on the product;
 *   • the ring sells; the bill the cashier sees names HUID AB12CD, and the sale on the store computer's disk keeps it;
 *   • the ring scanned again is refused — the HUID is already sold — on this till, and after a reload (the store computer
 *     tells the page which HUIDs it has sold, from its own disk);
 *   • a sale posted straight to the store computer with that HUID again is refused before its disk.
 *
 * Screenshots for the owner only when SRE_SHOTS names a directory. Skips where no browser binary is present. Synthetic data.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const RING = '8901000000033';
const CHAIN = '8901000000057';

describe.skipIf(!HAVE_BROWSER)('B13: the served till refuses a gold piece with no HUID, or with a HUID already sold', () => {
  let browser: Browser;
  const open: (ServedTill & { dir: string })[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const t of open.splice(0)) { await t.stop(); await removeDir(t.dir); } });

  it('no HUID refused; the ring sold with its HUID on the bill and the disk; sold again → refused at the till, after a reload, and at the box', async () => {
    const till = await servedTill(browser, 'b13', [
      { productId: 'p-ring', sku: 'RING-22K', name: 'Gold ring 22K', baseUom: 'ea', unitPriceMinor: 45_000_00, taxBps: 300, status: 'active', regulatedFlags: { gold: true, huid: 'AB12CD' } },
      { productId: 'p-chain', sku: 'CHAIN-22K', name: 'Gold chain 22K', baseUom: 'ea', unitPriceMinor: 90_000_00, taxBps: 300, status: 'active', regulatedFlags: { gold: true } },
    ], [{ code: RING, productId: 'p-ring', kind: 'standard' }, { code: CHAIN, productId: 'p-chain', kind: 'standard' }]);
    open.push(till);
    const { page, edge } = till;

    await scan(page, CHAIN);
    expect(await refusalSaid(page)).toMatch(/^Gold chain 22K is gold and has no hallmark HUID recorded on the product/);
    expect(await basket(page)).toEqual([]);

    await scan(page, RING);
    await page.waitForFunction(() => (globalThis as unknown as { posSession: { basket(): unknown[] } }).posSession.basket().length === 1);
    expect((await basket(page))[0]).toMatchObject({ productId: 'p-ring', huid: 'AB12CD' });
    const bill = await payCash(page);
    expect(bill).toContain('Gold ring 22K — HUID AB12CD');
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    expect((JSON.parse(first.record) as { lines: { huid?: string }[] }).lines[0]?.huid).toBe('AB12CD');

    // The same piece again: refused on this till at once …
    await scan(page, RING);
    expect(await refusalSaid(page)).toMatch(/Gold ring 22K \(HUID AB12CD\) has already been sold/);
    // … and after a reload, because the store computer tells the page what it has sold.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { posSession?: { hasCatalogue(): boolean } }).posSession?.hasCatalogue() === true);
    await scan(page, RING);
    expect(await refusalSaid(page)).toMatch(/HUID AB12CD\) has already been sold/);
    if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'till-huid-already-sold.png') }); }

    // A till that skipped the check posts the HUID again: the store computer refuses before its disk.
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: new Date().toISOString().slice(0, 10), committedAt: new Date().toISOString(), id: 'S-AGAIN', number: 'R-AGAIN', total: 45_000_00,
        lines: [{ productId: 'p-ring', quantityMinor: 1, uom: 'ea', unitPriceMinor: 45_000_00, lineTotalMinor: 45_000_00, taxRateBps: 300, huid: 'AB12CD' }],
        tenders: [{ kind: 'cash', amountMinor: { minor: 45_000_00, currency: 'INR' }, status: 'settled' }],
      }),
    });
    expect(await res.json()).toMatchObject({ committed: false, refusedBecause: 'gold_huid_already_sold', productId: 'p-ring' });
    expect(await readLog(edge.log.path)).toHaveLength(1);
  });
});
