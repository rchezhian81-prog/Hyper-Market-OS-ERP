import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { prepareTillBox, pinOf, testPin } from '../support/till-operator';

/**
 * **The whole one-PC till, in a real browser: the box serves its own screen and takes its own sale.**
 *
 * This is the deployable arrangement, proven end to end. ONE edge process serves the real POS shell
 * (the screens server, exactly as the container entry point runs it) AND owns the write socket; a
 * real Chromium opens the served screen on that box's loopback origin, rings a sale through the shell
 * the cashier actually uses (`window.posSession`), and the sale lands durably on the box's disk and
 * is queued for the cloud. The commit crosses from the screen's port to the socket's port — the
 * cross-origin hop that increment 1 unblocked — so this exercises the served shell, the CORS answer
 * and the durable commit as one thing, the way an install on one shop PC does.
 *
 * It is the ground the install steps stand on: it proves a browser till committing a real sale on a
 * single machine, rather than asserting it. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'one', 'pc', 'signing', 'key'].join('-').padEnd(48, '0');

/** The slice of the served POS shell's globals the test drives — the cashier's own surface. */
interface PosWindow {
  readonly posSession?: {
    scan(item: { productId: string; description: string; unitPriceMinor: number; qty: number }): void;
    tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>;
    signInAtTill(input: { staffId?: string; pin?: string }): Promise<{ signedIn: boolean; laneMessage?: string }>;
    operator(): string | undefined;
  };
}

