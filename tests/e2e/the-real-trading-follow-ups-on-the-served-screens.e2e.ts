import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { issueTillPins, signInThroughScreen, pinOf } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **OB-271 follow-ups on the served screens, in a real Chromium against a real store box in REAL TRADING (switched off
 * during the mirror pilot, OB-248), the office PIN on (OB-259):**
 *
 *   • the box trades from its PACK FILE (no signed price list pulled) and the till's tax invoice carries each item's HSN;
 *   • two card payments with the machine's approval numbers; two EXCHANGES whose difference goes back to the card — one in
 *     English, one in Tamil: the replacement charged its rounded bill (OB-279 · OB-285: sugar ₹50.00 is billed ₹49.62, so
 *     the shop owes ₹55.38), and the refund DONE on the machine — its reference typed, a manager's own PIN — not "pending";
 *   • the manager's day close on the box opens only after the manager's own PIN; it then lists the day's card payments
 *     with each "Approval / Auth code / RRN" and the refunds done on the machine, in English and in Tamil, and never a card
 *     number; the page passes the accessibility audit;
 *   • a box in the MIRROR pilot shows no such list.
 * The mirror pilot is unchanged — proven by its own e2e files, run beside this one. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['real', 'trading', 'follow', 'ups', 'key'].join('-').padEnd(48, '0');
const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', placeOfBusiness: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const DAL = '8901234567890';
const SUGAR = '8901234567892';
const CARD = ['4111', '1111', '1111', '1111'].join(' ');
const ROLES = [
  { id: 'store_manager', name: 'Store manager', permissions: ['identity.self.read', 'till.dayclose.read', 'pos.sale.sync', 'pos.return.process', 'pos.return.approve'] },
  { id: 'cashier', name: 'Cashier', permissions: ['identity.self.read', 'pos.sale.sync', 'pos.return.process'] },
];
const PEOPLE = [{ userId: 'u-lanecash', displayName: 'Lane Cashier', roleId: 'cashier' }, { userId: 'u-mgr', displayName: 'Manager Person', roleId: 'store_manager' }];
/** The store pack FILE, as head office's store pack now serves it: each product with its HSN code. */
const packFile = (): Record<string, unknown> => ({
  version: 1,
  policies: {
    storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000,
    handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1', taxInvoice: SHOP,
  },
  servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
  lossPreventionRules: [],
  products: [
    { productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 10_500, uom: 'ea', barcodes: [DAL], availableMinor: 50, taxBps: 500, hsnCode: '071360', status: 'active' },
    { productId: 'P3', name: 'Sugar 500g', categoryId: 'grocery', unitPriceMinor: 5_000, uom: 'ea', barcodes: [SUGAR], availableMinor: 50, taxBps: 500, hsnCode: '170199', status: 'active' },
  ],
  people: PEOPLE,
  roles: ROLES,
  roleAssignments: PEOPLE.map((p) => ({ userId: p.userId, roleId: p.roleId, branchScope: 'all' })),
});

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; realTrading(): boolean; basket(): unknown[] } }

