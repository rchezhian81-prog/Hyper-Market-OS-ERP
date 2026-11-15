import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { issueTillPins, pinOf, signInTill } from '../support/till-operator';
import { departmentOf } from '../../packages/migration/src/bpal-slice';

const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * **OB-800 (owner, 15 Nov 2026): no pilot department — the evening check screen shows the WHOLE store, every department,
 * in a real Chromium against a real store computer with the office PIN, in English and in Tamil, and at 360 px.**
 *
 * The till rings packed rice, a shampoo and loose dal WEIGHED on a verified scale (1.250 kg). The owner signs in with
 * their own PIN, opens "Running both": the evening check says it compares the whole store (no "pilot department not
 * known"); the mapping does not offer a department to keep. Bpal's whole-shop report says the dal was 1.240 kg and the
 * shampoo 1.5 (a part of a whole-unit item). Load and compare: each department's totals and the whole store's; the dal
 * reads 1.240 kg → 1.250 kg, to the gram; the shampoo's part quantity is shown as a difference, never refused. In Tamil the
 * same words. No sideways scroll at 360 px. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['whole', 'store', 'evening', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const CASHIER = 'u-lanecash';
const PEOPLE = [{ userId: OWNER, displayName: 'Owner Person', roleId: 'owner' }, { userId: CASHIER, displayName: 'Lane Cashier', roleId: 'cashier' }];
const GROCERY = departmentOf('1006')!; const CARE = departmentOf('3305')!; const LOOSE = departmentOf('0713', 'loose_kg')!;
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  // No pilot department anywhere: OB-800.
  migrationPolicy: { cutoverId: 'CUT-1', requiredCleanDays: 2, dailyReconcilerUserId: OWNER },
  weighingScales: [{ assetId: 'SCALE-1', laneIds: ['lane-1'], reverificationDueOn: '2099-12-31' }],
  products: [
    { productId: 'P1', name: 'Ponni rice 5kg', categoryId: GROCERY.categoryId, unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'S1', name: 'Shampoo 180ml', categoryId: CARE.categoryId, unitPriceMinor: 15_000, uom: 'ea', barcodes: ['8900000000099'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'L1', name: 'Loose toor dal', categoryId: LOOSE.categoryId, unitPriceMinor: 14_000, uom: 'kg', barcodes: [], availableMinor: 100_000, taxBps: 500, status: 'active' },
  ],
  people: PEOPLE,
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['identity.self.read', 'migration.cleaning.read', 'pos.sale.sync'] },
    { id: 'cashier', name: 'Cashier', permissions: ['pos.sale.sync', 'pos.return.process'] },
  ],
  roleAssignments: PEOPLE.map((p) => ({ userId: p.userId, roleId: p.roleId, branchScope: ['store-1'] })),
};
const tax5 = (incl: number): string => ((incl - Math.round((incl * 10_000) / 10_500)) / 100).toFixed(2);
const dmy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** Bpal's whole-shop item-wise report: dal 1.240 kg (the till weighed 1.250), shampoo 1.5 (a part of a whole unit). */
const itemWise = (day: string): Buffer => Buffer.from(['Item Code,Item Name,Dept,Qty,Net Amount,GST Amt,Bill Date',
  `8901234567890,Ponni rice 5kg,GROCERY,1,480.00,${tax5(48_000)},${dmy(day)}`,
  `S1,Shampoo 180ml,COSMETICS,1.5,150.00,${tax5(15_000)},${dmy(day)}`,
  `L1,Loose toor dal,LOOSE,1.240,175.00,${tax5(17_500)},${dmy(day)}`].join('\r\n'), 'utf8');
const billWise = (day: string): Buffer => Buffer.from(['Bill No,Date,Bill Amount', `OLD/401,${dmy(day)},630.00`, `OLD/402,${dmy(day)},175.00`].join('\n'), 'utf8');

