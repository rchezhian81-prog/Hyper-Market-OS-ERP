import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { openFileLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox } from '../support/till-operator';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **Batch 18b · O1 / O3 / B1 (owner, 19 Nov 2026) — Reports for a past day, week or month, a department opened to its items,
 * and the download — in a real Chromium, served by the real store computer with NO head office at all (P-01).**
 *
 * The store computer's own sales log holds bills on three days (three days ago, yesterday, today). Through Chromium:
 *   • Reports opens on TODAY and says so; the period picker offers Today, Yesterday, This week, Last week, This month, Last
 *     month and From – to;
 *   • "Yesterday": What is selling, by department shows yesterday's rupees and kg only, the period is named exactly, the
 *     margin says "Not known for this period" with why (the store computer keeps only today's buying cost) — never a guess;
 *     Sync health (a "now" report) says "Not known for this period" too;
 *   • opening Grocery shows each item: quantity, kg, rupees and margin ("Not known …");
 *   • a period from before the first day this store computer holds: every figure says "Not known for this period" and why;
 *   • the department list downloads as a CSV Excel opens (byte-order mark, the rows and columns shown); head office cannot be
 *     reached, so the page says the record of the download is kept on this computer until it answers.
 *
 * Screenshots (deviceScaleFactor 1) go to SRE_SCREENSHOT_DIR when it is set. Synthetic data only. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SCREENSHOT_DIR'];
const KEY = ['batch18b', 'reports', 'period', 'key'].join('-').padEnd(48, '0');
const TENANT = randomUUID();
const OWNER = 'u-owner';
const TODAY = shopDateIn(new Date().toISOString());
const dayBefore = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const YESTERDAY = dayBefore(TODAY, 1);
const THREE_AGO = dayBefore(TODAY, 3);
const dmy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

describe.skipIf(!HAVE_BROWSER)('batch 18b — reports for a past period, items by department, the download — on the store computer alone', () => {
  let browser: Browser; let edge: EdgeProcess; let dir: string;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    if (SHOTS !== undefined) await mkdir(SHOTS, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
    dir = await mkdtemp(join(tmpdir(), 'sre-b18b-reports-'));
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
        reportingRecords: ['sales_rung_at_the_till', 'departments_on_the_catalogue', 'cost_prices_on_the_catalogue', 'the_boxs_own_outbox'],
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
    await page.locator('#reports-list .row', { hasText: name }).locator('button').click();
    await page.locator('#view-report:not([hidden])').waitFor();
  };

  it('today first; then "Yesterday": the departments\' rupees and kg for that day only, the period named, margin "Not known for this period"; Grocery opens to its items; the list downloads', async () => {
    const { page, errors } = await open('/reporting/');
    await page.locator('#period-bar:not([hidden])').waitFor();
    expect(await page.locator('#period-pick option').allTextContents()).toEqual(['Today', 'Yesterday', 'This week (Monday to today)', 'Last week (Monday to Sunday)', 'This month', 'Last month', 'From – to (choose the days)']);
    expect(await page.textContent('#period-says')).toBe(`Showing: today, ${dmy(TODAY)}`);
    await shot(page, 'o1-reports-period-picker-today.png');

    await page.selectOption('#period-pick', 'yesterday');
    await Promise.all([page.waitForURL(/\?period=yesterday/), page.click('#period-show')]);
    await page.locator('#period-bar:not([hidden])').waitFor();
    expect(new URL(page.url()).searchParams.get('from')).toBe(YESTERDAY);
    expect(await page.textContent('#period-says')).toBe(`Showing: ${dmy(YESTERDAY)} (Yesterday)`);
    expect(await page.inputValue('#period-pick')).toBe('yesterday');

    await run(page, /What is selling, by department/);
    expect(await page.textContent('#report-covers')).toMatch(new RegExp(`^Store SRE Hyper Market · ${dmy(YESTERDAY).replace(/\//g, '\\/')} \\(Yesterday\\) · read from the store computer at `));
    const rows = await page.locator('#report-grid tbody tr').allInnerTexts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^Grocery\s+₹446\.00\s+2\s+2\.500 kg\s+Not known for this period — the store computer keeps only today's average buying cost/);
    expect(rows[1]).toMatch(/^Fruit & Veg\s+₹34\.00\s+0\s+0\.850 kg/);
    await shot(page, 'o1-reports-yesterday-by-department.png');

    // O3: Grocery opens to its items — quantity, kg, rupees, margin "Not known" for this period.
    await page.locator('#report-grid tbody tr[data-department="Grocery"] button.sre-row-open').click();
    await page.locator('#dept-items-grid tbody tr').first().waitFor();
    const items = await page.locator('#dept-items-grid tbody tr').allInnerTexts();
    expect(items.map((r) => r.split('\t').slice(0, 4).map((c) => c.trim()))).toEqual([
      ['துவரம் பருப்பு 1kg (Toor dal)', '2', '—', '₹296.00'],
      ['Ponni rice (loose)', '0', '2.500 kg', '₹150.00'],
    ]);
    expect(items[0]).toMatch(/Not known for this period/);
    await shot(page, 'o3-items-in-grocery-yesterday.png');

    // B1: the items list downloads as the file Excel opens — byte-order mark, Tamil kept, the rows shown.
    const [file] = await Promise.all([page.waitForEvent('download'), page.click('#dept-items-download')]);
    const csv = (await readFile((await file.path())!)).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Item,Items,Weighed,Taken,Margin,Margin %');
    expect(lines[1]).toMatch(/^துவரம் பருப்பு 1kg \(Toor dal\),2,—,₹296\.00,Not known for this period,—$/);
    expect(lines).toHaveLength(3);
    // No head office here: the record of the download is kept on this computer, and the page says so.
    await page.waitForFunction(() => /kept on this computer/.test((globalThis as unknown as { document: { getElementById(i: string): { textContent: string | null } | null } }).document.getElementById('dept-items-download-status')?.textContent ?? ''));
    await shot(page, 'b1-items-download-offline.png');
    expect(await page.evaluate(() => JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem('sre.list-downloads.pending') ?? '[]').length)).toBe(1);
    await page.click('#sre-drawer-close');

    // A "now" report for a past day: not known, with why.
    await page.click('#back');
    await run(page, /Anything not sent yet/);
    expect(await page.textContent('#report-figures')).toContain('Not known for this period — this report shows how things stand now');
    expect(errors).toEqual([]);
  }, 120_000);

  it('a period before the first day this store computer holds: every figure says "Not known for this period" and why — never a nought', async () => {
    const { page, errors } = await open('/reporting/?period=custom&from=2020-01-01&to=2020-01-31');
    await page.locator('#period-bar:not([hidden])').waitFor();
    expect(await page.textContent('#period-says')).toBe(`Showing: 01/01/2020 to 31/01/2020 Not known for this period — this store computer holds sales only from ${THREE_AGO}.`);
    expect(await page.isVisible('#period-custom')).toBe(true);
    await run(page, /Sales by day/);
    expect(await page.textContent('#report-figures')).toContain(`Not known for this period — this store computer holds sales only from ${THREE_AGO}`);
    expect(await page.textContent('#report-figures')).not.toMatch(/₹0\.00/);
    await shot(page, 'o1-reports-period-not-known.png');

    // From – to, chosen on the page: three days ago to today covers every bill held.
    await page.click('#back');
    await page.fill('#period-from', dmy(THREE_AGO));
    await page.fill('#period-to', dmy(TODAY));
    await Promise.all([page.waitForURL(/period=custom/), page.click('#period-show')]);
    await run(page, /Sales by day/);
    expect(await page.textContent('#report-figures')).toMatch(/Taken\s*₹776\.00/);
    expect(await page.textContent('#report-covers')).toContain(`${dmy(THREE_AGO)} to ${dmy(TODAY)}`);
    await page.click('#lang');
    expect(await page.textContent('#report-covers')).toContain(`${dmy(THREE_AGO)} முதல் ${dmy(TODAY)} வரை`);
    await shot(page, 'o1-reports-custom-range-tamil.png');
    expect(errors).toEqual([]);
  }, 120_000);
});
