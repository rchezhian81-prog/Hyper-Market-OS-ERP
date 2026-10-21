import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';

/**
 * **The served till at a 1366 × 768 counter screen, against a REAL store computer holding head office's SIGNED pack
 * (roadmap v2.1 B13 signed in R3 · P-08 · OB-31 · hard rule #1).**
 *
 *   • WEIGHED LINES READ IN THEIR UNIT — 1234 g of loose bananas (a kg product) reads "1.234 kg", 500 g of loose cardamom
 *     (a g product) reads "500 g", a gold ring reads "1". Look only: the line keeps its integer and its price.
 *   • B13 "THE HUID SOLD IS PRINTED ON THE BILL" — after the sale the till shows the bill exactly as it prints, made by
 *     `@sre/receipt`: the gold ring's line has "HUID: AB12CD" under it. In Tamil too: a second ring, sold with the
 *     screen in Tamil, prints "HUID: EF34GH".
 *   • P-08 THE UNSENT COUNT — while the box answers, "Unsent" is the BOX's number (2 after two sales). When the box stops
 *     answering, it reads "Unsent: not known" ("தெரியவில்லை" in Tamil) in amber — never this till's own count, never 0 —
 *     and tapping it says why.
 *
 * Screenshots go to SRE_SHOTS when set. Skips where no browser binary is present. Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['bill', 'huid', 'unsent', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const BANANA_1234G = '2000123012340'; // weight-embedded: item 000123, 1234 g
const CARDAMOM_500G = '2000456005000'; // weight-embedded: item 000456, 500 g
const RING_A = '8900000000901';
const RING_B = '8900000000918';

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 6, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 80_00, taxBps: 0, status: 'active' },
      { productId: 'P-CARD', sku: '000456', name: 'Cardamom (loose)', baseUom: 'g', unitPriceMinor: 4_00, taxBps: 500, status: 'active' },
      { productId: 'P-RING-A', sku: 'RING-A', name: 'Gold ring 22K', baseUom: 'ea', unitPriceMinor: 45_000_00, taxBps: 300, status: 'active', regulatedFlags: { gold: true, huid: 'AB12CD' } },
      { productId: 'P-RING-B', sku: 'RING-B', name: 'Gold ring 18K', baseUom: 'ea', unitPriceMinor: 32_000_00, taxBps: 300, status: 'active', regulatedFlags: { gold: true, huid: 'EF34GH' } },
    ],
    barcodes: [{ code: RING_A, productId: 'P-RING-A', kind: 'standard' }, { code: RING_B, productId: 'P-RING-B', kind: 'standard' }],
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow {
  laneWriteBase?: string;
  readonly posSession?: { hasCatalogue(): boolean; basket(): { productId: string; qty: number }[] };
  readonly posBadge?: { refresh(): Promise<void> };
}

describe.skipIf(!HAVE_BROWSER)('the served till prints the HUID on the bill, reads weights in their unit, and says when the unsent count is not known', () => {
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

  async function till(): Promise<{ edge: EdgeProcess; page: Page }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-bill-huid-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({
        dir, key: KEY,
        pack: {
          version: 1, policies: { tradingDayCutoff: '00:00', storeId: 'store-1' }, lossPreventionRules: [],
          weighingScales: [{ assetId: 'SCALE-L1', laneIds: ['lane-1'], approvalNo: 'LM/TN/APP/0042', capacityGrams: 30_000, lastStampedOn: day(-30), reverificationDueOn: day(300) }],
        },
      }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue() && w.posBadge !== undefined; }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { edge, page };
  }
  const scan = async (page: Page, code: string, lines: number): Promise<void> => {
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => (globalThis as unknown as PosWindow).posSession!.basket().length === n, lines);
  };
  const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS === undefined) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  /** Pay exact cash, the way a cashier does; return the bill the till then shows. */
  const payCash = async (page: Page): Promise<string> => {
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await page.waitForSelector('#refusal:not([hidden]) #refusal-receipt:not([hidden])', { timeout: 10_000 });
    return (await page.textContent('#refusal-receipt')) ?? '';
  };
  const refresh = (page: Page): Promise<void> => page.evaluate(() => (globalThis as unknown as PosWindow).posBadge!.refresh());

  it('weighed lines read "1.234 kg" and "500 g"; the gold ring\'s bill prints "HUID: AB12CD" (and in Tamil "HUID: EF34GH"); Unsent is the box\'s number, or "not known" in amber', async () => {
    const { edge, page } = await till();

    // ── Weighed lines in their unit (look only) ──
    await scan(page, BANANA_1234G, 1);
    await scan(page, CARDAMOM_500G, 2);
    await scan(page, RING_A, 3);
    expect(await page.$$eval('#lines td.qty', (cells) => cells.map((c) => c.textContent))).toEqual(['1.234 kg', '500 g', '1']);
    // The stored integers are untouched: grams for the kg line, grams for the g line, one ring.
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().map((l) => l.qty))).toEqual([1234, 500, 1]);
    expect(await page.textContent('#total')).toBe('₹47,098.72'); // ₹98.72 + ₹2,000 + ₹45,000 — no calculation changed
    // One line each: the unit stays beside its number.
    const rows = await page.$$eval('#lines td.qty', (cells) => cells.map((c) => {
      const range = (globalThis as unknown as { document: { createRange(): { selectNodeContents(n: unknown): void; getClientRects(): { length: number } } } }).document.createRange();
      range.selectNodeContents(c);
      return range.getClientRects().length;
    }));
    expect(rows).toEqual([1, 1, 1]);
    await shot(page, 'gap-till-weighed-lines-in-their-unit');

    // ── B13: the bill as it prints, through the receipt renderer ──
    const bill = await payCash(page);
    expect(bill).toMatch(/^Gold ring 22K\n.*\n {2}HUID: AB12CD$/m);
    expect(bill).toMatch(/^ {2}1\.234 kg x 80\.00 +98\.72$/m);
    expect(bill).toMatch(/^ {2}500 g x 4\.00 +2000\.00$/m);
    expect(bill).toMatch(/^TOTAL +47098\.72$/m);
    expect(await page.getAttribute('#refusal-receipt', 'aria-label')).toBe('The bill');
    // The banner's own words are as before: the bill number and the gold piece sold.
    expect(await page.textContent('#refusal-text')).toContain('Gold ring 22K — HUID AB12CD');
    // The OK button is still on screen at a 768-high counter screen, and the slip does not run off it.
    const ok = await page.$eval('#refusal-ok', (b) => (b as unknown as { getBoundingClientRect(): { bottom: number } }).getBoundingClientRect().bottom);
    expect(ok).toBeLessThanOrEqual(768);
    const slipBottom = await page.$eval('#refusal-receipt', (b) => (b as unknown as { getBoundingClientRect(): { bottom: number } }).getBoundingClientRect().bottom);
    expect(slipBottom).toBeLessThanOrEqual(768);
    await shot(page, 'gap-till-bill-prints-the-huid');
    await page.click('#refusal-ok');
    // A message that is not a sale shows no bill.
    await page.click('#qty');
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await page.isHidden('#refusal-receipt')).toBe(true);
    await page.click('#refusal-ok');

    // ── The same in Tamil ──
    await page.click('#lang');
    await scan(page, RING_B, 1);
    const tamilBill = await payCash(page);
    expect(tamilBill).toMatch(/^Gold ring 18K\n.*\n {2}HUID: EF34GH$/m);
    expect(await page.getAttribute('#refusal-receipt', 'aria-label')).toBe('பில்');
    await shot(page, 'gap-till-bill-prints-the-huid-tamil');
    await page.click('#refusal-ok');

    // ── P-08: the BOX's count while it answers … ──
    await refresh(page);
    expect(await page.textContent('#unsent')).toBe('அனுப்பப்படாதவை: 2');
    expect(await page.getAttribute('#unsent', 'data-unknown')).toBeNull();
    await page.click('#lang');
    expect(await page.textContent('#unsent')).toBe('Unsent: 2');
    expect(await page.getAttribute('#unsent', 'data-waiting')).toBe('');
    await shot(page, 'gap-till-unsent-known');

    // … and "not known", in amber, when it stops answering — never this till's own count, never 0.
    await page.evaluate(() => { (globalThis as unknown as PosWindow).laneWriteBase = 'http://127.0.0.1:1'; });
    await refresh(page);
    expect(await page.textContent('#unsent')).toBe('Unsent: not known');
    expect(await page.getAttribute('#unsent', 'data-unknown')).toBe('');
    expect(await page.getAttribute('#unsent', 'data-waiting')).toBeNull();
    const tone = await page.$eval('#unsent-count', (c) => {
      const cs = (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string; color: string } }).getComputedStyle(c);
      return [cs.backgroundColor, cs.color];
    });
    expect(tone).toEqual(['rgb(246, 231, 200)', 'rgb(90, 62, 12)']); // --warn-surface / --on-warn-surface: the amber of "not known"
    await shot(page, 'gap-till-unsent-not-known');
    await page.click('#unsent');
    await page.waitForSelector('#refusal:not([hidden])');
    expect(await page.textContent('#refusal-title')).toBe('Unsent: not known');
    expect(await page.textContent('#refusal-text')).toMatch(/does not know\. It shows "not known" — never 0 — until the box answers/);
    await page.click('#refusal-ok');
    await page.click('#lang');
    expect(await page.textContent('#unsent')).toBe('அனுப்பப்படாதவை: தெரியவில்லை');
    await shot(page, 'gap-till-unsent-not-known-tamil');

    // The box answers again: the real number comes back.
    await page.evaluate((base) => { (globalThis as unknown as PosWindow).laneWriteBase = base; }, `http://127.0.0.1:${edge.lane!.port}`);
    await refresh(page);
    expect(await page.textContent('#unsent')).toBe('அனுப்பப்படாதவை: 2');
  });
});
