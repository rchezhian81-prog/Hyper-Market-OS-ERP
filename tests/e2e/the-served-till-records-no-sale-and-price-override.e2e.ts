import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, signInOnPage, pinOf } from '../support/till-operator';

/**
 * **PF-07 in a real browser, through the till's own More menu — "Open drawer (no sale)" and "Change price of the selected
 * line", each approved by a manager with their own PIN, are on the store computer's disk with the cashier and the
 * manager before the till acts (M12-FR-04 · M15-FR-01 · §28).** No network to head office is involved: the box decides.
 * Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'override', 'evidence', 'key'].join('-').padEnd(48, '0');
const PEOPLE = [
  { userId: 'u-lanecash', displayName: 'Lane Cashier' },
  { userId: 'u-manager', displayName: 'Manager', permissions: ['pos.sale.sync', 'pos.return.approve', 'pos.override.approve'] },
];

interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    basket(): { lineId: string; unitPriceMinor: number }[];
  };
}

const shows = (page: Page, panelId: string, titleId: string, startsWith: string): Promise<unknown> => page.waitForFunction(
  `(() => { const p = document.getElementById(${JSON.stringify(panelId)}); const t = document.getElementById(${JSON.stringify(titleId)});`
  + ` return p !== null && !p.hidden && t !== null && (t.textContent || '').startsWith(${JSON.stringify(startsWith)}); })()`,
  undefined, { timeout: 15_000 },
);
const sheetTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'sheet', 'sheet-title', s);
const panelTitled = (page: Page, s: string): Promise<unknown> => shows(page, 'pay', 'pay-title', s);

describe.skipIf(!HAVE_BROWSER)('the served till records a no-sale and a price change, approved by a manager (audit PF-07)', () => {
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

  const managerApprovesOnScreen = async (page: Page, reason: string): Promise<void> => {
    await sheetTitled(page, 'Manager: scan your badge or key your staff ID');
    await page.keyboard.type('u-manager');
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: your till PIN');
    await page.keyboard.type(pinOf('u-manager'));
    await page.keyboard.press('Enter');
    await sheetTitled(page, 'Manager: why is this allowed?');
    await page.click(`#reasons button:text-is("${reason}")`);
    await page.click('#sheet-ok');
  };

  it('More → Open drawer (no sale) → manager → "Recorded — open the drawer"; More → Change price → ₹500 → manager → the line is ₹500; both on the box\'s disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-override-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, people: PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await signInOnPage(page);

    // ── A no-sale.
    await page.click('#more');
    await panelTitled(page, 'More');
    await page.click('#pay-kinds button:text-is("Open drawer (no sale)")');
    await managerApprovesOnScreen(page, 'Change for a customer');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#refusal-title')).toBe('Recorded — open the drawer');
    await page.click('#refusal-ok');

    // ── A price change on a selected line. Redraw the basket the way the void e2e does (hold → recall).
    await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.scan({ productId: 'P1', description: 'Ghee 1L', unitPriceMinor: 64_000, qty: 1 }));
    await page.click('#hold');
    await page.waitForFunction(() => /on hold/i.test((globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('#empty')?.textContent ?? ''), undefined, { timeout: 5_000 });
    await page.click('#hold');
    await page.waitForSelector('#lines tr:first-child', { timeout: 5_000 });
    await page.click('#lines tr:first-child');
    await page.click('#more');
    await panelTitled(page, 'More');
    await page.click('#pay-kinds button:text-is("Change price of the selected line")');
    await sheetTitled(page, 'New price for one unit');
    for (const digit of '500') await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await managerApprovesOnScreen(page, 'Damaged pack, sold as is');
    await page.waitForSelector('#refusal:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#refusal-title')).toBe('Price changed');
    await page.click('#refusal-ok');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket()[0]!.unitPriceMinor)).toBe(50_000);

    const onBox = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []))
      .filter((e) => e.type === 'TillActivityRecorded');
    expect(onBox.map((e) => [e.payload['kind'], e.payload['cashierId'], e.payload['approvedBy'], e.payload['reason'], e.payload['valueMinor']])).toEqual([
      ['no_sale', 'u-lanecash', 'u-manager', 'change_for_customer', 0],
      ['price_override', 'u-lanecash', 'u-manager', 'damaged_pack', 14_000],
    ]);
    expect(edge.deviceEventsOutbox.pending().filter((i) => i.event.type === 'TillActivityRecorded')).toHaveLength(2);
  }, 90_000);
});
