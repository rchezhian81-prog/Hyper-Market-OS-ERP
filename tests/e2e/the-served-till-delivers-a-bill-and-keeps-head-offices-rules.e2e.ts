import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { readLog } from '../../edge/store-edge/src/file-log';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **OB-288 till side in a real browser, against a REAL store computer with NO head office at all (hard rule #1).**
 *
 * The box holds head office's SIGNED catalogue — a festival combo with its bundle definition (OB-306), a cigarette pack
 * and an offer that names it (B15), rice, and the delivery-fee product — and a store setup naming the shop's state (TN,
 * OB-348) and the delivery-fee product (OB-299). A real Chromium drives the real till shell:
 *
 *   • OB-299 — More → "Deliver this bill" adds the ₹30 fee line once; the total says "For delivery" beside the truck mark,
 *     in English and in Tamil; the customer pays the whole bill; the bill lands on the box's disk marked for delivery;
 *   • the box is stopped and started on the same disk (a COLD RESTART): the bill is still there, and the till rings a combo
 *     whose record carries its components from the signed pack (OB-306);
 *   • B15 — the offer naming tobacco is not applied: the cigarettes are charged their price;
 *   • a box whose store setup names no fee product says "not set" in words and adds nothing.
 *
 * Screenshots for the owner are written only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['till', 'side', 'delivery', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const ean = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const RICE = ean('890100000102');
const COMBO = ean('890100000201');
const CIG = ean('890100000301');
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 7, builtAt: new Date().toISOString(),
    products: [
      { productId: 'p-rice', sku: 'RICE', name: 'Ponni rice 5kg', baseUom: 'ea', unitPriceMinor: 400_00, taxBps: 0, hsnCode: '1006', status: 'active' },
      { productId: 'p-dal', sku: 'DAL', name: 'Toor dal 1kg', baseUom: 'ea', unitPriceMinor: 120_00, taxBps: 500, hsnCode: '0713', status: 'active' },
      { productId: 'p-oil', sku: 'OIL', name: 'Groundnut oil 1L', baseUom: 'ea', unitPriceMinor: 200_00, taxBps: 500, hsnCode: '1508', status: 'active' },
      { productId: 'p-combo', sku: 'COMBO', name: 'Festival combo', baseUom: 'ea', unitPriceMinor: 450_00, taxBps: 1200, hsnCode: '2106', status: 'active' },
      { productId: 'p-cig', sku: 'CIG', name: 'Cigarettes 10s (demo)', baseUom: 'ea', unitPriceMinor: 180_00, taxBps: 2800, hsnCode: '2402', status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 1, minimumAge: 18 } },
      { productId: 'p-del', sku: 'DELIVERY', name: 'Home delivery', baseUom: 'ea', unitPriceMinor: 30_00, taxBps: 1800, hsnCode: '996813', status: 'active' },
    ],
    barcodes: [{ code: RICE, productId: 'p-rice', kind: 'standard' }, { code: COMBO, productId: 'p-combo', kind: 'standard' }, { code: CIG, productId: 'p-cig', kind: 'standard' }],
    promotions: [{ id: 'cig-10', kind: 'percent_off', percentBps: 1000, productIds: ['p-cig'], startsAt: day(-1), endsAt: day(30), status: 'active' }],
    bundles: [{ bundleProductId: 'p-combo', version: 3, reason: 'festival pack', definedBy: 'u-cat', definedAt: day(-2), components: [{ productId: 'p-dal', quantityMinor: 2 }, { productId: 'p-oil', quantityMinor: 1 }] }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): { productId: string; voided: boolean }[]; payableMinor(): number } }
interface Doc { readonly document: { querySelector(selector: string): { hidden: boolean } | null } }

