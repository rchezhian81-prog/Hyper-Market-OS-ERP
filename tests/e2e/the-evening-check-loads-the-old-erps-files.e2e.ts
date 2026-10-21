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

/**
 * **OB-263 (owner, 21 Oct 2026, "Item-wise + bill-wise") — the whole evening check in a real Chromium, against a real store
 * computer with the office PIN (OB-259), in English and then in Tamil, at the owner's desk and at 360 pixels wide.**
 *
 * The owner signs in with their own PIN and opens "Running both". The evening check names the pilot department. They pick
 * the old system's item-wise report (CSV, with a title line and a customer-mobile column): the screen asks once which
 * column is which, from the file's own header row; saved on the store computer, shown with who set it. The same for the
 * bill-wise list (semicolons, items under each bill). Load and compare: the day's totals old against new, the items that
 * differ, the bills not keyed or mistyped, a credit note to explain, payments and loyalty "not compared". Signing is
 * refused while a difference has no reason; reasons on each; signed. A file that is not a CSV is refused in the browser.
 * Then the whole check again, in Tamil, for another day. No horizontal scroll at 360 px. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['evening', 'check', 'e2e', 'key'].join('-').padEnd(48, '0');
const OWNER = 'u-owner'; const CASHIER = 'u-lanecash';
const PEOPLE = [{ userId: OWNER, displayName: 'Owner Person', roleId: 'owner' }, { userId: CASHIER, displayName: 'Lane Cashier', roleId: 'cashier' }];
const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  migrationPolicy: { cutoverId: 'CUT-1', requiredCleanDays: 2, dailyReconcilerUserId: OWNER, pilotDepartment: { categoryId: 'grocery', name: 'Grocery' } },
  products: [
    { productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 10_500, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'P3', name: 'Sugar 1kg', categoryId: 'grocery', unitPriceMinor: 4500, uom: 'ea', barcodes: ['8900000000003'], availableMinor: 100, taxBps: 500, status: 'active' },
    { productId: 'S1', name: 'Shampoo', categoryId: 'personal_care', unitPriceMinor: 9900, uom: 'ea', barcodes: ['8900000000099'], availableMinor: 100, taxBps: 1800, status: 'active' },
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
const itemWise = (day: string): Buffer => Buffer.from(['\uFEFFSRE Hyper Market — Item wise sales',
  'Item Code,Item Name,Dept,Customer Mobile,Qty,Net Amount,GST Amt,Bill Date',
  `P1,Toor dal 1kg,GROCERY,9876543210,2,210.00,${tax5(21_000)},${dmy(day)}`,
  `8900000000003,Sugar 1kg,GROCERY,9123456780,2,90.00,${tax5(9000)},${dmy(day)}`,
  `8900000000099,Shampoo,Personal Care,9988776655,1,99.00,15.10,${dmy(day)}`,
  `X-999,Face cream,Personal Care,,1,250.00,38.14,${dmy(day)}`,
  'Total,,,,6,649.00,,'].join('\r\n'), 'utf8');
const billWise = (day: string): Buffer => Buffer.from(['Bill No;Date;Customer Name;Bill Amount;Item;Qty;Amount',
  `OLD/101;${dmy(day)};Ravi Kumar;210.00;P1;2;210.00`,
  `OLD/102;${dmy(day)};Meena;45.00;P3;1;45.00`,
  `OLD/103;${dmy(day)};Arun;45.00;P3;1;45.00`,
  `CN/9;${dmy(day)};Ravi Kumar;-105.00;P1;-1;-105.00`].join('\n'), 'utf8');

describe.skipIf(!HAVE_BROWSER)('the evening check from the old ERP\'s files, in English and Tamil (OB-263)', () => {
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

  const box = async (): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-evening-e2e-'));
    dirs.push(dir);
    await writeFile(join(dir, 'store-pack.json'), JSON.stringify(PACK), 'utf8');
    await issueTillPins(dir, KEY, [OWNER, CASHIER]);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: join(dir, 'store-pack.json'),
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_GUEST_SALES_ONLY: '1', EDGE_MIRROR_PILOT: '1', EDGE_OFFICE_SIGN_IN: 'pin',
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  };
  const text = async (page: Page, sel: string): Promise<string> => (await page.textContent(sel)) ?? '';
  const banner = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#banner:not([hidden])');
    const out = { title: await text(page, '#banner-title'), text: await text(page, '#banner-text') };
    await page.click('#banner-ok');
    return out;
  };
  /** Wait until an element's words include `words`. */
  const says = (page: Page, id: string, words: string): Promise<unknown> => page.waitForFunction(
    `(document.getElementById(${JSON.stringify(id)})?.textContent ?? '').includes(${JSON.stringify(words)})`, undefined, { timeout: 15_000 },
  );
  const chooseDay = async (page: Page, day: string): Promise<void> => {
    await page.fill('#ec-date', day);
    await page.dispatchEvent('#ec-date', 'change');
  };
  const mapItemWise = async (page: Page): Promise<void> => {
    await page.waitForSelector('#ec-map:not([hidden])');
    // Only the file's own header row is offered — the mobile column is there, and never chosen.
    expect(await page.$$eval('#ec-map-item_code option', (o) => o.map((x) => x.textContent))).toEqual(expect.arrayContaining(['Item Code', 'Customer Mobile', 'Bill Date']));
    for (const [field, column] of [['item_code', 'Item Code'], ['quantity', 'Qty'], ['value', 'Net Amount'], ['tax', 'GST Amt'], ['sale_date', 'Bill Date']]) await page.selectOption(`#ec-map-${field}`, column!);
    await page.selectOption('#ec-map-date-order', 'dmy');
    await page.selectOption('#ec-map-includes-tax', 'yes');
    // OB-263 A: the report's own department column — then which of ITS values is the pilot department, from the file.
    expect(await page.isVisible('#ec-map-pilot-value')).toBe(false);
    await page.selectOption('#ec-map-department', 'Dept');
    await page.waitForSelector('#ec-map-pilot-box:not([hidden])');
    expect(await page.$$eval('#ec-map-pilot-value option', (o) => o.map((x) => x.textContent))).toEqual(['— choose —', 'GROCERY', 'Personal Care']);
    await page.selectOption('#ec-map-pilot-value', 'GROCERY');
    await page.click('#ec-map-save');
  };
  const mapBillWise = async (page: Page): Promise<void> => {
    await page.waitForSelector('#ec-map:not([hidden])');
    expect(await page.isVisible('#ec-map-includes-tax')).toBe(false);
    for (const [field, column] of [['bill_number', 'Bill No'], ['bill_date', 'Date'], ['bill_total', 'Bill Amount'], ['item_code', 'Item'], ['quantity', 'Qty'], ['line_value', 'Amount']]) await page.selectOption(`#ec-map-${field}`, column!);
    await page.selectOption('#ec-map-date-order', 'dmy');
    // OB-263 B: asked once — do the bill lines' values include the tax?
    expect(await text(page, '#ec-map-lines-tax-label')).toBe('Do the bill lines\' values already include the tax?');
    await page.selectOption('#ec-map-lines-tax', 'yes');
    await page.click('#ec-map-save');
  };
  const explainAll = async (page: Page, reason: string): Promise<number> => {
    const inputs = await page.$$('#ec-reasons input[data-difference-id]');
    for (const input of inputs) await input.fill(reason);
    await page.click('#ec-reasons-save');
    return inputs.length;
  };

  it('signs in, maps once, loads, reads the differences, is refused until each has a reason, signs — then all again in Tamil', async () => {
    const edge = await box();
    // ── The day on the till: two mirror sales, keyed with their old bill numbers.
    const till = bootPos({ laneId: 'lane-1', taxPercent: 5, lanePort: edge.lane!.port, mirrorPilot: true, guestSalesOnly: true });
    await signInTill(till, CASHIER);
    for (const [lines, oldBill] of [[[{ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 10_500, qty: 2 }], 'OLD/101'], [[{ productId: 'P3', description: 'Sugar 1kg', unitPriceMinor: 4500, qty: 1 }], 'OLD/102']] as const) {
      for (const l of lines) till.scan(l);
      const r = await till.nextReceipt();
      await till.tenderPaidOnOldErp(`S-${r}`, r, new Date().toISOString(), oldBill);
      till.newSale();
    }
    const sales = (await readLog(edge.log.path)).map((r) => JSON.parse(r.ok ? r.record : '{}') as { tradingDay: string });
    expect(sales).toHaveLength(2);
    const day = sales[0]!.tradingDay;
    const before = new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    await page.goto(`${base}/migration/`, { waitUntil: 'load' });
    // OB-259: the office screen asks for the owner's own PIN first.
    await page.fill('#office-staff', OWNER);
    await page.fill('#office-pin', pinOf(OWNER));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    await page.waitForFunction(() => (globalThis as unknown as { migrationSession?: unknown }).migrationSession !== undefined, undefined, { timeout: 10_000 });
    await page.click('#tab-both');
    await page.waitForSelector('#ec:not([hidden])');
    expect(await text(page, '#ec-title')).toBe('Evening check from the old system\'s files');
    expect(await text(page, '#ec-dept')).toBe('Pilot department: Grocery (grocery)');
    expect(await page.$eval('#ec-load', (b) => [!!b.querySelector('svg'), (b.textContent ?? '').trim()])).toEqual([true, 'Load and compare']);
    await chooseDay(page, day);
    await says(page, 'ec-result', 'No files have been loaded for this day yet.');

    // A file that is not a CSV is refused in the browser, in words; nothing is sent.
    await page.setInputFiles('#ec-file-item_wise', { name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') });
    await says(page, 'ec-state-item_wise', 'Only a CSV file can be read');

    // ── Map once, from each file's own header row; saved on the store computer, with who set it.
    await page.setInputFiles('#ec-file-item_wise', { name: 'itemwise.csv', mimeType: 'text/csv', buffer: itemWise(day) });
    expect(await text(page, '#ec-map-title')).toBe('Which column is which — the item-wise report');
    await mapItemWise(page);
    expect(await banner(page)).toMatchObject({ title: 'Mapping saved on this store computer', text: expect.stringContaining('set by u-owner') });
    await page.setInputFiles('#ec-file-bill_wise', { name: 'billwise.csv', mimeType: 'text/csv', buffer: billWise(day) });
    await mapBillWise(page);
    await banner(page);
    expect(await text(page, '#ec-state-item_wise')).toContain('Columns found — ready to load');
    expect(await text(page, '#ec-mapping-item_wise')).toContain('set by u-owner');
    expect(await text(page, '#ec-mapping-item_wise')).toContain('Item code or barcode ← Item Code');
    expect(await text(page, '#ec-mapping-item_wise')).not.toContain('Customer Mobile');
    expect(await text(page, '#ec-mapping-item_wise')).toContain('Pilot department in the file: GROCERY');
    expect(await text(page, '#ec-mapping-bill_wise')).toContain('Yes — the line values include tax');

    // ── Load and compare.
    await page.click('#ec-load');
    expect(await banner(page)).toMatchObject({ title: 'Loaded and compared' });
    const totals = await page.$$eval('#ec-totals tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim())));
    expect(totals[0]).toEqual(['Sales value (₹)', '₹300.00', '₹255.00', '-₹45.00']);
    expect(totals[2]).toEqual(['Number of bills', '3', '2', '-1']);
    expect(totals.slice(-2)).toEqual([['Payments taken (₹)', 'Not compared in the mirror pilot (OB-256, OB-265)', '—', '—'], ['Loyalty points', 'Not compared in the mirror pilot (OB-256, OB-265)', '—', '—']]);
    expect(await text(page, '#ec-items')).toContain('Sugar 1kg (P3)');
    expect(await text(page, '#ec-bills')).toContain('OLD/103');
    expect(await text(page, '#ec-bills')).toContain('On the old system with pilot items, not keyed on the new till');
    expect(await text(page, '#ec-explain')).toContain('CN/9');
    // OB-263 A: the other department's rows (shampoo, and a face cream not even in the catalogue) are set aside, counted.
    expect(await text(page, '#ec-dept-rows')).toBe('Pilot department in the file: GROCERY · 2 rows of other departments in the file, not compared · 0 rows with no department written, not compared');
    expect(await text(page, '#ec-result')).not.toContain('X-999');
    expect(await page.isVisible('#ec-bills-basis')).toBe(false);

    // Signing is refused while a difference has no reason.
    await page.fill('#ec-statement', 'compared the old reports with the new till, line by line');
    await page.click('#ec-sign');
    expect(await banner(page)).toMatchObject({ title: 'This day cannot be signed yet', text: expect.stringContaining('Some differences still have no reason') });
    const reasons = await explainAll(page, 'one sugar was rung on the old till only while the new till restarted');
    expect(reasons).toBeGreaterThan(5);
    expect(await banner(page)).toMatchObject({ title: 'Reasons saved on this store computer', text: expect.stringContaining('0 still need a reason') });
    await page.fill('#ec-statement', 'compared the old reports with the new till, line by line');
    await page.click('#ec-sign');
    expect(await banner(page)).toMatchObject({ title: 'Day signed', text: 'Signed by u-owner' });
    expect(await text(page, '#ec-status')).toContain('Signed by u-owner');
    expect(await page.isVisible('#ec-sign')).toBe(false);

    // ── 360 pixels wide: no sideways scroll of the page.
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(360);

    // ── In Tamil: the same screen, then the whole check for another day.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#lang');
    expect(await text(page, '#ec-title')).toBe('பழைய அமைப்பின் கோப்புகளிலிருந்து மாலைச் சரிபார்ப்பு');
    expect(await text(page, '#ec-dept')).toBe('பைலட் துறை: Grocery (grocery)');
    expect(await page.$$eval('#ec-totals thead th', (ths) => ths.map((th) => th.textContent))).toEqual(['எது', 'பழைய அமைப்பு', 'புதிய கல்லா', 'வேறுபாடு']);
    expect(await text(page, '#ec-totals')).toContain('மிரர் பைலட்டில் ஒப்பிடப்படுவதில்லை (OB-256, OB-265)');
    // In Tamil, the bill-wise mapping is changed: its line values are before tax (OB-263 B) — kept, with who changed it.
    await page.click('#ec-map-change-bill_wise');
    await page.waitForSelector('#ec-map:not([hidden])');
    expect(await text(page, '#ec-map-lines-tax-label')).toBe('பில் வரிகளின் மதிப்பில் ஏற்கனவே வரி அடங்கியுள்ளதா?');
    await page.selectOption('#ec-map-lines-tax', 'no');
    await page.click('#ec-map-save');
    expect(await banner(page)).toMatchObject({ title: 'பொருத்தம் இந்தக் கடைக் கணினியில் சேமிக்கப்பட்டது' });
    expect(await text(page, '#ec-mapping-bill_wise')).toContain('இல்லை — வரி மதிப்பு வரிக்கு முந்தையது');
    expect(await text(page, '#ec-mapping-bill_wise')).toContain('முந்தைய பொருத்தங்கள்');
    await chooseDay(page, before);
    await says(page, 'ec-result', 'இந்த நாளுக்கு இன்னும் எந்தக் கோப்பும் ஏற்றப்படவில்லை.');
    await page.setInputFiles('#ec-file-item_wise', { name: 'itemwise-before.csv', mimeType: 'text/csv', buffer: itemWise(before) });
    await page.setInputFiles('#ec-file-bill_wise', { name: 'billwise-before.csv', mimeType: 'text/csv', buffer: billWise(before) });
    await says(page, 'ec-state-bill_wise', 'நெடுவரிசைகள் கிடைத்தன — ஏற்றத் தயார்');
    expect(await page.isVisible('#ec-map')).toBe(false);
    // The wrong day's files are refused, in Tamil words.
    await chooseDay(page, day);
    await page.click('#ec-load');
    expect(await banner(page)).toMatchObject({ title: 'சேமிக்கப்படவில்லை', text: expect.stringContaining('கோப்பு வேறு ஒரு நாளுக்கானது') });
    await chooseDay(page, before);
    await page.click('#ec-load');
    expect(await banner(page)).toMatchObject({ title: 'ஏற்றி ஒப்பிடப்பட்டது' });
    expect(await text(page, '#ec-bills')).toContain('பழைய அமைப்பில் பைலட் பொருட்களுடன் உள்ளது, புதிய கல்லாவில் பதிவாகவில்லை');
    expect(await text(page, '#ec-bills-basis')).toBe('பில் வரிகள் வரிக்கு முந்தையவை, எனவே பைலட் பொருட்கள் இரு பக்கமும் வரி இல்லாமல் ஒப்பிடப்படுகின்றன.');
    expect(await text(page, '#ec-dept-rows')).toContain('கோப்பில் வேறு துறைகளின் வரிகள், ஒப்பிடப்படவில்லை');
    await page.fill('#ec-statement', 'பழைய அறிக்கைகளைப் புதிய கல்லாவுடன் வரி வரியாக ஒப்பிட்டேன், எல்லாம் சரிபார்த்தேன்');
    await page.click('#ec-sign');
    expect(await banner(page)).toMatchObject({ title: 'இந்த நாளில் இன்னும் கையெழுத்திட முடியாது' });
    await explainAll(page, 'பைலட் தொடங்கும் முன் நாள்: புதிய கல்லாவில் எதுவும் பதிவு செய்யப்படவில்லை');
    expect(await banner(page)).toMatchObject({ title: 'காரணங்கள் இந்தக் கடைக் கணினியில் சேமிக்கப்பட்டன' });
    await page.fill('#ec-statement', 'பழைய அறிக்கைகளைப் புதிய கல்லாவுடன் வரி வரியாக ஒப்பிட்டேன், எல்லாம் சரிபார்த்தேன்');
    await page.click('#ec-sign');
    expect(await banner(page)).toMatchObject({ title: 'நாளில் கையெழுத்திடப்பட்டது', text: 'கையெழுத்திட்டவர் u-owner' });
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate('document.documentElement.scrollWidth')).toBeLessThanOrEqual(360);
    expect(errors).toEqual([]);
  }, 180_000);
});