describe.skipIf(!HAVE_BROWSER)('OB-800 — the evening check screen shows every department and the whole store', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const text = async (page: Page, sel: string): Promise<string> => (await page.textContent(sel)) ?? '';
  const banner = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#banner:not([hidden])');
    const out = { title: await text(page, '#banner-title'), text: await text(page, '#banner-text') };
    await page.click('#banner-ok');
    return out;
  };
  const rows = (page: Page, id: string): Promise<string[][]> => page.$$eval(`#${id} tbody tr`, (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim())));

  it('whole store: the department totals, the kg to the gram, a part quantity shown as a difference — in English and Tamil, at 360 px', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-evening-whole-e2e-'));
    dirs.push(dir);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(PACK), 'utf8');
    await issueTillPins(dir, KEY, [OWNER, CASHIER]);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: join(dir, 'store-pack.json'),
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_GUEST_SALES_ONLY: '1', EDGE_MIRROR_PILOT: '1', EDGE_OFFICE_SIGN_IN: 'pin',
    }, () => {}))!;
    stops.push(() => edge.stop());

    // ── The till: packed rice and a shampoo on one bill; loose dal weighed on a verified scale on another.
    const till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, mirrorPilot: true, guestSalesOnly: true, laneScales: { known: true, scales: [{ assetId: 'SCALE-1', reverificationDueOn: '2099-12-31' }] } });
    await signInTill(till, CASHIER);
    const bills: [{ productId: string; description: string; unitPriceMinor: number; qty: number; uom?: string }[], string][] = [
      [[{ productId: 'P1', description: 'Ponni rice 5kg', unitPriceMinor: 48_000, qty: 1 }, { productId: 'S1', description: 'Shampoo 180ml', unitPriceMinor: 15_000, qty: 1 }], 'OLD/401'],
      [[{ productId: 'L1', description: 'Loose toor dal', unitPriceMinor: 14_000, qty: 1_250, uom: 'kg' }], 'OLD/402'],
    ];
    for (const [lines, oldBill] of bills) {
      for (const l of lines) till.scan(l);
      const r = await till.nextReceipt();
      await till.tenderPaidOnOldErp(`S-${r}`, r, new Date().toISOString(), oldBill);
      till.newSale();
    }
    const sales = (await readLog(edge.log.path)).map((r) => JSON.parse(r.ok ? r.record : '{}') as { tradingDay: string });
    expect(sales).toHaveLength(2);
    const day = sales[0]!.tradingDay;

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/migration/`, { waitUntil: 'load' });
    await page.fill('#office-staff', OWNER);
    await page.fill('#office-pin', pinOf(OWNER));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    await page.waitForFunction(() => (globalThis as unknown as { migrationSession?: unknown }).migrationSession !== undefined, undefined, { timeout: 10_000 });
    await page.click('#tab-both');
    await page.waitForSelector('#ec:not([hidden])');
    // No pilot department: the screen says the whole store is compared.
    expect(await text(page, '#ec-dept')).toBe('What is compared: the whole store — every department (OB-800: there is no pilot department). Each department\'s totals are shown, and the whole store\'s total.');
    await page.fill('#ec-date', ddmm(day));
    await page.dispatchEvent('#ec-date', 'change');

    // ── Map once: no department column is offered to keep — the whole report is read.
    await page.setInputFiles('#ec-file-item_wise', { name: 'itemwise.csv', mimeType: 'text/csv', buffer: itemWise(day) });
    await page.waitForSelector('#ec-map:not([hidden])');
    expect(await page.$('#ec-map-department')).toBeNull();
    for (const [field, column] of [['item_code', 'Item Code'], ['quantity', 'Qty'], ['value', 'Net Amount'], ['tax', 'GST Amt'], ['sale_date', 'Bill Date']]) await page.selectOption(`#ec-map-${field}`, column!);
    await page.selectOption('#ec-map-date-order', 'dmy');
    await page.selectOption('#ec-map-includes-tax', 'yes');
    await page.click('#ec-map-save');
    await banner(page);
    await page.setInputFiles('#ec-file-bill_wise', { name: 'billwise.csv', mimeType: 'text/csv', buffer: billWise(day) });
    await page.waitForSelector('#ec-map:not([hidden])');
    for (const [field, column] of [['bill_number', 'Bill No'], ['bill_date', 'Date'], ['bill_total', 'Bill Amount']]) await page.selectOption(`#ec-map-${field}`, column!);
    await page.selectOption('#ec-map-date-order', 'dmy');
    await page.click('#ec-map-save');
    await banner(page);

    // ── Load and compare: never "pilot department not known".
    await page.click('#ec-load');
    expect(await banner(page)).toMatchObject({ title: 'Loaded and compared' });
    expect(await text(page, '#ec-totals-title')).toBe('The whole store\'s totals');
    const totals = await rows(page, 'ec-totals');
    expect(totals[0]).toEqual(['Sales value (₹)', '₹805.00', '₹805.00', 'agrees']);
    expect(totals).toEqual(expect.arrayContaining([['Quantity (kg)', '1.240 kg', '1.250 kg', '+0.010 kg'], ['Quantity (ea)', '2.500', '2.000', '-0.500']]));
    // Each department, by the same HSN table as the Bpal load, in its order.
    expect(await text(page, '#ec-depts-title')).toBe('Each department');
    expect(await rows(page, 'ec-depts')).toEqual([
      [GROCERY.name, '1', '0', '₹480.00 → ₹480.00', `₹${tax5(48_000)} → ₹${tax5(48_000)}`, '1 → 1'],
      [CARE.name, '1', '1', '₹150.00 → ₹150.00', `₹${tax5(15_000)} → ₹${tax5(15_000)}`, '1.500 → 1.000'],
      [LOOSE.name, '1', '1', '₹175.00 → ₹175.00', `₹${tax5(17_500)} → ₹${tax5(17_500)}`, '1.240 kg → 1.250 kg'],
    ]);
    // The items: the dal to the gram; the shampoo's part quantity shown as a difference, never refused.
    expect(await text(page, '#ec-items')).toContain('1.240 kg → 1.250 kg');
    expect(await text(page, '#ec-items')).toContain('Shampoo 180ml (S1) — a part quantity of an item sold in whole units');
    expect(await text(page, '#ec-items')).toContain('1.500 → 1.000');
    expect(await text(page, '#ec-reasons')).toContain('Quantity of Loose toor dal (L1) — Old system 1.240 kg, New till 1.250 kg');
    expect(await page.isVisible('#ec-dept-rows')).toBe(false);
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(360);

    // ── In Tamil.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#lang');
    expect(await text(page, '#ec-dept')).toContain('முழுக் கடை — ஒவ்வொரு துறையும்');
    expect(await text(page, '#ec-totals-title')).toBe('முழுக் கடையின் மொத்தங்கள்');
    expect(await text(page, '#ec-depts-title')).toBe('ஒவ்வொரு துறையும்');
    expect(await page.$$eval('#ec-depts thead th', (ths) => ths.map((th) => th.textContent)).then((h) => h[0])).toBe('துறை');
    expect(await text(page, '#ec-items')).toContain('முழு அலகுகளில் விற்கப்படும் பொருளுக்குப் பகுதி அளவு');
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(360);
    expect(errors).toEqual([]);
  }, 180_000);
});