describe.skipIf(!HAVE_BROWSER)('the served till delivers a bill and keeps head office\'s catalogue rules (OB-299 · OB-306 · B15)', () => {
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

  const boxOn = async (dir: string, feeProduct: boolean): Promise<EdgeProcess> => {
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({
        dir, key: KEY,
        pack: { version: 1, policies: { tradingDayCutoff: '00:00', storeId: 'store-1', shopState: 'TN', ...(feeProduct ? { tillDeliveryFeeProductId: 'p-del' } : {}) }, lossPreventionRules: [] },
      }),
    }, () => {}))!;
    return edge;
  };
  const open = async (edge: EdgeProcess): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return page;
  };
  const scan = async (page: Page, code: string): Promise<void> => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const lines = (page: Page): Promise<string[]> => page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().filter((l) => !l.voided).map((l) => l.productId));
  const panelShown = (page: Page): Promise<unknown> => page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#refusal') as { hidden: boolean }).hidden);
  const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS === undefined) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const payCash = async (page: Page): Promise<void> => {
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
  };
  const more = async (page: Page, option: string): Promise<void> => {
    await page.click('#more');
    await page.waitForSelector('#pay-kinds button');
    await page.click(`#pay-kinds button:has-text("${option}")`);
  };
  const disk = async (edge: EdgeProcess): Promise<Record<string, unknown>[]> =>
    (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

  it('OB-299: "Deliver this bill" adds the fee once, says "For delivery" in both languages, is paid in full and lands marked; across a cold restart a combo carries its components', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-delivery-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = await boxOn(dir, true);
    let stopped = false;
    stops.push(async () => { if (!stopped) await edge.stop(); });
    const page = await open(edge);
    await scan(page, RICE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await more(page, 'Deliver this bill');
    await panelShown(page);
    expect(await page.textContent('#refusal-text')).toBe('This bill will be delivered. The delivery fee ₹30.00 is on the bill. The customer pays the whole bill now.');
    expect(await auditPage(page, { expectLang: 'en' }), 'the delivery panel').toEqual([]);
    await page.click('#refusal-ok');
    expect(await lines(page)).toEqual(['p-rice', 'p-del']);
    expect(await page.textContent('#total-label')).toBe('Total to pay · For delivery');
    expect(await page.locator('#total-label svg').count()).toBe(1);
    expect(await page.textContent('#total')).toBe('₹430.00');
    await shot(page, 'till-deliver-this-bill');
    // Asked again: the fee is not added twice (the menu offers to take delivery off instead).
    await page.click('#more');
    await page.waitForSelector('#pay-kinds button');
    expect(await page.locator('#pay-kinds button:has-text("Take delivery off this bill")').count()).toBe(1);
    await page.click('#pay-cancel');
    // In Tamil, the same words.
    await page.click('#lang');
    await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string } | null } }).document.querySelector('#total-label')?.textContent?.includes('டெலிவரிக்கு') === true);
    await page.click('#lang');
    await payCash(page);
    await expect.poll(async () => (await disk(edge)).length, { timeout: 10_000 }).toBe(1);
    expect((await disk(edge))[0]!['delivery']).toEqual({ requested: true, feeProductId: 'p-del', feeMinor: 30_00 });

    // A COLD RESTART of the store computer, no head office anywhere: the bill is still on its disk.
    stopped = true;
    await edge.stop();
    const back = await boxOn(dir, true);
    stops.push(() => back.stop());
    expect((await disk(back))[0]!['delivery']).toEqual({ requested: true, feeProductId: 'p-del', feeMinor: 30_00 });
    const again = await open(back);
    await scan(again, COMBO);
    await again.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    expect(await again.textContent('#total-label')).toBe('Total to pay');
    await payCash(again);
    await expect.poll(async () => (await disk(back)).length, { timeout: 10_000 }).toBe(2);
    expect(((await disk(back))[1]!['lines'] as Record<string, unknown>[])[0]!['bundle']).toEqual({
      bundleProductId: 'p-combo', version: 3, components: [{ productId: 'p-dal', quantityMinor: 2, uom: 'ea' }, { productId: 'p-oil', quantityMinor: 1, uom: 'ea' }],
    });
  }, 90_000);

  it('B15: the offer that names tobacco is not applied — the cigarettes are charged their price', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-tobacco-offer-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = await boxOn(dir, true);
    stops.push(() => edge.stop());
    const page = await open(edge);
    await scan(page, CIG);
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#pay') as { hidden: boolean }).hidden);
    await page.click('#pay-kinds button:first-child'); // Yes — 18 or over, ID checked
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    expect(await page.textContent('#total')).toBe('₹180.00');
  }, 60_000);

  it('OB-299: with no fee product in the store setup, "Deliver this bill" says the owner has not set it, and adds nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-delivery-unset-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = await boxOn(dir, false);
    stops.push(() => edge.stop());
    const page = await open(edge);
    await scan(page, RICE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await more(page, 'Deliver this bill');
    await panelShown(page);
    expect(await page.textContent('#refusal-text')).toBe('Delivery from the till is not set up: the owner has not set the delivery fee. Take it as a normal sale, or ask the manager.');
    await shot(page, 'till-delivery-not-set');
    await page.click('#refusal-ok');
    expect(await lines(page)).toEqual(['p-rice']);
  }, 60_000);
});