describe.skipIf(!HAVE_BROWSER)('the one-PC till serves its own screen and takes a sale', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // Build the CURRENT POS bundle so the browser runs this branch's shell, not a stale artifact —
    // the same thing an install does before opening the till.
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('a sale rung on the served screen lands on this box\'s disk and is queued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-'));
    dirs.push(dir);
    // The edge exactly as a one-PC install runs it: the write socket on the lane port the POS shell
    // posts to (its built-in default), and the screens server pointed at this repo's app shells.
    // The pack names the cashier with till authority and her till PIN is issued on this box (ADR-0020).
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    expect(edge.lane?.port, 'the lane socket must be on the port the POS shell posts to').toBe(8090);

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    // Open the till the way a cashier does — the screen served by this same box.
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    // Ring one item and take cash — the whole of a sale, driven through the shell's own surface.
    const receipt = await page.evaluate(async (pin) => {
      const w = globalThis as unknown as PosWindow;
      // The cashier signs in first — staff ID and till PIN, checked by the store computer (ADR-0020).
      const signedIn = await w.posSession!.signInAtTill({ staffId: 'u-lanecash', pin });
      if (!signedIn.signedIn) throw new Error(signedIn.laneMessage);
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      return w.posSession!.tenderCash('S-1', 'R-0001', '2026-08-28T10:00:00Z');
    }, pinOf('u-lanecash'));
    expect(receipt).toBe('R-0001');

    // The sale is durably on this box's disk — the commit crossed from the screen's port to the
    // socket's, and the socket accepted it (increment 1) and wrote it before answering.
    const records = await readLog(edge.log.path);
    expect(records).toHaveLength(1);
    const first = records[0];
    if (first?.ok !== true) throw new Error('the sale record did not land');
    const saved = JSON.parse(first.record) as { id: string; cashierId: string; laneId: string; tradingDay: string };
    expect(saved.id).toBe('S-1');
    // Who, where, which day — the real three (SP-4b · F09): the cashier who signed in, the lane the box IS, and a day
    // worked out at the moment of sale — never `cashier`, `lane-1`-by-default or 1970.
    expect(saved).toMatchObject({ cashierId: 'u-lanecash', laneId: 'lane-1' });
    expect(saved.tradingDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(saved.tradingDay).not.toBe('1970-01-01');
    // And the box stamped who it VERIFIED, and how — never a typed name (ADR-0020 §5).
    expect(JSON.parse(first.record)).toMatchObject({ operatorVerified: { userId: 'u-lanecash', via: 'pin' } });

    // And queued for the cloud — durable AND on its way, the two halves of a sale that is not lost.
    expect(edge.outbox.unsentCount()).toBe(1);
  });

  it('refuses a sale while nobody is signed in; a wrong PIN signs nobody in; the cashier signs in with staff ID and till PIN through the screen\'s own control, the header names lane and cashier, and a reload keeps the sign-in (F09 · PF-02)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-signin-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    // Nobody signed in: the header says so, and the model refuses to take payment in the cashier's words. Nothing lands.
    expect(await page.locator('#lane').textContent()).toContain('Nobody signed in');
    const refusal = await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      try { await w.posSession!.tenderCash('S-0', 'R-0000', '2026-08-28T09:00:00Z'); return null; } catch (e) { return (e as { laneMessage?: string }).laneMessage ?? String(e); }
    });
    expect(refusal).toContain('Sign in with your staff ID and till PIN');
    expect(await readLog(edge.log.path)).toHaveLength(0);

    // A typed name is not enough any more (audit PF-02): the right staff ID with a WRONG PIN signs nobody in, and says so.
    const pin = pinOf('u-lanecash');
    const wrong = testPin(1) === pin ? testPin(2) : testPin(1);
    await page.click('#signin');
    await page.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])'); // the staff-ID prompt is open
    await page.keyboard.type('u-lanecash');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('sheet')?.hidden === false && document.getElementById('entry')?.getAttribute('aria-label') !== null, undefined, { timeout: 5_000 }); // the PIN panel (masked), not the staff-ID one
    await page.keyboard.type(wrong);
    // The PIN is never on the screen: one dot per digit.
    expect(await page.locator('#entry').textContent()).toBe('••••••');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('refusal')?.hidden === false, undefined, { timeout: 5_000 });
    expect(await page.locator('#refusal-text').textContent()).toMatch(/do not match/);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.operator())).toBeUndefined();
    await page.click('#refusal-ok');

    // The cashier signs in the way the screen offers: the Sign in control, the badge scanner's keystrokes + Enter, then
    // the six-digit till PIN on the keypad (here the keyboard) + Enter.
    await page.click('#signin');
    await page.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])'); // the staff-ID prompt is open
    await page.keyboard.type('u-lanecash');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('sheet')?.hidden === false && document.getElementById('entry')?.getAttribute('aria-label') !== null, undefined, { timeout: 5_000 }); // the PIN panel (masked), not the staff-ID one
    await page.keyboard.type(pin);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-lanecash', undefined, { timeout: 5_000 });
    const header = await page.locator('#lane').textContent();
    expect(header).toContain('lane-1');
    expect(header).toContain('u-lanecash');
    expect(await page.locator('#signin').textContent()).toBe('Sign out');

    // A reload of this browser session keeps the cashier signed in — the real session is re-applied before paint.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-lanecash', undefined, { timeout: 5_000 });
    expect(await page.locator('#lane').textContent()).toContain('u-lanecash');
  });
  it('on the HOSTED copy (EDGE_LANE_TRUST_FORWARDED_USER=1) Sign in takes the person the front names — one tap, no PIN — and the sale is stamped as that verified sign-in (ADR-0020 §6)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-hosted-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '8090', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      EDGE_LANE_TRUST_FORWARDED_USER: '1',
      ...await prepareTillBox({ dir, key: KEY }),
    }, () => {}))!;
    stops.push(() => edge.stop());

    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    // What the hosted front does (infra/compose/nginx.pilot.conf): it names the person its password sign-in verified on
    // every request to the till's socket. Here the network layer adds it, as the front would — never the page.
    await page.route('http://127.0.0.1:8090/lane/**', (route) => route.continue({ headers: { ...route.request().headers(), 'x-sre-user': 'u-lanecash' } }));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession !== undefined, undefined, { timeout: 15_000 });

    await page.click('#signin');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.operator() === 'u-lanecash', undefined, { timeout: 5_000 });
    expect(await page.locator('#sheet').isHidden()).toBe(true); // no staff ID, no PIN asked
    const receipt = await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      w.posSession!.scan({ productId: 'P1', description: 'Amul Ghee Gold 1L', unitPriceMinor: 64_000, qty: 1 });
      return w.posSession!.tenderCash('S-H1', 'R-H001', '2026-08-28T11:00:00Z');
    });
    expect(receipt).toBe('R-H001');
    const records = await readLog(edge.log.path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ok === true && JSON.parse(records[0].record)).toMatchObject({ cashierId: 'u-lanecash', operatorVerified: { userId: 'u-lanecash', via: 'verified_sign_in' } });
  });
});
