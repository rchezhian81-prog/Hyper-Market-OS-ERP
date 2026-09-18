import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';

/**
 * **The store manager closes the day, in a real browser, and it reaches the store computer (M14-FR-04 · P-01).**
 *
 * This is the join every earlier slice built toward and none could make on its own. Slices 1 & 2 gave
 * the cloud its route and the sync agent its transport; slice 3a gave the box an AUTHORITATIVE
 * `edge.closeDay`; slice 3b opened the box's `/lane/day-close` socket. But the SERVED manager screen
 * still locked the day against a throwaway in-browser outbox that nothing ever drained — it locked a
 * page, not a store, and nothing reached head office. Slice 3c wires the button to the box.
 *
 * Everything below the browser is production: the real `startEdge` serves the real manager shell (with
 * `window.laneWriteBase` injected — the box telling the screen where its write socket is), opens the
 * real lane socket, and stands the real box `closeDay` behind it. A REAL headless Chromium loads the
 * screen, taps **"Close the day now"**, and:
 *
 *   • the happy path — a clean day locks on the BOX (a durable record on the box's day-close log, queued
 *     for the cloud), and the screen shows "closed and locked". Nothing about this touched a browser-only
 *     outbox;
 *   • the box-is-the-authority path — a sale rung on the box AFTER the page loaded (so the screen's
 *     last-synced view still reads clean) makes the box REFUSE the close it optimistically offered, and
 *     the screen surfaces the box's own reason rather than a false all-clear (P-08). The day does not lock.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS
 * rather than failing, exactly like the sibling delivery suites.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['manager', 'day', 'close', 'e2e', 'pack', 'signing', 'key'].join('-').padEnd(48, '0');

/** A store pack the box loads from disk: a CHECKED (empty) loss-prevention register + a 02:00 cut-off. Its
 *  presence is what lets a clean day close — an absent register is a hard block by design (M14-FR-04). */
const PACK_JSON = JSON.stringify({ version: 1, policies: { tradingDayCutoff: '02:00' }, lossPreventionRules: [] });

/** An edge-committed sale, in the disk shape the lane writes — used to make the box's outbox non-empty. */
const saleRecord = (saleId: string) => JSON.stringify({
  id: saleId, number: `R-${saleId}`, laneId: 'lane-1', cashierId: 'u-lanecash',
  tradingDay: '2026-08-07', committedAt: '2026-08-07T10:00:00.000Z', total: 15000, currency: 'INR',
  lines: [{ productId: 'P1', quantityMinor: 3, uom: 'each', unitPriceMinor: 5000, lineTotalMinor: 15000 }],
  tenders: [{ kind: 'cash', amount: { minor: 15000, currency: 'INR' } }],
});

/** The tiny slice of the DOM these checks touch, cast structurally so the file needs no DOM lib. */
interface BrowserGlobals {
  readonly laneWriteBase?: string;
  readonly managerSession?: { readonly canCloseViaBox?: boolean };
  readonly document: { getElementById(id: string): { readonly textContent: string | null; readonly hidden: boolean } | null };
}

describe.skipIf(!HAVE_BROWSER)('the store manager closes the day and it reaches the store computer (M14-FR-04)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // Build the CURRENT web-erp bundle so the browser runs this branch's code, not a stale artifact.
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 60_000);

  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /** A real box that serves the manager screen AND stands its lane socket + authoritative close behind it. */
  async function boxWithScreen(): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-mgr-dayclose-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.screens!.port}` };
  }

  /** Open the manager screen, go to the close tab, and reveal the close button (check first, as a manager does). */
  async function openCloseTab(base: string) {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${base}/manager`, { waitUntil: 'load' });
    // The box told the screen where to write (the main.ts → screen-server injection this slice adds).
    await page.waitForFunction(() => typeof (globalThis as unknown as BrowserGlobals).laneWriteBase === 'string', undefined, { timeout: 10_000 });
    await page.click('#tab-close');
    await page.click('#check-close');
    return page;
  }

  it('a clean day: the tap locks the day ON THE BOX (durable + queued for the cloud) and the screen says so', async () => {
    const { edge, base } = await boxWithScreen();
    const page = await openCloseTab(base);

    // The screen knows it posts to the box (the port is wired), and the box's lane address is this box's lane.
    expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).laneWriteBase))
      .toBe(`http://127.0.0.1:${edge.lane!.port}`);
    expect(await page.evaluate(() => (globalThis as unknown as BrowserGlobals).managerSession?.canCloseViaBox)).toBe(true);

    // A clean day → the close button is offered. Tap it: this posts to the box, cross-port.
    await page.waitForSelector('#do-close:not([hidden])', { timeout: 10_000 });
    await page.click('#do-close');

    // The screen shows the box's success — locked — not a browser-only "done".
    await page.waitForFunction(
      () => ((globalThis as unknown as BrowserGlobals).document.getElementById('banner-title')?.textContent ?? '').toLowerCase().includes('closed'),
      undefined, { timeout: 10_000 },
    );
    expect((await page.textContent('#banner-title'))?.toLowerCase()).toContain('closed');
    // The close button is gone once the day is locked (nothing left to tap).
    expect(await page.locator('#do-close').getAttribute('hidden')).not.toBeNull();

    // The proof this reached the STORE COMPUTER, not a page: a durable record on the box's day-close log,
    // queued for head office. This is exactly what the browser-only close could never produce.
    expect(edge.dayCloseOutbox.pending().map((i) => i.event.type)).toContain('StoreDayClosed');
    const records = await readLog(edge.dayCloseLog.path);
    const closed = records.filter((r) => r.ok === true).map((r) => JSON.parse(r.record) as { dayCloseId: string; closedBy: string; locked: boolean });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.locked).toBe(true);
    expect(closed[0]?.closedBy).toBe('manager'); // the served session's manager id travels with the ask
    expect(closed[0]?.dayCloseId).toMatch(/^dc-/); // the screen minted it
  });

  it('the box is the authority: a sale rung after the page loaded makes the box REFUSE, and the screen says why', async () => {
    const { edge, base } = await boxWithScreen();
    const page = await openCloseTab(base);
    // The clean page offered the close (its last-synced view is empty)…
    await page.waitForSelector('#do-close:not([hidden])', { timeout: 10_000 });

    // …but a sale is now committed on the box, unsent. The screen cannot see it; the box can, and the box decides.
    await edge.node.commit('S-LATE', saleRecord('S-LATE'));
    expect(edge.outbox.pending().length).toBe(1);

    await page.click('#do-close');

    // The box refuses, and the screen surfaces ITS reason (unsent items) rather than a false all-clear.
    await page.waitForFunction(
      () => ((globalThis as unknown as BrowserGlobals).document.getElementById('banner-title')?.textContent ?? '').toLowerCase().includes('cannot close'),
      undefined, { timeout: 10_000 },
    );
    expect((await page.textContent('#banner-text'))?.toLowerCase()).toMatch(/unsent|not yet reconciled|head office|cloud/);

    // The day did NOT lock: nothing was written to the box's day-close log or queued.
    expect(edge.dayCloseOutbox.pending()).toHaveLength(0);
    const records = await readLog(edge.dayCloseLog.path);
    expect(records.filter((r) => r.ok === true)).toHaveLength(0);
  });
});
