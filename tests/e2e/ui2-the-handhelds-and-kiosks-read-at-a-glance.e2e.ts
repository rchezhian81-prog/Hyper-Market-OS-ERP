import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, pinOf } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';
import { serveShell, tillCatalogue, WAREHOUSE, PICKER, DRIVER, SIDEWAYS, smallTargets, type Handheld } from './lib/device-screens';

/**
 * **UI-2 (owner, 1 Nov 2026: "UI/UX also very poor" — "Till and handhelds"): the staff phones and the customer screens.**
 *
 * In real Chromium, each screen served as the store computer serves it, in English and Tamil:
 *
 *   • the warehouse, picker and driver handhelds, and the queue till, on a low-spec phone's 360px screen: nothing
 *     scrolls sideways, every control is at least 44px (the handhelds' own audit bar of 56px is clean too), the store
 *     computer's connection state is in the header and still on screen after the work list is scrolled to its end (P-08);
 *     the warehouse header names the job, not a code, and a count of pieces reads "12 units", never "12 units · EA";
 *   • the queue till and the self-checkout lane say each line's quantity in words, and the amount to pay is the largest
 *     figure on the screen;
 *   • the price kiosk lays the model's sentence out as name, price (the largest thing on the screen) and note — the
 *     sentence itself unchanged — and a refusal is the amber card;
 *   • the self-checkout lane's screen-reader names are in Tamil too.
 *
 * The warehouse header, the "12 units", the quantities in words, the largest-figure checks, the kiosk card and the Tamil
 * names each failed on the screens before UI-2. Screenshots go to SRE_SHOTS when it names a folder.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['ui2', 'kiosk', 'signing', 'key'].join('-').padEnd(48, '0');
const RICE = '8900000000707';
const DAL = '8901234567890';
const BANANA = '8900000000999';
const PHONE = { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true };

/** The font size of the largest visible words on the page, other than those inside `except`. */
const largestOtherText = (except: string): string => `Math.max(...[...document.querySelectorAll('body *')].filter((e) => e.closest(${JSON.stringify(except)}) === null && e.offsetParent !== null && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '')).map((e) => parseFloat(getComputedStyle(e).fontSize)))`;
const fontOf = (sel: string): string => `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).fontSize)`;

