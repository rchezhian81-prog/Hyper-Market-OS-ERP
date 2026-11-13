import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { TEST_IDP } from '../support/api-harness';
import { auditPage } from './lib/a11y-audit';
import { Tally } from './lib/tally';

/**
 * **U4 — the till's second layer (UI/UX gap audit 1 Nov 2026, G18 and §27 POS "product search"; design system §1 rule 1,
 * §4.2; QG-02; the usability script's C1, C5, C6, C10).**
 *
 * On the REAL till the REAL store computer serves:
 *   • **More reads under plain headings** — Cash drawer · Returns & exchanges · Baskets, quotations & this bill · Bills &
 *     payments · This line & delivery · Customer · This till — the most-used first in each, in English and Tamil. Fewer than
 *     24 choices, so every group stands open (the W1 rule): a heading is words, never a button, and Refund is still ONE tap
 *     from More (reach = 2).
 *   • **Find an item** — a few letters of the name, or a keyed code, from this lane's own signed price list, with the cable
 *     out: Find → letters → row = 3; the row rings the item through the scan path, so a weighed item by its plain code is
 *     refused exactly as a scan is (OB-570); a scanner's code keyed into the box with Enter rings it; "nothing matches" is
 *     said; both languages; the audit is clean with the panel open and every row is a 56px target.
 *   • **The budgets nobody had counted**, honestly: the float = 8 (More · Take float · four keyed digits · OK · the OB-698
 *     confirm); a split of ₹200 cash + UPI = 10 (Tender · Split · Cash · three digits · OK · UPI · the "up to" tap · the
 *     machine's answer; the no-member notice is a line on the first question, 10 in all) — the spec's 3 is for a single tender; close the till with
 *     four notes counted = 7 (More · Close till · four notes · Close till), one more per further note.
 *   • **The cable pulled mid-basket (C6):** two items scanned with head office reachable, every call to it then refused,
 *     a third scanned, cash taken — the sale is on the box, the receipt lines are on the screen, the badge says 1 unsent;
 *     the link returns, one sync pass sends it once, the badge says 0.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const TENANT = 't-sre';
const KEY = ['u4', 'till', 'second', 'layer', 'key'].join('-').padEnd(48, '0');
const BOX_TOKEN = TEST_IDP.issue({ sub: 'u-box', tenantId: TENANT, branchId: 'store-1' });

/** The served-till-closes pack (a till cash log) plus a second packed item and a loose one sold by weight. */
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [
    { productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' },
    { productId: 'P2', name: 'Toned milk 500 ml', categoryId: 'dairy', unitPriceMinor: 3_000, uom: 'ea', barcodes: ['8901234500002'], availableMinor: 100, taxBps: 0, status: 'active' },
    { productId: 'P3', name: 'Tomato', categoryId: 'produce', unitPriceMinor: 4_000, uom: 'kg', barcodes: ['8901234500003'], availableMinor: 100, taxBps: 0, status: 'active' },
  ],
});

interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; basket(): { lineId: string; productId: string; voided?: boolean }[]; operator(): string | undefined };
}
interface Doc { document: { querySelector(s: string): { textContent: string | null; hidden: boolean } | null; getElementById(id: string): { textContent: string | null; hidden: boolean } | null } }

const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
  + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').startsWith(${JSON.stringify(startsWith)}); })()`,
  undefined, { timeout: 15_000 },
);
const sheetTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'sheet', 'sheet-title', s);
const panelTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'pay', 'pay-title', s);
const refusalShown = async (page: Page): Promise<{ title: string; text: string; slip: string }> => {
  await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
  const out = { title: (await page.textContent('#refusal-title')) ?? '', text: (await page.textContent('#refusal-text')) ?? '', slip: (await page.textContent('#refusal-receipt')) ?? '' };
  await page.click('#refusal-ok');
  await page.waitForSelector('#refusal', { state: 'hidden' });
  return out;
};
/** The More sheet as a person reads it: headings and the buttons under each, in order. */
const moreAsRead = (page: Page): Promise<{ heads: string[]; buttons: string[]; order: string[] }> => page.$$eval('#pay-kinds > *', (nodes) => {
  const order = nodes.map((n) => `${n.tagName === 'BUTTON' ? 'b' : 'h'}:${(n.textContent ?? '').trim()}`);
  return { heads: order.filter((o) => o.startsWith('h:')).map((o) => o.slice(2)), buttons: order.filter((o) => o.startsWith('b:')).map((o) => o.slice(2)), order };
});

