import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';

/**
 * **W3 · D06-FR-03 · OB-673 and D07-FR-04 · OB-677 through the till's SCREEN, with no head office at all.**
 *
 * In a real Chromium against a real store computer holding head office's signed coupons and gift cards in its store pack
 * (as it restores one from disk), and NO cloud configured — head office cannot be reached:
 *   • More → Coupon → DIWALI50: the store computer's copy says what it is, the till takes ₹50 off and shows it by the total;
 *   • Tender → Gift card → GC-1001 (₹800 on the card): offline the till may take ₹500 (the owner's limit) and says so; the
 *     rest is paid in cash. On the box's disk: the coupon on the bill, the gift card taken offline;
 *   • More → Sell a gift card: a new card sold for cash, saved on the store computer, shown by its last four only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'vouchers', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

const PACK = {
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '00:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
  // Head office's coupons and gift cards, as its store pack carries them (services/api/src/till-vouchers-adapters.ts).
  coupons: { coupons: [{ code: 'DIWALI50', kind: 'amount_off', valueMinor: 5_000, issuedAt: '2026-10-01T00:00:00Z', validUntil: '2099-12-31', maxRedemptions: 1, maxPerCustomer: 1 }], redemptions: [] },
  giftCards: { offlineCapMinor: 50_000, cards: [{ code: 'GC-1001', balanceMinor: 80_000, appliedMovementIds: [] }] },
};

describe.skipIf(!HAVE_BROWSER)('the served till takes a coupon and a gift card with head office unreachable (OB-673 · OB-677)', () => {
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

  const typeText = async (page: Page, text: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden]) #entry-text:not([hidden])');
    await page.fill('#entry-text', text);
    await page.click('#sheet-ok');
  };
  const keyDigits = async (page: Page, digits: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of digits) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
  };
  const shown = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const title = (await page.textContent('#refusal-title')) ?? '';
    const text = (await page.textContent('#refusal-text')) ?? '';
    await page.click('#refusal-ok');
    return { title, text };
  };
  const options = async (page: Page): Promise<string[]> => {
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, startsWith: string): Promise<void> => {
    const labels = await options(page);
    const label = labels.find((l) => l.startsWith(startsWith));
    if (label === undefined) throw new Error(`no "${startsWith}" among ${JSON.stringify(labels)}`);
    await page.click(`#pay-kinds button:text-is("${label}")`);
  };
  const quick = async (page: Page, startsWith: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden]) #quick:not([hidden])');
    const labels = await page.$$eval('#quick button', (b) => b.map((x) => x.textContent ?? ''));
    const label = labels.find((l) => l.startsWith(startsWith));
    if (label === undefined) throw new Error(`no quick "${startsWith}" among ${JSON.stringify(labels)}`);
    await page.click(`#quick button:text-is("${label}")`);
  };
  const scanDal = async (page: Page): Promise<void> => {
    await page.keyboard.type('8901234567890');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#lines tr');
  };

  it('More → Coupon takes ₹50 off; Tender → Gift card takes the offline ₹500 and cash the rest; More → Sell a gift card saves a new card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-vouchers-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify(PACK), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, pack: PACK as unknown as Record<string, unknown> }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const w = globalThis as unknown as { posSession?: { hasCatalogue(): boolean } };
      return w.posSession !== undefined && w.posSession.hasCatalogue();
    }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);

    // Two packs of dal (₹960), then the coupon.
    await scanDal(page);
    await scanDal(page);
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('total')?.textContent === '₹960.00');
    await page.click('#more');
    await choose(page, 'Coupon');
    await typeText(page, 'DIWALI50');
    expect((await shown(page)).text).toContain('Coupon DIWALI50: ₹50.00 off this bill.');
    expect(await page.textContent('#total')).toBe('₹910.00');
    expect(await page.textContent('#coupon-on-bill')).toBe('Coupon DIWALI50: −₹50.00');

    // Tender → Gift card: offline, at most ₹500 from this card on this till; the till says so.
    await page.click('#tender');
    await choose(page, 'Gift card');
    await typeText(page, 'GC-1001');
    await page.waitForSelector('#sheet:not([hidden]) #quick:not([hidden])');
    const hint = (await page.textContent('#entry-hint')) ?? '';
    expect(hint).toContain('Gift card ••••1001 holds ₹800.00. This till may take up to ₹500.00 now.');
    expect(hint).toContain('Head office cannot be reached: at most ₹500.00 from one card on this till until the link is back');
    expect(await page.textContent('#sheet')).not.toContain('GC-1001');
    await quick(page, 'up to ₹500.00');
    expect((await page.textContent('#pay-title')) ?? '').toContain('₹410.00');
    await choose(page, 'Cash');
    await quick(page, '₹500.00');
    const paid = await shown(page);
    expect(paid.title, paid.text).toContain('₹90.00'); // change due

    const onDisk = (await readLog(edge.log.path)).map((r) => JSON.parse((r as { record: string }).record) as { total: number; coupons?: unknown; tenders: { kind: string; amount: { minor: number }; giftCard?: unknown }[] });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.total).toBe(91_000);
    expect(onDisk[0]!.coupons).toEqual([{ code: 'DIWALI50', discountMinor: 5_000 }]);
    expect(onDisk[0]!.tenders.map((t) => [t.kind, t.amount.minor, t.giftCard])).toEqual([['gift_card', 50_000, { code: 'GC-1001', capturedOffline: true }], ['cash', 41_000, undefined]]);

    // More → Sell a gift card: a new card for ₹300 in cash — its own record, shown by its last four only.
    await page.click('#more');
    await choose(page, 'Sell a gift card');
    await typeText(page, 'GC-2002');
    await keyDigits(page, '300');
    await choose(page, 'Cash');
    const soldSaid = await shown(page);
    expect(soldSaid.title).toBe('Gift card sold');
    expect(soldSaid.text).toContain('Gift card ••••2002 sold for ₹300.00');
    expect(soldSaid.text).not.toContain('GC-2002');
    const after = (await readLog(edge.log.path)).map((r) => JSON.parse((r as { record: string }).record) as { kind?: string; giftCardsSold?: unknown; total: number });
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ kind: 'gift_card_sale', total: 30_000, giftCardsSold: [{ code: 'GC-2002', faceValueMinor: 30_000 }] });
  }, 90_000);
});
