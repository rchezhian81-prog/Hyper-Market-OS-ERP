import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInThroughScreen, pinOf } from '../support/till-operator';

/**
 * **OB-271 — REAL TRADING on the served till, in a real Chromium against a real store box: the bill is the legal GST tax
 * invoice, printed on paper in English and Tamil; a bill missing the GSTIN is refused; card payments carry the machine's
 * approval number; a card refund is done on the machine and recorded with its reference and a second person.**
 *
 *   • `EDGE_REAL_TRADING=1`, the store pack carrying the shop's legal name, address and GSTIN: the till says real trading is
 *     on; after a cash sale it shows the tax invoice and "Print bill". Print → `window.print` is called and the printed HTML
 *     carries every Rule 46 field (each row tagged with its field); a second print is marked DUPLICATE; after the language
 *     button the paper is in Tamil, with the Tamil item name. Nothing is fetched to print (no web font). A print that
 *     fails says so and leaves the sale saved and the bill printable;
 *   • no GSTIN in the pack: the sale is REFUSED before the disk, in words (English and Tamil); nothing is saved;
 *   • a card sale asks for the machine's approval number (a card number typed by mistake is refused and never kept); the
 *     sale keeps it; the day's list shows it; a card refund is done on the machine with its reference and a manager's PIN.
 * The mirror pilot is unchanged — proven by its own e2e files, run beside this one. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'real', 'trading', 'key'].join('-').padEnd(48, '0');
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const DAL = '8901234567890';
const PARUPPU = '8901234567891';
const packWith = (taxInvoice: unknown): Record<string, unknown> => ({
  version: 1,
  policies: {
    storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000,
    handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1',
    ...(taxInvoice === undefined ? {} : { taxInvoice }),
  },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
});
/** Head office's SIGNED price list, as the box pulls it (the real path: each item's HSN code comes with it). */
function signedCatalogue() {
  const snapshot: CatalogueSnapshot = {
    tenantId: 't-sre', version: 3, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P1', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, hsnCode: '071360', status: 'active' },
      { productId: 'P2', sku: 'PARUPPU', name: 'துவரம் பருப்பு 500g', baseUom: 'ea', unitPriceMinor: 5_900, taxBps: 1_800, hsnCode: '07136000', status: 'active' },
    ],
    barcodes: [{ code: DAL, productId: 'P1', kind: 'standard' }, { code: PARUPPU, productId: 'P2', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}
const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];

/** Stands in for the printer: records the print area exactly as `window.print` would send it, field by field. */
const PRINT_RECORDER = `
  window.prints = [];
  window.print = () => {
    if (window.failPrint === true) throw new Error('no printer');
    const area = document.getElementById('print-area');
    const fields = {};
    for (const node of Array.from(area.querySelectorAll('[data-field]'))) {
      for (const f of (node.getAttribute('data-field') || '').split(' ')) (fields[f] = fields[f] || []).push((node.textContent || '').trim());
    }
    window.prints.push({ copy: area.dataset.copy, number: area.dataset.number, lang: area.lang, fields, text: area.textContent });
  };`;
/** How the print area lays out under print media: alone on the page, 72 mm wide, in the computer's own fonts. */
const PRINT_LAYOUT = `(() => {
  const area = document.getElementById('print-area');
  const main = document.querySelector('main');
  return { area: getComputedStyle(area).display, main: getComputedStyle(main).display, width: area.getBoundingClientRect().width, font: getComputedStyle(area).fontFamily };
})()`;

interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; realTrading(): boolean; mirrorPilot(): boolean; basket(): unknown[] };
  readonly prints?: { copy: string; number: string; lang: string; fields: Record<string, string[]>; text: string }[];
  failPrint?: boolean;
}

