import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { Tally } from './lib/tally';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, pinOf } from '../support/till-operator';

/**
 * **The till and the manager meet the spec's interaction budget — measured, in a real browser (Stage G slice 2b ·
 * design system §1 rule 1 · QG-02 · pos-cashier.md · store-manager.md).**
 *
 * The design system's first hard rule: ≤ 3 interactions for any action done more than ten times a day, and the
 * screen specs list the actions with their budgets. Until now that was a target nobody counted. This counts. A real
 * Chromium drives the SERVED screens (one edge process serves the page and owns the lane socket, as a shop PC does)
 * and every tap and scan is tallied per spec row; the row fails if the state is not reached inside its budget.
 *
 *   Till (pos-cashier.md)                       budget   Manager (store-manager.md)          budget
 *   sign in for the shift: Sign in → badge scan    2     (once a shift, not per sale — SP-4b)
 *   scan an item (a scanner is one act)            1     approve a request, reason recorded     3
 *   change quantity: line → Qty → number           3     start the day close                    2
 *   go to tender                                   1
 *   take cash: Tender → Cash → the note in hand    3
 *   suspend / recall a basket                      1 / 1
 *
 * Skips where no browser binary is present, like its siblings.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['interaction', 'budget', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

/** The till's store pack: one sellable item at ₹160 with a barcode (tax rate and status present, or the box excludes it). */
const TILL_PACK = JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 16_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});

/**
 * A store pack with one approval the served manager may clear. The served manager is the person the pack NAMES
 * (`managerPolicy`, Stage G slice 5c), in the pack's own branch; the request is one routed to that branch from
 * somebody else, within the named limit.
 */
const MANAGER_PACK = JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'store-1', branchId: 'store-1' },
  managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  lossPreventionRules: [],
  approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Toor dal 1kg', requestedBy: 'u-buyer', branchId: 'store-1', valueMinor: 45_000 }],
});

interface PosWindow {
  readonly posSession?: { hasCatalogue(): boolean; operator(): string | undefined };
  readonly managerSession?: unknown;
}

/** The slice of the page's DOM the in-page predicates read (this config has no DOM library on purpose). */
interface Doc {
  readonly document: {
    querySelector(selector: string): { hidden: boolean; textContent: string | null; children: { length: number } } | null;
  };
}

