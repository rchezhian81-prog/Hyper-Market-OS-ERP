import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { pinOf, prepareTillBox } from '../support/till-operator';

/**
 * **A staff ID with letters can be keyed on the till's own pads (store PC, 6 Nov 2026 · P-07 · OB-277).** The pilot
 * cashier's login is `cashier-01`, but the "Your staff ID" pad had digits only: on a touch till with no keyboard and no
 * badge she could not sign in (on the store PC she typed it on the keyboard). The staff-ID pad now keeps its digits
 * first (a badge number) and an "abc" key opens the letters, in lower case as logins are written — for the cashier's
 * sign-in and the manager's approval alike. A scanned or keyboard-typed ID still signs in at once.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['served', 'till', 'staff', 'letters', 'signing', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'cashier-01';
const PEOPLE = [{ userId: CASHIER, displayName: 'Pilot cashier' }, { userId: 'store-manager-01', displayName: 'Manager', manager: true }];

describe.skipIf(!HAVE_BROWSER)('the till signs a cashier in from the on-screen pads, letters and all', () => {
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

  async function till(): Promise<Page> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-staff-letters-'));
    dirs.push(dir);
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      ...await prepareTillBox({ dir, key: KEY, people: PEOPLE }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { posSession?: unknown }).posSession !== undefined, undefined, { timeout: 15_000 });
    return page;
  }
  const operator = (page: Page): Promise<string | undefined> => page.evaluate(() => (globalThis as unknown as { posSession: { operator(): string | undefined } }).posSession.operator());

  it('Sign in → digits first, "abc" opens lower-case letters → cashier-01 tapped in → PIN → signed in as cashier-01', { timeout: 60_000 }, async () => {
    const page = await till();
    await page.click('#signin');
    await page.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])');

    // The digits show first (a badge number), with the switch to the letters; the letters are lower case.
    expect(await page.isVisible('#keypad')).toBe(true);
    expect(await page.isVisible('#letterpad')).toBe(false);
    expect((await page.textContent('#pad-switch'))?.trim()).toBe('abc');
    await page.click('#pad-switch');
    expect(await page.isVisible('#letterpad')).toBe(true);
    expect(await page.isVisible('#letterpad button:text-is("c")')).toBe(true);
    expect(await page.$('#letterpad button:text-is("C")')).toBeNull();

    for (const ch of CASHIER) {
      const wantLetters = /[a-z-]/.test(ch);
      if (wantLetters !== await page.isVisible('#letterpad')) await page.click('#pad-switch');
      const before = (await page.textContent('#entry')) ?? '';
      await page.click(`${wantLetters ? '#letterpad' : '#keypad'} button:text-is("${ch}")`);
      await page.waitForFunction((want) => (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document.getElementById('entry')?.textContent === want, before + ch, { timeout: 5_000 });
    }
    expect(await page.textContent('#entry')).toBe(CASHIER);
    await page.click('#sheet-ok');

    await page.waitForSelector('#sheet:not([hidden]) #entry[aria-label]', { timeout: 5_000 }); // the masked PIN pad
    expect(await page.isVisible('#pad-switch')).toBe(false); // a PIN is digits only
    for (const d of pinOf(CASHIER)) await page.click(`#keypad button:text-is("${d}")`);
    await page.click('#sheet-ok');
    await page.waitForFunction((who) => (globalThis as unknown as { posSession: { operator(): string | undefined } }).posSession.operator() === who, CASHIER, { timeout: 5_000 });
    expect(await operator(page)).toBe(CASHIER);
  });

  it('typed on the keyboard (or scanned) the ID still signs in at once; the letter c on the pad is a letter, never Clear', { timeout: 60_000 }, async () => {
    const page = await till();
    await page.click('#signin');
    await page.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])');
    await page.click('#pad-switch');
    await page.click('#letterpad button:text-is("c")');
    await page.click('#letterpad button:text-is("c")');
    expect(await page.textContent('#entry')).toBe('cc');
    await page.click('#sheet-cancel');

    await page.click('#signin');
    await page.waitForSelector('#sheet:not([hidden]) #entry:not([aria-label])');
    await page.keyboard.type(CASHIER);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#sheet:not([hidden]) #entry[aria-label]', { timeout: 5_000 });
    await page.keyboard.type(pinOf(CASHIER));
    await page.keyboard.press('Enter');
    await page.waitForFunction((who) => (globalThis as unknown as { posSession: { operator(): string | undefined } }).posSession.operator() === who, CASHIER, { timeout: 5_000 });
  });
});