describe.skipIf(!HAVE_BROWSER)('OB-271 — the served till in real trading prints a legal tax invoice', () => {
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

  /** A real box in real trading, and its till signed in. `window.print` is replaced by a recorder of what would print. */
  const till = async (taxInvoice: unknown): Promise<{ page: Page; edge: EdgeProcess; requests: string[] }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-real-'));
    dirs.push(dir);
    const pack = packWith(taxInvoice);
    await writeSignedPack(dir, signedCatalogue());
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_REAL_TRADING: '1',
      ...await prepareTillBox({ dir, key: KEY, pack, people: PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const requests: string[] = [];
    page.on('request', (r) => { requests.push(r.url()); });
    // What `window.print` would send to the printer: the print area as it stands at that moment, field by field.
    await page.addInitScript(PRINT_RECORDER);
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { page, edge, requests };
  };
  const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
    `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
    + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').includes(${JSON.stringify(startsWith)}); })()`,
    undefined, { timeout: 15_000 },
  );
  const scan = async (page: Page, code: string, items: number): Promise<void> => {
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => (globalThis as unknown as PosWindow).posSession!.basket().length === n, items);
  };
  const payCashExact = async (page: Page): Promise<void> => {
    await page.click('#tender');
    await shows(page, 'pay', 'pay-title', 'How is the customer paying?');
    await page.click('#pay-kinds button:first-child'); // Cash
    await shows(page, 'sheet', 'sheet-title', 'Cash received');
    await page.click('#quick button:first-child'); // Exact
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
  };
  const prints = (page: Page): Promise<NonNullable<PosWindow['prints']>> => page.evaluate(() => (globalThis as unknown as PosWindow).prints ?? []);
  const sales = async (edge: EdgeProcess): Promise<{ number: string; tenders: { kind: string; machineRef?: string; ref?: string }[] }[]> =>
    (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { number: string; tenders: { kind: string; machineRef?: string }[] }] : []));

  it('a cash sale prints a compliant tax invoice — every field, English then Tamil, the reprint marked DUPLICATE; a failed print keeps the sale', async () => {
    const { page, edge, requests } = await till(SHOP);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.realTrading())).toBe(true);
    await page.waitForSelector('#real-trading:not([hidden])');
    expect(await page.textContent('#real-trading')).toContain('Real trading: this till\'s bill is the legal GST tax invoice');
    expect(await page.isHidden('#mirror-pilot')).toBe(true);

    await scan(page, DAL, 1);
    await scan(page, DAL, 2);
    await scan(page, PARUPPU, 3);
    await payCashExact(page);
    // On the box's disk first; then the bill — the tax invoice — with "Print bill" under it.
    await expect.poll(async () => (await sales(edge)).length, { timeout: 10_000 }).toBe(1);
    const [sale] = await sales(edge);
    expect(await page.textContent('#refusal-receipt')).toContain('Tax Invoice');
    expect(await page.isVisible('#print-bill')).toBe(true);
    expect(await page.isHidden('#print-duplicate')).toBe(true);
    expect(await page.textContent('#print-bill')).toBe('Print bill');

    await page.click('#print-bill');
    const [first] = await prints(page);
    expect(first).toMatchObject({ copy: 'original', number: sale!.number, lang: 'en' });
    const f = first!.fields;
    expect(f['title']).toEqual(['Tax Invoice']);
    expect(f['supplier_legal_name']).toEqual([SHOP.legalName]);
    expect(f['supplier_address']).toEqual(SHOP.placeOfBusiness);
    expect(f['supplier_gstin']).toEqual([`GSTIN: ${SHOP.gstin}`]);
    expect(f['invoice_number']![0]).toContain(sale!.number);
    expect(f['invoice_date']![0]).toMatch(/^Date:\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/);
    expect(f['place_of_supply']).toEqual(['Place of supply: Tamil Nadu (33)']);
    expect(f['reverse_charge']).toEqual(['Tax payable on reverse charge: No']);
    expect(f['line_description']).toEqual(['Toor dal 1kg', 'Toor dal 1kg', 'துவரம் பருப்பு 500g']);
    expect(f['line_hsn']).toEqual([expect.stringContaining('HSN 071360 · GST 5%'), expect.stringContaining('HSN 071360 · GST 5%'), expect.stringContaining('HSN 07136000 · GST 18%')]);
    expect(f['line_taxable_value']).toEqual([expect.stringContaining('Taxable value 100.00'), expect.stringContaining('Taxable value 100.00'), expect.stringContaining('Taxable value 50.00')]);
    expect(f['line_quantity']).toEqual([expect.stringContaining('1 Nos × 105.00'), expect.stringContaining('1 Nos × 105.00'), expect.stringContaining('1 Nos × 59.00')]);
    expect(f['cgst']).toEqual(['CGST @ 2.5%5.00', 'CGST @ 9%4.50']);
    expect(f['sgst']).toEqual(['SGST @ 2.5%5.00', 'SGST @ 9%4.50']);
    // OB-279: CGST ₹9.50 and SGST ₹9.50 each round up to ₹10 — a round off of +₹1.00 — so the bill is ₹270.00.
    expect(f['cgst_total']).toEqual(['CGST (rounded to ₹)10.00']);
    expect(f['sgst_total']).toEqual(['SGST (rounded to ₹)10.00']);
    expect(f['round_off']).toEqual(['Round off+1.00']);
    expect(f['total']).toEqual(['Total (incl. GST)270.00']);
    expect(f['signatory']).toEqual([`For ${SHOP.legalName}`, 'Authorised signatory']);
    expect(f['duplicate']).toBeUndefined();

    // The paper prints alone, on an 80 mm roll (72 mm printable): only the print area shows in print.
    await page.emulateMedia({ media: 'print' });
    const printed = await page.evaluate(PRINT_LAYOUT) as { area: string; main: string; width: number; font: string };
    await page.emulateMedia({ media: 'screen' });
    expect(printed).toMatchObject({ area: 'block', main: 'none' });
    expect(printed.width).toBeGreaterThan(260); // 72 mm ≈ 272 px
    expect(printed.width).toBeLessThan(285);
    expect(printed.font).toContain('Nirmala UI'); // the computer's own Tamil font — nothing downloaded

    // Printed once: the next print is a DUPLICATE. In Tamil, after the language button.
    expect(await page.isVisible('#print-duplicate')).toBe(true);
    // The bill stays printable after the panel is closed: More → "Reprint the last bill" — here in Tamil.
    await page.click('#refusal-ok');
    await page.click('#lang');
    await page.click('#more');
    await page.locator('#pay-kinds button', { hasText: 'கடைசி பில்லை மீண்டும் அச்சிடு' }).click();
    await shows(page, 'refusal', 'refusal-title', `கடைசி பில் ${sale!.number}`);
    expect(await page.textContent('#print-duplicate')).toBe('மீண்டும் அச்சிடு (நகல்)');
    await page.click('#print-duplicate');
    const second = (await prints(page))[1]!;
    expect(second).toMatchObject({ copy: 'duplicate', number: sale!.number, lang: 'ta' });
    expect(second.fields['duplicate']).toEqual(['நகல் (DUPLICATE) — மறு அச்சு']);
    expect(second.fields['title']).toEqual(['Tax Invoice / வரி விலைப்பட்டியல்']);
    expect(second.fields['place_of_supply']).toEqual(['வழங்கல் இடம்: Tamil Nadu (33)']);
    expect(second.fields['line_description']).toContain('துவரம் பருப்பு 500g');
    expect(second.text).toContain('வரி விதிக்கத்தக்க மதிப்பு');
    expect(second.fields['supplier_gstin']).toEqual([`GSTIN: ${SHOP.gstin}`]);
    await page.click('#refusal-ok');
    await page.click('#lang');

    // A print that fails: said; the sale stands (still one on the disk) and the bill is printable again.
    await scan(page, DAL, 1);
    await page.evaluate(() => { (globalThis as unknown as PosWindow).failPrint = true; });
    await payCashExact(page);
    await page.click('#print-bill');
    await shows(page, 'refusal', 'refusal-title', 'The bill did not print');
    expect(await page.textContent('#refusal-text')).toContain('The sale is saved');
    expect(await page.isVisible('#print-bill')).toBe(true);
    expect(await sales(edge)).toHaveLength(2);
    await page.evaluate(() => { (globalThis as unknown as PosWindow).failPrint = false; });
    await page.click('#print-bill');
    expect((await prints(page)).at(-1)).toMatchObject({ copy: 'original', number: (await sales(edge))[1]!.number });

    // Nothing was fetched from anywhere but this computer: no web font, no network (hard rule #1).
    expect(requests.filter((u) => !u.startsWith('http://127.0.0.1:') && !u.startsWith('data:'))).toEqual([]);
  });

  it('no GSTIN in the store\'s setup → the sale is REFUSED before the disk, in words, English and Tamil', async () => {
    const { page, edge } = await till({ ...SHOP, gstin: '' });
    await scan(page, DAL, 1);
    await payCashExact(page);
    expect(await page.textContent('#refusal-title')).toContain('Not a legal bill — NOT saved');
    expect(await page.textContent('#refusal-text')).toContain('the shop\'s GSTIN is not set up');
    expect(await page.isHidden('#print-actions')).toBe(true);
    expect(await page.isHidden('#refusal-receipt')).toBe(true);
    await page.click('#refusal-ok');
    expect(await sales(edge)).toHaveLength(0);
    // The basket is still there; in Tamil the same refusal.
    await page.click('#lang');
    await page.click('#tender');
    await page.click('#pay-kinds button:first-child');
    await page.click('#quick button:first-child');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#refusal-title')).toContain('சட்டப்படியான பில் அல்ல');
    expect(await page.textContent('#refusal-text')).toContain('கடையின் GSTIN அமைக்கப்படவில்லை');
    expect(await sales(edge)).toHaveLength(0);
  });

  it('card: the machine\'s approval number is typed (a card number is refused), kept on the tender, listed for the day; a card refund is done on the machine with a manager', async () => {
    const { page, edge } = await till(SHOP);
    await scan(page, DAL, 1);
    await page.click('#tender');
    await shows(page, 'pay', 'pay-title', 'How is the customer paying?');
    // OB-279: ₹105 of dal at 5% is asked as ₹106.00 — its CGST and SGST (₹2.50 each) round up to ₹3.
    await page.click('#pay-kinds button:text-is("Card — ₹106.00")');
    await shows(page, 'pay', 'pay-title', 'What did the card machine say?');
    await page.locator('#pay-kinds button', { hasText: 'Approved' }).click();
    // The approval number from the machine's slip. A card number typed by mistake is refused, and never kept anywhere.
    await shows(page, 'sheet', 'sheet-title', 'Approval / Auth code / RRN');
    const card = ['4111', '1111', '1111', '1111'].join(' ');
    await page.fill('#entry-text', card);
    await page.click('#sheet-ok');
    await shows(page, 'sheet', 'sheet-title', 'Approval / Auth code / RRN');
    expect(await page.textContent('#entry-hint')).toContain('That looks like a CARD NUMBER');
    await page.fill('#entry-text', 'a1b2c3');
    await page.click('#sheet-ok');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#refusal-receipt')).toContain('Paid: Card (approval A1B2C3)');
    await page.click('#refusal-ok');
    const [sale] = await sales(edge);
    expect(sale!.tenders).toEqual([expect.objectContaining({ kind: 'card', machineRef: 'A1B2C3' })]);
    const attempts = (await readLog(join(edge.log.path, '..', 'payment-attempts.log'))).map((r) => (r.ok ? r.record : ''));
    expect(attempts.join('\n')).toContain('"machineRef":"A1B2C3"');
    for (const file of [edge.log.path, join(edge.log.path, '..', 'payment-attempts.log')]) {
      expect((await readLog(file)).map((r) => (r.ok ? r.record : '')).join('\n')).not.toContain('4111111111111111');
    }

    // The day's list for the machine's settlement slip: the payment, its approval number, its bill.
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.locator('#pay-kinds button', { hasText: 'Card and UPI today' }).click();
    await shows(page, 'refusal', 'refusal-title', 'Card and UPI payments today');
    const list = (await page.textContent('#refusal-receipt')) ?? '';
    expect(list).toContain('A1B2C3');
    expect(list).toContain('₹106.00');
    await page.click('#refusal-ok');

    // A refund to the card: done on the machine, its reference typed, a manager checks with their own PIN — recorded.
    await page.click('#more');
    await shows(page, 'pay', 'pay-title', 'More');
    await page.click('#pay-kinds button:text-is("Refund")');
    await shows(page, 'sheet', 'sheet-title', 'Scan the receipt, or key the bill number');
    await page.keyboard.type(sale!.number);
    await page.keyboard.press('Enter');
    await shows(page, 'pay', 'pay-title', 'Which item is coming back?');
    await page.click('#pay-kinds button:first-child');
    await shows(page, 'sheet', 'sheet-title', 'How many are coming back?');
    await page.click('#sheet-ok');
    await shows(page, 'sheet', 'sheet-title', 'Why is it coming back?');
    await page.click('#reasons button:text-is("Damaged / faulty")');
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'What condition is the item in?');
    await page.click('#pay-kinds button:text-is("Good — back on the shelf")');
    await shows(page, 'sheet', 'sheet-title', 'How much to refund?');
    for (const digit of '105') await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await shows(page, 'pay', 'pay-title', 'How is the refund given?');
    await page.click('#pay-kinds button:text-is("Card")');
    await shows(page, 'pay', 'pay-title', 'Do this refund of ₹105.00 on the shop\'s card machine');
    await page.locator('#pay-kinds button', { hasText: 'Done on the machine' }).click();
    await shows(page, 'sheet', 'sheet-title', 'Refund reference from the machine');
    await page.fill('#entry-text', 'R98765');
    await page.click('#sheet-ok');
    await shows(page, 'sheet', 'sheet-title', 'Manager: scan your badge or key your staff ID');
    await page.keyboard.type('u-mgr');
    await page.keyboard.press('Enter');
    await shows(page, 'sheet', 'sheet-title', 'Manager: your till PIN');
    await page.keyboard.type(pinOf('u-mgr'));
    await page.keyboard.press('Enter');
    await shows(page, 'sheet', 'sheet-title', 'What did you check?');
    await page.click('#reasons button:first-child');
    await page.click('#sheet-ok');
    await shows(page, 'refusal', 'refusal-title', 'Refund recorded');
    expect(await page.textContent('#refusal-text')).toContain('done on the machine (reference R98765), checked by u-mgr');
    await page.click('#refusal-ok');
    const events = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []));
    expect(events.filter((e) => e.payload['kind'] === 'card_refund_on_machine').map((e) => e.payload)).toEqual([
      expect.objectContaining({ machineRef: 'R98765', refundTender: 'card', valueMinor: 10_500, approvedBy: 'u-mgr', cashierId: 'u-lanecash' }),
    ]);
    // And it is on the day's list, as a refund done on the machine.
    await page.click('#more');
    await page.locator('#pay-kinds button', { hasText: 'Card and UPI today' }).click();
    await shows(page, 'refusal', 'refusal-title', 'Card and UPI payments today');
    expect(await page.textContent('#refusal-receipt')).toContain('R98765');
  });
});