describe.skipIf(!HAVE_BROWSER)('U4: the till\'s second layer — More under headings, Find an item, the uncounted budgets, a cable pulled mid-basket', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  const savedFetch = globalThis.fetch;

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    globalThis.fetch = savedFetch;
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const box = async (name: string, extra: Record<string, string> = {}): Promise<EdgeProcess> => {
    const dir = await mkdtemp(join(tmpdir(), `sre-u4-${name}-`));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...extra,
      ...await prepareTillBox({ dir, key: KEY, pack: JSON.parse(PACK) as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  };
  const openTill = async (edge: EdgeProcess): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { page, errors };
  };
  const basket = (page: Page): Promise<{ productId: string; voided?: boolean }[]> => page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket());
  const total = (page: Page): Promise<string | null> => page.textContent('#total');

  it('More reads under seven plain headings in both languages, every choice one tap away: Refund is reached in 2', async () => {
    const edge = await box('more');
    const { page, errors } = await openTill(edge);
    const taps = new Tally(page);

    await taps.tap('#more');
    await panelTitled(page, 'More');
    const read = await moreAsRead(page);
    // No float out yet, no line on the bill: the choices the box allows, grouped and ordered as a cashier looks for them.
    expect(read.heads).toEqual(['Cash drawer', 'Returns & exchanges', 'Bills & payments', 'This line & delivery', 'Customer', 'This till']);
    expect(read.order).toEqual([
      'h:Cash drawer', 'b:Take float (open the till)', 'b:Open drawer (no sale)',
      'h:Returns & exchanges', 'b:Refund', 'b:Exchange',
      'h:Bills & payments', 'b:Print a copy of a bill by its number', 'b:Sell a gift card', // W3 (OB-677): a gift card is sold from the bills group
      'h:This line & delivery', 'b:Deliver this bill',
      'h:Customer', 'b:Loyalty member',
      'h:This till', 'b:Scan speed',
    ]);
    // A heading is words, never a target: the audit still passes and every button is a 56px row.
    expect(await page.$$eval('#pay-kinds .group-head', (h) => h.map((x) => x.tagName))).toEqual(['P', 'P', 'P', 'P', 'P', 'P']);
    expect(await page.$$eval('#pay-kinds button', (b) => b.map((x) => (x as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect().height)).then((hs) => hs.every((h) => h >= 56))).toBe(true);
    expect(await auditPage(page, { expectLang: 'en' }), 'More, open').toEqual([]);
    await taps.tap('#pay-kinds button:text-is("Refund")');
    await page.waitForSelector('#sheet:not([hidden])'); // the refund's first question (the bill)
    expect(taps.reset(), 'reach Refund: More → Refund').toBeLessThanOrEqual(2);
    await page.click('#sheet-cancel');

    // Tamil: the headings and the choices in the cashier's language.
    await page.click('#lang');
    await page.click('#more');
    await panelTitled(page, 'மேலும்');
    const ta = await moreAsRead(page);
    expect(ta.heads).toEqual(['பண டிராயர்', 'திரும்பப் பெறுதலும் மாற்றமும்', 'பில்களும் பணம் செலுத்தலும்', 'இந்த வரியும் டெலிவரியும்', 'வாடிக்கையாளர்', 'இந்த டில்']);
    expect(ta.buttons[2]).toBe('திரும்பப் பணம்');
    expect(await auditPage(page, { expectLang: 'ta' }), 'More in Tamil').toEqual([]);
    await page.click('#pay-cancel');
    expect(errors).toEqual([]);
  }, 60_000);

  it('Find an item: three letters of the name → the row rings it (3 interactions); a keyed code rings as a scan; a weighed item is refused by the scan path; Tamil; the audit is clean', async () => {
    const edge = await box('find');
    const { page, errors } = await openTill(edge);
    const taps = new Tally(page);

    // The bar carries Find beside More — a 56px target with its mark, like its neighbours.
    const bar = await page.$$eval('.actions button', (b) => b.map((x) => (x.textContent ?? '').trim()));
    expect(bar).toHaveLength(6);
    expect(bar.slice(3)).toEqual(['Find', 'More', 'Tender']); // on an empty bill the third button reads Recall

    await taps.tap('#find');
    await sheetTitled(page, 'Find an item');
    expect(await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { id: string } } }).document.activeElement.id), 'the search box takes the focus').toBe('entry-text');
    expect(await page.isHidden('#sheet-ok'), 'no OK — a row is the answer').toBe(true);
    await taps.type('#entry-text', 'to'); // two letters: Toor dal, Toned milk and Tomato all match
    await page.waitForSelector('#finds button');
    const rows = await page.$$eval('#finds button', (b) => b.map((x) => ({ words: (x.textContent ?? '').trim(), height: (x as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect().height })));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.words).toMatch(/^Toor dal 1kg.*₹480\.00 \/ ea$/s);
    expect(rows[1]!.words).toMatch(/^Toned milk 500 ml.*₹30\.00 \/ ea$/s);
    expect(rows[2]!.words).toMatch(/^Tomato.*₹40\.00 \/ kg · sold by weight — weigh it and scan its label$/s);
    expect(rows.every((r) => r.height >= 56), 'every row is a 56px target').toBe(true);
    const findAudit = await auditPage(page, { expectLang: 'en' });
    expect(findAudit, 'the find panel, open').toEqual([]);
    await taps.tap('#finds button:nth-child(1)');
    await page.waitForSelector('#lines tr');
    expect(taps.reset(), 'find an item: Find → letters → row').toBeLessThanOrEqual(3);
    expect(await total(page)).toBe('₹480.00');
    expect((await basket(page)).map((l) => l.productId)).toEqual(['P1']);

    // A scanner while the panel is open: its digits land in the box and Enter rings the item exactly as a scan does.
    await page.click('#find');
    await sheetTitled(page, 'Find an item');
    await page.keyboard.type('8901234500002');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 2);
    expect(await total(page)).toBe('₹510.00');

    // A loose item sold by weight, picked by name: the scan path refuses its plain code (OB-570) — the find panel is no way round a gate.
    await page.click('#find');
    await sheetTitled(page, 'Find an item');
    await page.fill('#entry-text', 'tom');
    await page.waitForSelector('#finds button');
    await page.click('#finds button:nth-child(1)');
    const refused = await refusalShown(page);
    expect(refused.title).not.toBe('');
    expect((await basket(page)).map((l) => l.productId), 'nothing was rung').toEqual(['P1', 'P2']);

    // Nothing matches: said, nothing rung.
    await page.click('#find');
    await sheetTitled(page, 'Find an item');
    await page.fill('#entry-text', 'zzq');
    await page.waitForSelector('#finds .find-note');
    expect(await page.textContent('#finds .find-note')).toBe("Nothing in this till's price list matches that.");
    await page.keyboard.press('Enter'); // Enter never picks a guess
    expect(await page.isVisible('#sheet')).toBe(true);
    await page.click('#sheet-cancel');

    // Tamil: the title, the hint, the weighed note, the no-match words.
    await page.click('#lang');
    expect(await page.textContent('#find')).toBe('தேடு');
    await page.click('#find');
    await sheetTitled(page, 'பொருளைத் தேடு');
    await page.fill('#entry-text', 'tom');
    await page.waitForSelector('#finds button');
    expect(await page.textContent('#finds button')).toContain('எடையால் விற்கப்படுவது');
    const taAudit = await auditPage(page, { expectLang: 'ta' });
    expect(taAudit, 'the find panel in Tamil').toEqual([]);
    await page.click('#sheet-cancel');
    expect(errors).toEqual([]);
  }, 90_000);

  it('the budgets nobody had counted: the float = 8 (four digits and the OB-698 confirm), a ₹200 cash + UPI split = 10 (the no-member notice is a line, not a tap), closing the till with four notes = 7', async () => {
    const edge = await box('budgets');
    const { page, errors } = await openTill(edge);
    const taps = new Tally(page);
    const keyDigits = async (digits: string): Promise<void> => {
      await page.waitForSelector('#sheet:not([hidden]) #keypad:not([hidden])');
      for (const d of digits) await taps.tap(`#keypad button:text-is("${d}")`);
    };

    // C1 — the float: More · Take float · 2 0 0 0 · OK · Record the float (the confirm the owner chose, OB-698).
    await taps.tap('#more');
    await panelTitled(page, 'More');
    await taps.tap('#pay-kinds button:text-is("Take float (open the till)")');
    await keyDigits('1000');
    await taps.tap('#sheet-ok');
    await sheetTitled(page, 'Record the float?');
    await taps.tap('#sheet-ok');
    const floated = await refusalShown(page);
    expect(floated.title).toBe('Float taken — the till is open');
    expect(taps.reset(), 'take the float: More · option · 4 digits · OK · confirm').toBe(8);

    // C5 — a split tender on a ₹480 bill: ₹200 cash keyed, the rest by UPI, the machine says approved.
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    await taps.tap('#tender');
    await panelTitled(page, 'How is the customer paying?');
    await taps.tap('#pay-kinds button:text-is("Split / points / store credit")');
    // U5: with no loyalty member on the bill the till says so as a LINE above the first question — nothing to dismiss, the
    // split goes straight on with cash, card and UPI (the U4 count had this as a stop and one more tap).
    await panelTitled(page, 'Still to pay ₹480.00');
    expect(await page.isHidden('#refusal')).toBe(true);
    expect(await page.isVisible('#pay-kicker')).toBe(true);
    expect(await page.textContent('#pay-kicker-text')).toContain('No loyalty member on this bill');
    await taps.tap('#pay-kinds button:text-is("Cash")');
    await keyDigits('200');
    await taps.tap('#sheet-ok');
    await panelTitled(page, 'Still to pay ₹280.00');
    await taps.tap('#pay-kinds button:text-is("UPI")');
    await page.waitForSelector('#quick button');
    await taps.tap('#quick button:first-child'); // "Up to ₹280.00"
    await panelTitled(page, 'What did the card machine say?');
    await taps.tap('#pay-kinds button:text-is("Approved")');
    const paid = await refusalShown(page);
    expect(paid.title).toBe('Approved'); // the split's own word: nothing is due back
    expect(taps.reset(), 'split ₹200 cash + UPI: Tender · Split · Cash · 3 digits · OK · UPI · up-to · Approved (the no-member line is read, not tapped)').toBe(10);

    // C10 — close the till: More · Close till · the notes in the drawer (₹1,000 float + ₹200 cash = two ₹500 and two ₹100) · Close till.
    // The expected figure is shown nowhere (the blind count).
    await taps.tap('#more');
    await panelTitled(page, 'More');
    await taps.tap('#pay-kinds button:text-is("Close till")');
    await page.waitForSelector('#count:not([hidden])');
    expect(await page.textContent('#count .sheet-inner'), 'no expected total on the count panel').not.toMatch(/expected/i);
    for (let i = 0; i < 2; i += 1) await taps.tap('#denoms button[aria-label="one more ₹500.00"]');
    for (let i = 0; i < 2; i += 1) await taps.tap('#denoms button[aria-label="one more ₹100.00"]');
    await taps.tap('#count-ok');
    const closed = await refusalShown(page);
    expect(closed.title).toBe('The drawer balances exactly.');
    expect(taps.reset(), 'close the till with four notes counted: More · Close till · 4 notes · Close till').toBe(7);
    expect(errors).toEqual([]);
  }, 90_000);

  it('the cable pulled mid-basket (C6): the sale lands on the box, the receipt lines show, the badge says 1 unsent; the link returns and one pass sends it', async () => {
    let online = true;
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      if (u === 'https://cloud.example.test/v1/sales' && (init?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        sent.push(body);
        return new Response(JSON.stringify({ saleId: body['saleId'], accepted: true }), { status: 201 });
      }
      return new Response('{}', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const edge = await box('cable', { CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: BOX_TOKEN });
    const { page, errors } = await openTill(edge);
    const unsentSays = (n: string): Promise<unknown> => page.waitForFunction((want) => (globalThis as unknown as Doc).document.getElementById('unsent-count')?.textContent === want, n, { timeout: 20_000 });

    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
    await page.keyboard.type('8901234500002');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 2);

    // The cable comes out: every call to head office is refused from here on. The till notices nothing — it never calls it.
    online = false;
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 3);
    expect(await total(page)).toBe('₹990.00');
    await page.click('#tender');
    await panelTitled(page, 'How is the customer paying?');
    await page.click('#pay-kinds button:text-is("Cash — ₹990.00")');
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    const done = await refusalShown(page);
    expect(done.title).toBe('Change due: ₹0.00');
    // The receipt is on the screen — exactly the lines the paper prints.
    expect(done.slip).toContain('Toor dal 1kg');
    expect(done.slip).toContain('Toned milk 500 ml');
    expect(done.slip).toContain('990.00');
    // The sale is on the box's disk and queued; the badge says so.
    expect(edge.outbox.unsentCount()).toBe(1);
    await unsentSays('1');
    expect(sent, 'nothing reached head office while the cable was out').toEqual([]);

    // The link is back: one pass sends it once, the badge falls to 0.
    online = true;
    const pass = await edge.syncOnce!();
    expect(pass.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('99000'); // the ₹990.00 sale, once
    expect(edge.outbox.unsentCount()).toBe(0);
    await unsentSays('0');
    expect(errors).toEqual([]);
  }, 90_000);
});