describe.skipIf(!HAVE_BROWSER)('OB-271 follow-ups — the served till and the manager\'s day close in real trading', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A real box with the office PIN on, from a pack FILE only; `mirror` sets it for the mirror pilot instead of real trading. */
  const box = async (mirror = false): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-real-trading-follow-ups-'));
    dirs.push(dir);
    const file = join(dir, 'store-pack.json');
    await writeFile(file, JSON.stringify(packFile()), 'utf8');
    await issueTillPins(dir, KEY, PEOPLE.map((p) => p.userId));
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: file, EDGE_OFFICE_SIGN_IN: 'pin',
      ...(mirror ? { EDGE_MIRROR_PILOT: '1', EDGE_GUEST_SALES_ONLY: '1' } : { EDGE_REAL_TRADING: '1' }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  };
  const pageOn = async (): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
    stops.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return page;
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
  const cardSale = async (page: Page, approval: string): Promise<void> => {
    await scan(page, DAL, 1);
    await page.click('#tender');
    await shows(page, 'pay', 'pay-title', 'How is the customer paying?');
    await page.click('#pay-kinds button:text-is("Card — ₹105.00")');
    await shows(page, 'pay', 'pay-title', 'What did the card machine say?');
    await page.locator('#pay-kinds button', { hasText: 'Approved' }).click();
    await shows(page, 'sheet', 'sheet-title', 'Approval / Auth code / RRN');
    // A card number typed by mistake is refused, and never kept.
    await page.fill('#entry-text', CARD);
    await page.click('#sheet-ok');
    await shows(page, 'sheet', 'sheet-title', 'Approval / Auth code / RRN');
    await page.fill('#entry-text', approval);
    await page.click('#sheet-ok');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
  };
  const sales = async (edge: EdgeProcess): Promise<{ id: string; number: string; total: number; roundOffMinor?: number; tenders: { kind: string; amount: { minor: number } }[] }[]> =>
    (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as never] : []));
  /** Each body row of a table, as its cells' words. */
  const cellsOf = async (page: Page, table: string): Promise<string[][]> => page.evaluate(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${table} tbody tr`)})).map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent || ''))`,
  ) as Promise<string[][]>;
  const managerSignsIn = async (page: Page, edge: EdgeProcess): Promise<void> => {
    await page.fill('#office-staff', 'u-mgr');
    await page.fill('#office-pin', pinOf('u-mgr'));
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#office-submit')]);
    expect(new URL(page.url()).pathname).toBe('/manager/');
    void edge;
  };

  it('the till: HSN from the pack file on the bill; an exchange\'s card refund done on the machine, in English and Tamil; the manager\'s close lists the day with each approval number, after the PIN', async () => {
    const edge = await box();
    const base = `http://127.0.0.1:${edge.screens!.port}`;
    const till = await pageOn();
    await till.goto(`${base}/pos/`, { waitUntil: 'load' });
    await till.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(till);
    expect(await till.evaluate(() => (globalThis as unknown as PosWindow).posSession!.realTrading())).toBe(true);

    // ── Two card payments; the bill — the tax invoice — carries the HSN from the pack file.
    await cardSale(till, 'a1b2c3');
    expect(await till.textContent('#refusal-receipt')).toContain('HSN 071360');
    expect(await till.textContent('#refusal-receipt')).toContain('Paid: Card (approval A1B2C3)');
    await till.click('#refusal-ok');
    await cardSale(till, 'Z9Y8X7');
    await till.click('#refusal-ok');
    const [first, second] = await sales(edge);

    // ── Exchange 1, in English: one dal (₹105.00) back, sugar out at its rounded bill ₹49.62 → ₹55.38 back to the card.
    const exchange = async (bill: string, words: Record<'exchange' | 'find' | 'which' | 'howMany' | 'why' | 'damaged' | 'condition' | 'resell' | 'refunds' | 'card' | 'doOnMachine' | 'done' | 'refTitle' | 'manager' | 'pin' | 'check', string>, ref: string): Promise<void> => {
      await scan(till, SUGAR, 1);
      await till.click('#more');
      await till.locator('#pay-kinds button', { hasText: words.exchange }).click();
      await shows(till, 'sheet', 'sheet-title', words.find);
      await till.keyboard.type(bill);
      await till.keyboard.press('Enter');
      await shows(till, 'pay', 'pay-title', words.which);
      await till.click('#pay-kinds button:first-child');
      await shows(till, 'sheet', 'sheet-title', words.howMany);
      await till.click('#sheet-ok');
      await shows(till, 'sheet', 'sheet-title', words.why);
      await till.click(`#reasons button:text-is("${words.damaged}")`);
      await till.click('#sheet-ok');
      await shows(till, 'pay', 'pay-title', words.condition);
      await till.click(`#pay-kinds button:text-is("${words.resell}")`);
      // The quote: the credit at the bill's price, the difference against the replacement's ROUNDED bill.
      await shows(till, 'pay', 'pay-title', `${words.refunds}: ₹55.38`);
      expect(await till.textContent('#pay-title')).toContain('₹105.00');
      await till.click(`#pay-kinds button:text-is("${words.card}")`);
      // Not "pending": the refund is done on the machine now, its reference typed, a manager checks it.
      await shows(till, 'pay', 'pay-title', words.doOnMachine);
      await till.locator('#pay-kinds button', { hasText: words.done }).click();
      await shows(till, 'sheet', 'sheet-title', words.refTitle);
      await till.fill('#entry-text', ref);
      await till.click('#sheet-ok');
      await shows(till, 'sheet', 'sheet-title', words.manager);
      await till.keyboard.type('u-mgr');
      await till.keyboard.press('Enter');
      await shows(till, 'sheet', 'sheet-title', words.pin);
      await till.keyboard.type(pinOf('u-mgr'));
      await till.keyboard.press('Enter');
      await shows(till, 'sheet', 'sheet-title', words.check);
      await till.click('#reasons button:first-child');
      await till.click('#sheet-ok');
    };
    await exchange(first!.number, {
      exchange: 'Exchange', find: 'Scan the receipt, or key the bill number', which: 'Which item is coming back?', howMany: 'How many are coming back?',
      why: 'Why is it coming back?', damaged: 'Damaged / faulty', condition: 'What condition is the item in?', resell: 'Good — back on the shelf',
      refunds: 'Shop refunds the difference', card: 'Card', doOnMachine: 'Do this refund of ₹55.38 on the shop\'s card machine', done: 'Done on the machine',
      refTitle: 'Refund reference from the machine', manager: 'Manager: scan your badge or key your staff ID', pin: 'Manager: your till PIN', check: 'What did you check?',
    }, 'R55555');
    await shows(till, 'refusal', 'refusal-title', 'Refund recorded');
    expect(await till.textContent('#refusal-text')).toContain('Recorded: the refund of ₹55.38 was done on the machine (reference R55555), checked by u-mgr');
    await till.click('#refusal-ok');
    // The replacement is charged its bill — ₹49.62 — paid by the credit; never the lines' ₹50.00.
    const replacement = (await sales(edge)).at(-1)!;
    expect(replacement).toMatchObject({ total: 4_962, roundOffMinor: -38, tenders: [expect.objectContaining({ kind: 'exchange_credit', amount: expect.objectContaining({ minor: 4_962 }) })] });

    // ── Exchange 2, in Tamil, against the second bill.
    await till.click('#lang');
    await exchange(second!.number, {
      exchange: 'பரிமாற்றம்', find: 'ரசீதை ஸ்கேன் செய்யவும், அல்லது பில் எண்ணை உள்ளிடவும்', which: 'எந்தப் பொருள் திரும்புகிறது?', howMany: 'எத்தனை திரும்புகின்றன?',
      why: 'ஏன் திரும்புகிறது?', damaged: 'சேதம் / குறை', condition: 'பொருளின் நிலை என்ன?', resell: 'நல்லது — அலமாரிக்குத் திரும்ப',
      refunds: 'கடை வித்தியாசத்தைத் திரும்பத் தருகிறது', card: 'கார்டு', doOnMachine: 'இந்த ₹55.38 திரும்பப் பணத்தை இப்போது கடையின் கார்டு இயந்திரத்தில்', done: 'இயந்திரத்தில் செய்யப்பட்டது',
      refTitle: 'இயந்திரத்தின் திரும்பப் பணக் குறிப்பு எண்', manager: 'மேலாளர்:', pin: 'மேலாளர்: உங்கள் கல்லா PIN', check: 'நீங்கள் எதைச் சரிபார்த்தீர்கள்?',
    }, 'R66666');
    await shows(till, 'refusal', 'refusal-title', 'திரும்பப் பணம் பதிவு செய்யப்பட்டது');
    expect(await till.textContent('#refusal-text')).toContain('பதிவு செய்யப்பட்டது: ₹55.38 திரும்பப் பணம் இயந்திரத்தில் செய்யப்பட்டது (குறிப்பு R66666)');
    await till.click('#refusal-ok');
    const events = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { payload: Record<string, unknown> }] : []));
    expect(events.filter((e) => e.payload['kind'] === 'card_refund_on_machine').map((e) => [e.payload['machineRef'], e.payload['valueMinor'], e.payload['approvedBy']]))
      .toEqual([['R55555', 5_538, 'u-mgr'], ['R66666', 5_538, 'u-mgr']]);

    // ── The manager's day close: the office PIN first — nothing of the day is on the page before it.
    const office = await pageOn();
    const before = await office.goto(`${base}/manager/`, { waitUntil: 'load' });
    expect(before?.status()).toBe(401);
    expect(await office.content()).not.toContain('A1B2C3');
    expect(await office.evaluate('typeof window.managerData')).toBe('undefined');
    await managerSignsIn(office, edge);
    await office.click('#tab-close');
    await office.waitForSelector('#card-day:not([hidden])');
    expect(await office.textContent('#card-day-title')).toBe('Card and UPI today — match against the machine\'s settlement slip');
    const heads = await office.locator('#card-day-paid th').allTextContents();
    expect(heads).toEqual(['Time', 'Till', 'Card / UPI', 'Amount', 'Approval / Auth code / RRN', 'Bill']);
    const paid = (await cellsOf(office, '#card-day-paid')).map((r) => r.slice(1));
    expect(paid).toEqual([['lane-1', 'Card', '₹105.00', 'A1B2C3', first!.id], ['lane-1', 'Card', '₹105.00', 'Z9Y8X7', second!.id]]);
    expect(await office.textContent('#card-day-paid-total')).toBe('Paid by card and UPI today: ₹210.00');
    const refunds = (await cellsOf(office, '#card-day-refunds')).map((r) => r.slice(1));
    expect(refunds.map((r) => [r[1], r[2], r[3], r[5]])).toEqual([['Card', '-₹55.38', 'R55555', 'u-mgr'], ['Card', '-₹55.38', 'R66666', 'u-mgr']]);
    expect(await office.textContent('#card-day-refunded-total')).toBe('Refunded on the machine today: ₹110.76');
    // Hard rule #3: the card number typed by mistake at the till is nowhere on this page.
    expect(await office.content()).not.toContain(CARD.replace(/ /g, ''));
    expect(await office.content()).not.toContain(CARD);
    expect(await auditPage(office)).toEqual([]);

    // In Tamil.
    await office.click('#lang');
    await office.waitForFunction('(document.getElementById("card-day-title")?.textContent ?? "").startsWith("இன்றைய கார்டு")');
    expect(await office.locator('#card-day-paid th').allTextContents()).toEqual(['நேரம்', 'கல்லா', 'கார்டு / UPI', 'தொகை', 'அனுமதி / அங்கீகாரக் குறியீடு / RRN', 'பில்']);
    expect((await cellsOf(office, '#card-day-paid')).map((r) => r[4])).toEqual(['A1B2C3', 'Z9Y8X7']);
    expect(await office.textContent('#card-day-paid-total')).toBe('இன்று கார்டு மற்றும் UPI மூலம் செலுத்தியது: ₹210.00');
    expect(await office.locator('#card-day h4').allTextContents()).toEqual(['இயந்திரத்தில் செய்யப்பட்ட திரும்பப் பணங்கள்']);
    expect(await auditPage(office, { expectLang: 'ta' })).toEqual([]);
  }, 240_000);

  it('a box in the mirror pilot: the manager\'s close shows no card list at all', async () => {
    const edge = await box(true);
    const office = await pageOn();
    await office.goto(`http://127.0.0.1:${edge.screens!.port}/manager/`, { waitUntil: 'load' });
    await managerSignsIn(office, edge);
    expect(await office.evaluate('window.managerData && Object.prototype.hasOwnProperty.call(window.managerData, "cardPayments")')).toBe(false);
    await office.click('#tab-close');
    await office.waitForSelector('#check-close:visible');
    // The list is on this screen — and stays hidden, with nothing in it, in the mirror pilot.
    expect(await office.locator('#card-day').count()).toBe(1);
    expect(await office.isHidden('#card-day')).toBe(true);
    expect(await office.locator('#card-day-body > *').count()).toBe(0);
  }, 120_000);
});
