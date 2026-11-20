import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { openFileLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox } from '../support/till-operator';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { REPORTS } from '../../packages/reporting/src/index';

/**
 * **Batch 20c · O2 — on the store computer ALONE (no head office, P-01 · P-08):** the eighteen reports head office works out
 * are listed as runnable and say so; opening one says plainly that head office cannot be reached and shows nothing in its
 * place (never an old copy as current), in English and in Tamil; the store computer's own reports still run, and print.
 *
 * The set-up is batch 18b's: a real store computer with its own sales log (three days of bills) and its pack, which here
 * says the shop records every fact the catalogue names.
 *
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['batch20c', 'reports', 'alone', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner';
const TODAY = shopDateIn(new Date().toISOString());
const dayBefore = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const YESTERDAY = dayBefore(TODAY, 1);
const THREE_AGO = dayBefore(TODAY, 3);

describe.skipIf(!HAVE_BROWSER)('batch 20c — head office\'s reports on the store computer alone', () => {
  let browser: Browser; let edge: EdgeProcess; let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-b20c-reports-'));
    // The store computer's own sales log, as its tills wrote it: three days of bills (one line each money and weight).
    const log = await openFileLog({ dataDir: dir, capacityBytes: 10_485_760 });
    const bill = (id: string, tradingDay: string, lines: { productId: string; quantityMinor: number; uom: string; lineTotalMinor: number }[]) => JSON.stringify({
      id, number: `R-${id}`, laneId: 'lane-1', cashierId: 'u-meena', tradingDay, committedAt: `${tradingDay}T06:30:00.000Z`,
      total: lines.reduce((s, l) => s + l.lineTotalMinor, 0), netMinor: 0, taxMinor: 0, currency: 'INR', lines,
      tenders: [{ kind: 'cash', amount: { minor: lines.reduce((s, l) => s + l.lineTotalMinor, 0) } }],
    });
    await log.append(bill('B1', THREE_AGO, [{ productId: 'P-DAL', quantityMinor: 1, uom: 'ea', lineTotalMinor: 14_800 }]));
    await log.append(bill('B2', YESTERDAY, [{ productId: 'P-DAL', quantityMinor: 2, uom: 'ea', lineTotalMinor: 29_600 }, { productId: 'P-RICE', quantityMinor: 2_500, uom: 'kg', lineTotalMinor: 15_000 }]));
    await log.append(bill('B3', YESTERDAY, [{ productId: 'P-TOMATO', quantityMinor: 850, uom: 'kg', lineTotalMinor: 3_400 }]));
    await log.append(bill('B4', TODAY, [{ productId: 'P-DAL', quantityMinor: 1, uom: 'ea', lineTotalMinor: 14_800 }]));
    const ready = await prepareTillBox({
      dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }],
      pack: {
        lossPreventionRules: [],
        policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
        products: [
          { productId: 'P-DAL', name: 'துவரம் பருப்பு 1kg (Toor dal)', categoryId: 'grocery', unitPriceMinor: 14_800, unitCostMinor: 11_000, uom: 'ea', barcodes: ['8901'], availableMinor: 50, taxBps: 500, status: 'active' },
          { productId: 'P-RICE', name: 'Ponni rice (loose)', categoryId: 'grocery', unitPriceMinor: 6_000, unitCostMinor: 4_800, uom: 'kg', barcodes: ['8902'], availableMinor: 50_000, taxBps: 500, status: 'active' },
          { productId: 'P-TOMATO', name: 'Tomato', categoryId: 'produce', unitPriceMinor: 4_000, uom: 'kg', barcodes: ['8903'], availableMinor: 20_000, taxBps: 0, status: 'active' },
        ],
        categories: [{ categoryId: 'grocery', name: 'Grocery' }, { categoryId: 'produce', name: 'Fruit & Veg' }],
        reportingRecords: [...new Set(REPORTS.flatMap((r) => r.needs))],
        reportingPolicy: { laggingAfterMinutes: 5, staleAfterMinutes: 60, userId: OWNER },
        roles: [{ id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'reporting.report.read', 'reporting.sales.export', 'reporting.operations.export'] }],
        roleAssignments: [{ userId: OWNER, roleId: 'owner', branchScope: 'all' }],
      },
    });
    edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_SCREEN_TRUST_FORWARDED_USER: '1', ...ready,
    }, () => {}))!;
  }, 300_000);
  afterAll(async () => { await browser?.close(); await edge?.stop(); if (dir !== undefined) await rm(dir, { recursive: true, force: true }); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const open = async (path: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: true, extraHTTPHeaders: { 'x-sre-user': OWNER } });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}${path}`, { waitUntil: 'load' });
    expect(res?.status(), `${path} is served`).toBe(200);
    return { page, errors };
  };
  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
  const run = async (page: Page, name: RegExp): Promise<void> => {
    await page.locator('#reports-list .row', { has: page.locator('strong', { hasText: name }) }).locator('button').click();
    await page.locator('#view-report:not([hidden])').waitFor();
  };

  it('all 29 are offered; a head-office report says head office cannot be reached and shows nothing; the store computer\'s own still run and print', async () => {
    const { page, errors } = await open('/reporting/');
    await page.locator('#reports-list .row').first().waitFor();
    expect(await page.locator('#reports-list .row').count()).toBe(29);
    expect(await page.locator('#reports-list .row .by-head-office').count()).toBe(18);
    await run(page, /^Waste$/);
    await page.waitForFunction(() => /Not known/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('report-figures')?.textContent ?? ''));
    expect(await page.textContent('#report-figures')).toContain('Not known — this report is worked out by head office from its own records, and this computer cannot reach head office right now.');
    expect(await page.textContent('#report-figures')).not.toMatch(/₹/);
    await shot(page, 'o2-store-computer-alone-waste-not-reached.png');
    await page.click('#lang');
    expect(await page.textContent('#report-title')).toBe('வீணானவை');
    // One language at a time: the page's own sentence and the figure's name are in Tamil too.
    expect(await page.textContent('#report-figures')).toContain('தெரியவில்லை — இந்த அறிக்கையைத் தலைமை அலுவலகம்');
    expect(await page.textContent('#report-figures')).not.toMatch(/Not known|Waste/);
    await shot(page, 'o2-store-computer-alone-waste-not-reached-tamil.png');
    await page.click('#lang');
    await page.click('#back');

    // The store computer's own report still runs with no internet, and prints from what is on the screen.
    await run(page, /^Sales by day$/);
    expect(await page.textContent('#report-figures')).toMatch(/Taken\s*₹148\.00/);
    await page.click('#print-report');
    await page.locator('#sre-print-sheet .sre-print-page').waitFor();
    expect(await page.textContent('#sre-print-title')).toBe('Sales by day');
    expect(await page.textContent('.sre-print-totals')).toContain('₹148.00');
    await shot(page, 'o2-store-computer-alone-sales-print.png');
    expect(errors).toEqual([]);
  }, 120_000);
});