describe.skipIf(!existsSync(CHROMIUM))('UI-2: the handhelds and the kiosks read at a glance', () => {
  let browser: Browser;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
    for (const app of ['warehouse-app', 'picker-app', 'delivery-app', 'queue-pos', 'price-kiosk', 'self-checkout']) execFileSync('node', ['scripts/build-app.mjs', app], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 240_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

  const shot = async (page: Page, name: string): Promise<void> => { if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
  const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').trim();
  const tamil = async (page: Page): Promise<void> => { await page.click('#lang'); await page.waitForFunction('document.documentElement.lang === "ta"'); };

  async function phone(shell: Handheld): Promise<{ page: Page; errors: string[] }> {
    const srv = await serveShell(shell.app, { [shell.global]: shell.data() });
    stops.push(srv.stop);
    const context = await browser.newContext(PHONE);
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction(`globalThis.${shell.ready} !== undefined && typeof globalThis.sreIcon === 'function'`, undefined, { timeout: 15_000 });
    return { page, errors };
  }

  /** The connection state: in the header, said in words, and still on screen with the work list scrolled to its end. */
  async function expectConnectionAlwaysSeen(page: Page, words: RegExp): Promise<void> {
    expect(await text(page, 'header .sync #box-text')).toMatch(words);
    await page.evaluate('document.querySelector("main").scrollTop = 1e6; window.scrollTo(0, 1e6)');
    const box = await page.locator('header .sync').boundingBox();
    expect(box, 'the connection state is on screen').not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(740);
  }

  for (const shell of [WAREHOUSE, PICKER, DRIVER]) {
    it(`${shell.app} at 360px: no sideways scroll, 44px targets (the 56px audit clean), the connection always seen — English and Tamil`, async () => {
      const { page, errors } = await phone(shell);
      if (shell === WAREHOUSE) {
        // the job, not a code; the staff code and the job said as what they are; a count of pieces without "EA"
        expect(await text(page, 'h1#who')).toBe('Stock room work Staff u-worker · Job A-1');
        expect(await text(page, '#assignment')).toBe('Staff u-worker · Job A-1');
        expect(await text(page, '#pick-lines .item .qty')).toBe('12 units');
        expect(await text(page, '#issue-lines .item .qty')).toBe('6 units · still owed');
      }
      expect(await page.evaluate(SIDEWAYS)).toEqual([]);
      expect(await page.evaluate(smallTargets(44))).toEqual([]);
      expect(await auditPage(page, { minTarget: 56, expectLang: 'en' })).toEqual([]);
      await shot(page, `${shell.app}-360`);
      await expectConnectionAlwaysSeen(page, /not connected to a store computer/);

      await tamil(page);
      if (shell === WAREHOUSE) {
        expect(await text(page, '#assignment')).toBe('ஊழியர் u-worker · பணி A-1');
        expect(await page.evaluate('document.getElementById("who").firstChild.textContent.trim()')).toBe('ஸ்டாக் அறை வேலை');
        expect(await text(page, '#pick-lines .item .qty')).toBe('12 அலகுகள்');
      }
      expect(await page.evaluate(SIDEWAYS)).toEqual([]);
      expect(await page.evaluate(smallTargets(44))).toEqual([]);
      expect(await auditPage(page, { minTarget: 56, expectLang: 'ta' })).toEqual([]);
      await page.evaluate('document.querySelector("main").scrollTop = 0');
      await shot(page, `${shell.app}-360-ta`);
      await expectConnectionAlwaysSeen(page, /கடை கணினியுடன் இணைக்கப்படவில்லை/);
      expect(errors).toEqual([]);
    });
  }

  it('the queue till at 360px: each line\'s quantity in words, the amount to pay the largest figure, no sideways scroll, 44px targets', async () => {
    const srv = await serveShell('queue-pos', { posCatalogue: tillCatalogue(), queuePos: { laneId: 'device:hh-q1', boxLaneId: 'lane-1', payments: false } });
    stops.push(srv.stop);
    const context = await browser.newContext(PHONE);
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${srv.base}/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.queueSession !== undefined && typeof globalThis.sreIcon === "function"', undefined, { timeout: 15_000 });
    await page.keyboard.type(DAL); await page.keyboard.press('Enter');
    await page.waitForSelector('#lines .line');
    await page.keyboard.type(RICE); await page.keyboard.press('Enter');
    await page.waitForFunction('document.querySelectorAll("#lines .line").length === 2');
    expect(await page.$$eval('#lines .line .qty', (q) => q.map((x) => x.textContent))).toEqual(['Quantity 1', 'Quantity 1']);
    expect(await text(page, '#total')).toBe('₹215.00');
    expect(await page.evaluate(fontOf('#total')), 'the amount to pay is the largest figure').toBeGreaterThan(await page.evaluate(largestOtherText('#total')) as number);
    expect(await page.evaluate(SIDEWAYS)).toEqual([]);
    expect(await page.evaluate(smallTargets(44))).toEqual([]);
    await shot(page, 'queue-pos-360');
    await tamil(page);
    expect(await page.$$eval('#lines .line .qty', (q) => q.map((x) => x.textContent))).toEqual(['எண்ணிக்கை 1', 'எண்ணிக்கை 1']);
    expect(await page.evaluate(SIDEWAYS)).toEqual([]);
    await shot(page, 'queue-pos-360-ta');
  });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }]) {
    it(`the price kiosk at ${viewport.width}×${viewport.height}: name, the price the largest thing on screen, the note; a refusal on the amber card; Tamil; 64px; audit clean`, async () => {
      const srv = await serveShell('price-kiosk', { posCatalogue: tillCatalogue(new Date(Date.now() - 2 * 3_600_000).toISOString()) });
      stops.push(srv.stop);
      const context = await browser.newContext({ viewport });
      stops.push(() => context.close());
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${srv.base}/`, { waitUntil: 'load' });
      await page.waitForFunction('globalThis.kiosk !== undefined && typeof globalThis.sreIcon === "function"');
      expect(await page.isHidden('#card'), 'no empty card before a scan').toBe(true);
      expect(await auditPage(page, { minTarget: 64, expectLang: 'en' })).toEqual([]);

      await page.keyboard.type(RICE); await page.keyboard.press('Enter');
      expect(await text(page, '#answer')).toBe('Ponni rice 1kg: ₹70.00. Offers are applied at the till.');
      expect(await text(page, '#answer .sre-kiosk-name')).toBe('Ponni rice 1kg');
      expect(await text(page, '#answer .sre-figure-xl')).toBe('₹70.00');
      expect(await text(page, '#answer .sre-kiosk-note')).toBe('Offers are applied at the till.');
      expect(await page.getAttribute('#card', 'data-tone')).toBeNull();
      expect(await page.evaluate(fontOf('#answer .sre-figure-xl')), 'the price is the largest thing on the screen').toBeGreaterThan(await page.evaluate(largestOtherText('.sre-figure-xl')) as number);
      expect(await page.evaluate(SIDEWAYS)).toEqual([]);
      expect(await auditPage(page, { minTarget: 64, expectLang: 'en' })).toEqual([]);
      await shot(page, `price-kiosk-${viewport.width}-quoted`);

      // a weighed item's own code: the price per kg, the unit beside the figure
      await page.keyboard.type(BANANA); await page.keyboard.press('Enter');
      expect(await text(page, '#answer')).toBe('Banana (loose): ₹60.00 per kg. Offers are applied at the till.');
      expect(await text(page, '#answer .sre-figure-xl')).toBe('₹60.00 per kg');

      await tamil(page);
      expect(await text(page, '#answer .sre-kiosk-name')).toBe('Banana (loose)');
      expect(await text(page, '#answer .sre-figure-xl')).toBe('₹60.00 / kg');
      expect(await text(page, '#answer .sre-kiosk-note')).toBe('சலுகைகள் கட்டண மையத்தில் கணக்கிடப்படும்.');
      expect(await auditPage(page, { minTarget: 64, expectLang: 'ta' })).toEqual([]);
      await shot(page, `price-kiosk-${viewport.width}-quoted-ta`);

      // The language button has the focus: the scanner's closing Enter scans; it never flips the language back.
      await page.keyboard.type('123'); await page.keyboard.press('Enter');
      expect(await page.evaluate('document.documentElement.lang')).toBe('ta');
      expect(await page.getAttribute('#card', 'data-tone')).toBe('warn');
      expect(await text(page, '#answer')).toMatch(/பட்டியலில் இல்லை/);
      await page.click('#lang');
      expect(await text(page, '#answer')).toBe('That item is not in this shop\'s list. A colleague can check it.');
      expect(await page.locator('#answer .sre-figure-xl').count()).toBe(0);
      expect(await auditPage(page, { minTarget: 64, expectLang: 'en' })).toEqual([]);
      await shot(page, `price-kiosk-${viewport.width}-not-found`);
      expect(errors).toEqual([]);
    });
  }

  it('the self-checkout lane at 1024×768: quantities in words, the amount to pay the largest figure, Tamil screen-reader names, 56px, audit clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ui2-sco-'));
    stops.push(() => rm(dir, { recursive: true, force: true }));
    const snapshot = tillCatalogue() as unknown as CatalogueSnapshot;
    const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
    if (!result.ok || result.pack === undefined) throw new Error(result.detail);
    await writeSignedPack(dir, result.pack);
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({
        dir, key: KEY, people: [{ userId: 'u-attend', displayName: 'Attendant' }],
        pack: { version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [], rollout: { format: 'sre-rollout/1', branchId: 'store-1', switches: [{ key: 'self_checkout', branch: null, lanes: [{ laneId: 'lane-1', enabled: true, version: 1 }] }] } },
      }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/self-checkout/`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.selfCheckout !== undefined && typeof globalThis.sreIcon === "function"', undefined, { timeout: 15_000 });
    await page.click('#colleague');
    await page.fill('#staff', 'u-attend'); await page.fill('#pin', pinOf('u-attend'));
    await page.click('#open-lane');
    await page.waitForFunction('globalThis.selfCheckout.view().open');
    await page.click('#panel-done');
    await page.click('#total');
    await page.keyboard.type(RICE); await page.keyboard.press('Enter');
    await page.keyboard.type(DAL); await page.keyboard.press('Enter');
    await page.waitForFunction('document.querySelectorAll("#basket .line").length === 2');
    expect(await page.$$eval('#basket .line .what small', (q) => q.map((x) => x.textContent))).toEqual(['Quantity 1', 'Quantity 1']);
    expect(await text(page, '#total')).toBe('₹215.00');
    expect(await page.evaluate(fontOf('#total')), 'the amount to pay is the largest figure').toBeGreaterThan(await page.evaluate(largestOtherText('#total')) as number);
    expect(await page.getAttribute('#basket', 'aria-label')).toBe('Your items');
    expect(await page.evaluate(SIDEWAYS)).toEqual([]);
    expect(await auditPage(page, { minTarget: 56, expectLang: 'en' })).toEqual([]);
    await shot(page, 'self-checkout-1024-basket');
    await tamil(page);
    expect(await page.$$eval('#basket .line .what small', (q) => q.map((x) => x.textContent))).toEqual(['எண்ணிக்கை 1', 'எண்ணிக்கை 1']);
    expect(await page.getAttribute('#basket', 'aria-label')).toBe('உங்கள் பொருட்கள்');
    expect(await page.getAttribute('#panel', 'aria-label')).toBe('ஊழியர்');
    expect(await auditPage(page, { minTarget: 56, expectLang: 'ta' })).toEqual([]);
    await shot(page, 'self-checkout-1024-basket-ta');
    // The language button still has the focus: the scanner's closing Enter scans; it never presses that button again.
    await page.keyboard.type(DAL); await page.keyboard.press('Enter');
    await page.waitForFunction('globalThis.posSession.basket().filter((l) => !l.voided).reduce((n, l) => n + l.qty, 0) === 3');
    expect(await page.evaluate('document.documentElement.lang')).toBe('ta');
    expect(errors).toEqual([]);
  }, 60_000);
});
