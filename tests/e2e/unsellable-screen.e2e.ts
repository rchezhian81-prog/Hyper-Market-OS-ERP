import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';

/**
 * **The "Products nobody can sell" screen on the REAL box, in a real browser (SP-8c-ii · F08 · P-08 · M03-FR-03 · M10-FR-04 ·
 * G5c — ADR-0013 the E2E matrix).**
 *
 * Since G5c the box has excluded and counted every product the till cannot judge, and shipped a recalled one with its block;
 * the list reached the till payload and no screen showed it (recorded 30 Sep 2026). This drives the real box (`startEdge`
 * serving the real shell with the real payload) and proves, in Chromium:
 *
 *   • the screen lists every product the till refuses or was never given, grouped by WHY — recall FIRST — each with what to
 *     do, in English and then in Tamil, with the count against the products the till CAN sell;
 *   • the SAME box's till payload is built from the same judgement: exactly the catalogue gaps are missing from the till's
 *     catalogue (with the same words), the recalled one is shipped with its block;
 *   • a box with a clean catalogue says every product can be sold; a box with no catalogue says it cannot say.
 *
 * The browser binary is the environment's pre-installed Chromium; where none is present the suite SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['unsellable', 'screen', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

const PRODUCTS = [
  { productId: 'OK', name: 'Sells fine', categoryId: 'grocery', unitPriceMinor: 10_000, uom: 'ea', barcodes: ['1000000000017'], availableMinor: 5, taxBps: 500, status: 'active' },
  { productId: 'NOTAX', name: 'No tax rate', nameTa: 'வரி விகிதம் இல்லை', categoryId: 'grocery', unitPriceMinor: 10_000, uom: 'ea', barcodes: ['1000000000024'], availableMinor: 5, status: 'active' },
  { productId: 'UNIT', name: 'Odd unit', categoryId: 'grocery', unitPriceMinor: 10_000, uom: 'bundle', barcodes: [], availableMinor: 5, taxBps: 500, status: 'active' },
  { productId: 'RECALLED', name: 'Recalled tin', categoryId: 'grocery', unitPriceMinor: 10_000, uom: 'ea', barcodes: ['1000000000031'], availableMinor: 5, taxBps: 500, status: 'active', recallBlock: true },
  { productId: 'DRAFT', name: 'Not yet listed', categoryId: 'grocery', unitPriceMinor: 10_000, uom: 'ea', barcodes: [], availableMinor: 0, taxBps: 500, status: 'draft' },
];
const packWith = (products: unknown[] | undefined) => JSON.stringify({
  version: 1,
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1', warehouseId: 'S1-BACK' },
  ...(products === undefined ? {} : { products }),
  lossPreventionRules: [],
});

interface UnsellableWindow {
  readonly unsellableSession?: { view(lang: 'en' | 'ta'): { count: number; sellableCount: number | null; groups: { reason: string; rows: { productId: string }[] }[] } };
}

describe.skipIf(!HAVE_BROWSER)('products nobody can sell, on the real box in a real browser (SP-8c-ii · P-08)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function box(pack: string): Promise<{ edge: EdgeProcess; base: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-unsellable-e2e-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, pack, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, base: `http://127.0.0.1:${edge.screens!.port}` };
  }
  async function openOnBox(base: string): Promise<Page> {
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/unsellable`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.sreChrome !== undefined', undefined, { timeout: 15_000 });
    expect(errors).toEqual([]);
    return page;
  }
  /** The till's catalogue as the SAME box serves it: the global the till shell boots from. */
  async function tillCatalogue(base: string): Promise<{ products: { productId: string; recallBlock?: boolean }[]; excludedProducts?: { productId: string; why: string }[] }> {
    const html = await (await fetch(`${base}/pos`)).text();
    const match = /<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]!) as { products: { productId: string; recallBlock?: boolean }[]; excludedProducts?: { productId: string; why: string }[] };
  }

  it('lists every product the till cannot sell, recall first, each with what to do — in English and in Tamil — and the same box\'s till is built from the same list', async () => {
    const { base } = await box(packWith(PRODUCTS));
    const page = await openOnBox(base);
    expect(await page.isHidden('#sample')).toBe(true);
    await page.waitForSelector('#groups section.group');

    const groups = await page.$$eval('#groups section.group', (els) => els.map((el) => ({ reason: el.getAttribute('data-reason'), products: [...el.querySelectorAll('li.row')].map((li) => li.getAttribute('data-product-id')) })));
    expect(groups).toEqual([
      { reason: 'recall_block', products: ['RECALLED'] },
      { reason: 'no_tax_rate', products: ['NOTAX'] },
      { reason: 'unknown_uom', products: ['UNIT'] },
      { reason: 'not_on_sale', products: ['DRAFT'] },
    ]);
    expect((await page.textContent('#summary')) ?? '').toContain('4 products nobody can sell');
    expect((await page.textContent('#summary')) ?? '').toContain('1 products the till can sell');
    expect((await page.textContent('#groups section.group[data-reason="recall_block"]')) ?? '').toContain('Expiry & recalls');
    expect((await page.textContent('#groups section.group[data-reason="unknown_uom"]')) ?? '').toContain('unknown unit of measure "bundle"');
    // The state line reads as a state: an icon hidden from the reader and words for it.
    expect(await page.getAttribute('#state-icon', 'aria-hidden')).toBe('true');
    expect((await page.textContent('#state-text')) ?? '').toContain('refused at the till');

    // Tamil: the heading, the reasons and the product's Tamil name where it has one.
    await page.click('#lang');
    expect((await page.textContent('#title')) ?? '').toBe('யாரும் விற்க முடியாத பொருட்கள்');
    expect((await page.textContent('#groups section.group[data-reason="no_tax_rate"] .name')) ?? '').toContain('வரி விகிதம் இல்லை');
    expect((await page.textContent('#groups section.group[data-reason="recall_block"]')) ?? '').toContain('திரும்பப்பெறலில்');

    // ONE truth: the till of the SAME box was given exactly the products this screen does not list as a catalogue gap.
    const till = await tillCatalogue(base);
    expect(till.products.map((p) => p.productId).sort()).toEqual(['DRAFT', 'OK', 'RECALLED']);
    expect(till.products.find((p) => p.productId === 'RECALLED')?.recallBlock).toBe(true);
    expect(till.excludedProducts?.map((e) => e.productId).sort()).toEqual(['NOTAX', 'UNIT']);
    expect(till.excludedProducts?.find((e) => e.productId === 'UNIT')?.why).toBe('unknown unit of measure "bundle" on the catalogue');
  });

  it('a clean catalogue says every product can be sold; a box with no catalogue says it cannot say — and shows the sample stand-in, never "all clear"', async () => {
    const clean = await box(packWith([PRODUCTS[0]!]));
    const cleanPage = await openOnBox(clean.base);
    expect((await cleanPage.textContent('#state-text')) ?? '').toContain('Every product in the catalogue can be sold');
    expect(await cleanPage.$$('#groups section.group')).toHaveLength(0);
    expect(await cleanPage.evaluate(() => (globalThis as unknown as UnsellableWindow).unsellableSession!.view('en').sellableCount)).toBe(1);

    const none = await box(packWith(undefined));
    const nonePage = await openOnBox(none.base);
    expect(await nonePage.isVisible('#sample')).toBe(true);
    expect(await nonePage.evaluate(() => (globalThis as unknown as UnsellableWindow).unsellableSession === undefined)).toBe(true);
  });
});
