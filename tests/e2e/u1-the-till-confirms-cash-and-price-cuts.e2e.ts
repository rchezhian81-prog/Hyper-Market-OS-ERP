import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { readLog } from '../../edge/store-edge/src/file-log';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInOnPage, signInThroughScreen, pinOf } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';
import { Tally } from './lib/tally';

/**
 * **OB-626 "A" (U1, 2 Nov 2026 · design system §1.3, §27.1): the till confirms before money moves or a price is cut.**
 *
 * On the REAL till the REAL store computer serves, with no head office at all (P-01):
 *   • Take the float / Cash to safe: after the amount, a panel says what will be recorded ("₹2,000.00 will be recorded as
 *     float put into this drawer."), in whose name and at what time on this till, with the verb ("Record the float") and
 *     Go back. Go back — and Escape — send NOTHING to the box (its cash log stays empty); the verb sends it once.
 *   • A price cut: after the new price is keyed and BEFORE the manager's badge is asked for, the panel shows the item,
 *     from and to, how much comes off the line and the percentage, and the lowest allowed price the till knows (OB-500);
 *     Go back leaves the price and asks no manager; "Ask the manager" goes on to the badge, PIN and reason as before.
 *   • Both languages; the audit on the open panel is clean; the focus lands on Go back.
 *   • The budgets, counted honestly: the float gains ONE tap (the confirm) by the owner's written decision OB-626 — the
 *     documented exception to §1.1's three; every other till budget is unchanged (the-till-and-manager-meet-the-interaction-budget).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const TENANT = 't-sre';
const CASH_KEY = ['u1', 'till', 'cash', 'confirm', 'key'].join('-').padEnd(48, '0');
const CUT_KEY = ['u1', 'till', 'cut', 'confirm', 'key'].join('-').padEnd(48, '0');
const GHEE = '8900000000808';
const PEOPLE = [
  { userId: 'u-lanecash', displayName: 'Lane Cashier' },
  { userId: 'u-manager', displayName: 'Manager', permissions: ['pos.sale.sync', 'pos.return.approve', 'pos.override.approve'] },
];
const TILL_CONTROLS = { floors: { 'P-GHEE': 50_000 }, floorsNotKnown: [], overrideLimits: { 'u-manager': { state: 'limit', limitMinor: 10_000 } }, limitsVersion: 1, ownerApprovers: ['u-owner'] };

/** A store pack with one sellable item — the served-till-closes pack, so the box keeps a till cash log. */
const CASH_PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 5, builtAt: new Date().toISOString(),
    products: [{ productId: 'P-GHEE', sku: 'GHEE-1L', name: 'Ghee 1L', baseUom: 'ea', unitPriceMinor: 64_000, taxBps: 1200, status: 'active' }],
    barcodes: [{ code: GHEE, productId: 'P-GHEE', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(CUT_KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; basket(): { lineId: string; unitPriceMinor: number }[]; operator(): string | undefined };
}

const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
  + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').startsWith(${JSON.stringify(startsWith)}); })()`,
  undefined, { timeout: 15_000 },
);
const sheetTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'sheet', 'sheet-title', s);
const panelTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'pay', 'pay-title', s);
const sheetClosed = (page: Page): Promise<unknown> => page.waitForFunction("document.getElementById('sheet').hidden === true");
const refusalSays = (page: Page, words: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById('refusal'); return p !== null && !p.hidden && (p.textContent || '').includes(${JSON.stringify(words)}); })()`,
  undefined, { timeout: 15_000 },
);
const consequence = async (page: Page): Promise<{ title: string; what: string; detail: string; who: string; ok: string; cancel: string; focused: string; okClass: string }> =>
  page.evaluate(() => {
    const d = (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null; className: string } | null; activeElement: { id: string } | null } }).document;
    const text = (id: string): string => (d.getElementById(id)?.textContent ?? '').trim();
    return { title: text('sheet-title'), what: text('consequence-what'), detail: text('consequence-detail'), who: text('consequence-who'), ok: text('sheet-ok'), cancel: text('sheet-cancel'), focused: d.activeElement?.id ?? '', okClass: d.getElementById('sheet-ok')?.className ?? '' };
  });

describe.skipIf(!HAVE_BROWSER)('OB-626 A: the till confirms before money moves or a price is cut', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const openTill = async (edge: EdgeProcess): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    return page;
  };
  const keyDigits = async (page: Page, digits: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden]) #keypad:not([hidden])');
    for (const digit of digits) await page.click(`#keypad button:text-is("${digit}")`);
  };
  const cashRecords = async (edge: EdgeProcess) => (await readLog(edge.tillCashLog.path)).map((r) => readTillCashRecord(JSON.parse((r as { record: string }).record)));

  it('the float and cash to safe: the panel says the figure, whose name and the time; Go back and Escape send nothing; the verb sends it once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-u1-till-cash-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, CASH_PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: CASH_KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: CASH_KEY, pack: JSON.parse(CASH_PACK) as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const page = await openTill(edge);
    await signInThroughScreen(page);

    // ── Go back: the amount is keyed, the panel shows exactly what would be recorded, nothing reaches the box.
    const taps = new Tally(page);
    await taps.tap('#more');
    await panelTitled(page, 'More');
    await taps.tap('#pay-kinds button:text-is("Take float (open the till)")');
    await keyDigits(page, '2000');
    taps.count += 4; // the four keyed digits are four taps
    await taps.tap('#sheet-ok');
    await sheetTitled(page, 'Record the float?');
    const shown = await consequence(page);
    expect(shown).toMatchObject({ what: '₹2,000.00 will be recorded as float put into this drawer.', ok: 'Record the float', cancel: 'Go back', focused: 'sheet-cancel' });
    expect(shown.who).toMatch(/^By u-lanecash at \d{2}:\d{2} on this till\.$/);
    expect(shown.detail).toContain('corrected only by a second movement');
    expect(shown.okClass).not.toContain('danger');
    expect(await auditPage(page, { expectLang: 'en' }), 'the confirm panel, open').toEqual([]);
    await page.click('#sheet-cancel');
    await sheetClosed(page);
    expect(await cashRecords(edge), 'Go back sent nothing').toHaveLength(0);

    // ── Escape is Go back too.
    await page.click('#more');
    await page.click('#pay-kinds button:text-is("Take float (open the till)")');
    await keyDigits(page, '2000');
    await page.click('#sheet-ok');
    await sheetTitled(page, 'Record the float?');
    await page.keyboard.press('Escape');
    await sheetClosed(page);
    expect(await cashRecords(edge), 'Escape sent nothing').toHaveLength(0);

    // ── The verb, in Tamil: recorded once, on the box, under the cashier's name.
    await page.click('#lang');
    await page.waitForFunction("document.documentElement.lang === 'ta'");
    await page.click('#more');
    await panelTitled(page, 'மேலும்');
    await page.click('#pay-kinds button:text-is("ஆரம்பப் பணம் எடு (டில்லைத் திற)")');
    await keyDigits(page, '2000');
    await page.click('#sheet-ok');
    await sheetTitled(page, 'ஆரம்பப் பணத்தைப் பதிவு செய்யவா?');
    const ta = await consequence(page);
    expect(ta).toMatchObject({ what: '₹2,000.00 இந்த டிராயரில் போடப்பட்ட ஆரம்பப் பணமாகப் பதிவு செய்யப்படும்.', ok: 'ஆரம்பப் பணத்தைப் பதிவு செய்', cancel: 'பின் செல்' });
    expect(await auditPage(page, { expectLang: 'ta' }), 'the confirm panel in Tamil').toEqual([]);
    await page.click('#sheet-ok');
    await refusalSays(page, '₹2,000.00');
    await page.click('#refusal-ok');
    const afterFloat = await cashRecords(edge);
    expect(afterFloat).toHaveLength(1);
    expect(afterFloat[0]).toMatchObject({ kind: 'movement', movementKind: 'float_issue', amountMinor: 200_000, custodianId: 'u-lanecash', laneId: 'lane-1' });
    await page.click('#lang');
    await page.waitForFunction("document.documentElement.lang !== 'ta'");

    // ── Cash to safe: its own words, the same step. The budget, counted: More · Cash to safe · four digits · OK · the verb.
    const safe = new Tally(page);
    await safe.tap('#more');
    await safe.tap('#pay-kinds button:text-is("Cash to safe")');
    await keyDigits(page, '1000');
    safe.count += 4;
    await safe.tap('#sheet-ok');
    await sheetTitled(page, 'Record cash to the safe?');
    expect((await consequence(page)).what).toBe('₹1,000.00 will be recorded as moved from this drawer to the safe.');
    await safe.tap('#sheet-ok');
    await refusalSays(page, '₹1,000.00');
    // OB-626: the confirm is the one tap added to a cash movement — the amount itself is keyed, so the count is the digits plus
    // More, the choice, OK and the verb. Written down here so nobody reads it as "≤ 3" (the float was never within three).
    expect(safe.reset(), 'cash to safe: More · choice · 4 digits · OK · confirm').toBe(8);
    const records = await cashRecords(edge);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ kind: 'movement', movementKind: 'pickup', amountMinor: 100_000 });
  }, 120_000);

  it('a price cut: from, to, how much off and the lowest price are shown before any manager is asked; Go back asks nobody; Ask the manager goes on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-u1-till-cut-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: CUT_KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
      ...await prepareTillBox({ dir, key: CUT_KEY, people: PEOPLE, pack: { version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [], tillControls: TILL_CONTROLS } }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const page = await openTill(edge);
    await signInOnPage(page);
    await page.keyboard.type(GHEE);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);

    const askNewPrice = async (rupees: string): Promise<void> => {
      await page.click('#lines tr:first-child');
      await page.click('#more');
      await panelTitled(page, 'More');
      await page.click('#pay-kinds button:text-is("Change price of the selected line")');
      await sheetTitled(page, 'New price for one unit');
      await keyDigits(page, rupees);
      await page.click('#sheet-ok');
    };

    // ── Below the lowest price: refused at once, as before — no confirm panel for a cut the till itself refuses.
    await askNewPrice('450');
    await refusalSays(page, 'below the lowest price this item may be sold at (₹500.00)');
    await page.click('#refusal-ok');

    // ── A cut the till allows: the panel, in full, before the manager's badge is asked for.
    await askNewPrice('550');
    await sheetTitled(page, 'Lower the price of this line?');
    const shown = await consequence(page);
    expect(shown).toMatchObject({ what: 'Ghee 1L: from ₹640.00 to ₹550.00 for one unit — ₹90.00 off this line (14%).', ok: 'Ask the manager', cancel: 'Go back', focused: 'sheet-cancel' });
    expect(shown.detail).toBe('The lowest price this item may be sold at is ₹500.00. The store computer checks the cut against the approving manager\'s limit; above it the approval is refused and the line keeps its price.');
    expect(shown.who).toBe('Recorded on this bill in your name and the manager\'s, with the reason the manager gives.');
    expect(await auditPage(page, { expectLang: 'en' }), 'the price-cut panel, open').toEqual([]);
    await page.click('#sheet-cancel');
    await sheetClosed(page);
    // Nobody was asked, the line keeps its price, nothing reached the box.
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket()[0]!.unitPriceMinor)).toBe(64_000);
    const activities = async () => (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string }] : [])).filter((e) => e.type === 'TillActivityRecorded');
    expect(await activities()).toHaveLength(0);

    // ── In Tamil, the same panel; then Ask the manager → badge → PIN → reason → the price changes, recorded once on the box.
    await page.click('#lang');
    await page.waitForFunction("document.documentElement.lang === 'ta'");
    await page.click('#lines tr:first-child');
    await page.click('#more');
    await panelTitled(page, 'மேலும்');
    await page.click('#pay-kinds button:text-is("தேர்ந்த வரியின் விலையை மாற்று")');
    await page.waitForSelector('#sheet:not([hidden])');
    await keyDigits(page, '550');
    await page.click('#sheet-ok');
    await sheetTitled(page, 'இந்த வரியின் விலையைக் குறைக்கவா?');
    expect((await consequence(page)).what).toBe('Ghee 1L: ஒரு அலகுக்கு ₹640.00 இலிருந்து ₹550.00 வரை — இந்த வரியில் ₹90.00 குறைவு (14%).');
    expect(await auditPage(page, { expectLang: 'ta' }), 'the price-cut panel in Tamil').toEqual([]);
    await page.click('#sheet-cancel'); // Go back, in Tamil: still nobody asked
    await sheetClosed(page);
    expect(await activities()).toHaveLength(0);
    await page.click('#lang');
    await page.waitForFunction("document.documentElement.lang !== 'ta'");
    await askNewPrice('550');
    await sheetTitled(page, 'Lower the price of this line?');
    await page.click('#sheet-ok'); // Ask the manager
    await sheetTitled(page, 'Manager: scan your badge or key your staff ID');
    await page.keyboard.type('u-manager');
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: your till PIN');
    await page.keyboard.type(pinOf('u-manager'));
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: why is this allowed?');
    await page.click('#reasons button:text-is("Damaged pack, sold as is")');
    await page.click('#sheet-ok');
    await refusalSays(page, 'Price changed');
    await page.click('#refusal-ok');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket()[0]!.unitPriceMinor)).toBe(55_000);
    expect(await activities()).toHaveLength(1);
  }, 120_000);
});