describe.skipIf(!HAVE_BROWSER)('the spec\'s interaction budget, counted on the served screens', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A real box: the store pack on disk, the screens served, the lane socket open — as a one-PC install runs it. */
  async function box(pack: string, extra: Record<string, string>): Promise<EdgeProcess> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-budget-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, pack, 'utf8');
    // A till box also names its cashier with till authority and has her PIN issued (ADR-0020); the manager box is left
    // exactly as its pack says, so its named manager keeps the authority the pack gives.
    const till = extra['EDGE_LANE_ID'] === undefined ? {} : await prepareTillBox({ dir, key: KEY, pack: JSON.parse(pack) as Record<string, unknown>, laneId: extra['EDGE_LANE_ID'] });
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...extra, ...till,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return edge;
  }

  async function open(path: string, ready: 'till' | 'manager', port: number): Promise<Page> {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'load' });
    // The predicates run INSIDE the page (serialised), so they read the page's own globals.
    if (ready === 'till') {
      await page.waitForFunction(() => {
        const w = globalThis as unknown as PosWindow;
        return w.posSession !== undefined && w.posSession.hasCatalogue();
      }, undefined, { timeout: 15_000 });
    } else {
      await page.waitForFunction(() => (globalThis as unknown as PosWindow).managerSession !== undefined, undefined, { timeout: 15_000 });
    }
    return page;
  }

  it('till: sign in 3 · scan 1 · quantity 3 · tender 1 · cash 3 · hold 1 · recall 1 — and the sale lands on the box', async () => {
    const edge = await box(TILL_PACK, { EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1' });
    const page = await open('/pos/', 'till', edge.screens!.port);
    const taps = new Tally(page);

    // Sign in for the shift (SP-4b · F09 · ADR-0020): tap Sign in, scan the staff badge, key the till PIN — three acts, once a
    // shift, never per sale. The PIN is what makes the name on every sale a person the box verified (audit PF-02).
    await taps.tap('#signin');
    await taps.scan('u-lanecash');
    await page.waitForSelector('#sheet:not([hidden]) #entry[aria-label]'); // the PIN panel (masked), not the staff-ID one
    await taps.key(pinOf('u-lanecash'));
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.operator() === 'u-lanecash');
    expect(taps.reset(), 'sign in for the shift').toBeLessThanOrEqual(3);

    // Scan an item — one act, no target to find. The catalogue the box trusted prices it.
    await taps.scan('8901234567890');
    await page.waitForSelector('#lines tr');
    expect(taps.reset(), 'scan an item').toBeLessThanOrEqual(1);
    expect(await page.textContent('#total')).toBe('₹160.00');

    // Change quantity: tap the line, tap Qty, tap the number. Three — and the number is one tap, not a keypad.
    await taps.tap('#lines tr');
    await taps.tap('#qty');
    await page.waitForSelector('#quick button');
    expect(await page.$$eval('#quick button', (b) => b.map((x) => x.textContent))).toEqual(['2', '3', '4', '5', '6']);
    await taps.tap('#quick button:nth-child(2)'); // "3"
    await page.waitForFunction(() => (globalThis as unknown as Doc).document.querySelector('#total')?.textContent === '₹480.00');
    expect(taps.reset(), 'change quantity').toBeLessThanOrEqual(3);

    // Suspend and recall: one tap each, and the screen SAYS the basket is held.
    await taps.tap('#hold');
    // The basket goes to the store computer's disk first (audit PF-05); the screen then says it is held — still one tap.
    await page.waitForFunction(() => /held|on hold/i.test((globalThis as unknown as Doc).document.querySelector('#empty')?.textContent ?? ''), undefined, { timeout: 5_000 });
    expect(await page.textContent('#empty')).toMatch(/held|on hold/i);
    expect(taps.reset(), 'suspend').toBeLessThanOrEqual(1);
    await taps.tap('#hold');
    await page.waitForSelector('#lines tr');
    expect(taps.reset(), 'recall').toBeLessThanOrEqual(1);

    // Go to tender: one tap. Take cash: Tender → Cash → the note in the customer's hand — three, change worked out.
    await taps.tap('#tender');
    await page.waitForSelector('#pay-kinds button');
    expect(taps.count, 'go to tender').toBe(1);
    await taps.tap('#pay-kinds button:first-child'); // Cash — ₹480.00
    await page.waitForSelector('#quick button');
    const quick = await page.$$eval('#quick button', (b) => b.map((x) => x.textContent));
    expect(quick[0]).toMatch(/^Exact ₹480\.00$/);
    expect(quick).toContain('₹500.00'); // the next note that covers the bill; never one below it
    expect(quick.some((q) => /₹(100|200)\.00/.test(q ?? ''))).toBe(false);
    await taps.tap('#quick button:nth-child(2)'); // ₹500
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#refusal') as { hidden: boolean }).hidden);
    expect(taps.reset(), 'take cash payment').toBeLessThanOrEqual(3);
    expect(await page.textContent('#refusal-title')).toBe('Change due: ₹20.00');
    // The sale is on the box's disk and queued — the shell only ever asked the box (hard rule #1).
    expect(edge.outbox.unsentCount()).toBe(1);
  });

  it('manager: home → next approval → Approve → reason = 3, recorded; start the day close = 2', async () => {
    const edge = await box(MANAGER_PACK, { EDGE_LANE_PORT: '0' });
    const page = await open('/manager', 'manager', edge.screens!.port);
    const taps = new Tally(page);

    // The home screen offers ONE primary action, and only because there is a request this manager may clear.
    await page.waitForSelector('#next-approval:not([hidden])');
    expect(await page.textContent('#next-approval')).toBe('Clear the next approval (1)');
    await taps.tap('#next-approval');
    await page.waitForSelector('#view-approvals:not([hidden]) .row-actions button');
    await taps.tap('#approval-rows .row-actions button.primary'); // Approve
    await page.waitForSelector('#choices button');
    await taps.tap('#choices button:first-child'); // the reason — a CODE from the model's own catalogue
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#banner') as { hidden: boolean }).hidden);
    expect(taps.reset(), 'approve with a reason').toBeLessThanOrEqual(3);
    expect(await page.textContent('#banner-title')).toBe('Decided');
    expect(await page.textContent('#banner-text')).toContain('Toor dal 1kg');

    // Start the day close: the tab, then the check. Two — and what comes back is a list, not "cannot".
    await page.click('#banner-ok');
    await taps.tap('#tab-close');
    await taps.tap('#check-close');
    await page.waitForFunction(() => ((globalThis as unknown as Doc).document.querySelector('#blockers')?.children.length ?? 0) > 0
      || !((globalThis as unknown as Doc).document.querySelector('#do-close') as { hidden: boolean }).hidden);
    expect(taps.reset(), 'start the day close').toBeLessThanOrEqual(2);
  });
});
