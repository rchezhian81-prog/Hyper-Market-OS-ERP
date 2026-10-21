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
import { prepareTillBox, signInThroughScreen, signInAtLane, operatorHeader } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **R2 lane 1 — the served till enforces the legal gates, in a real browser, against a REAL store computer (roadmap v2.1
 * B5 · B6 · B14 · B19 · hard rule #1).**
 *
 * The box holds head office's SIGNED catalogue pack (restored from its own disk — no cloud) whose products carry the
 * tobacco pack size and the carry-bag / plastic facts, and a store setup whose scale register names this lane's scale.
 * A real Chromium drives the real till shell:
 *
 *   • B5 — a weight-embedded barcode for 333 g of loose bananas at ₹99.99/kg rings ₹33.29 (3,329.667 paise, never rounded
 *     up), and the sale lands on the box's disk at that amount, naming the scale and its stamp;
 *   • B6 — with the lane's scale stamp lapsed, the same scan is refused with the reason named on screen; ordinary goods
 *     still sell; and a weighed sale posted straight to the box's socket (a page that skipped the gate) is refused before
 *     the disk;
 *   • B14 — a loose cigarette is refused; a whole pack asks "18 or over?" and only then joins the bill;
 *   • B19 — a banned plastic straw and a 50-micron bag are refused by name; a 120-micron bag rings as its own ₹5 line.
 *
 * Screenshots for the owner are written only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['legal', 'gates', 'till', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const BANANA = '2000123003330'; // weight-embedded: item 000123, 333 g
const CIG_PACK = '8900000000110';
const CIG_STICK = '8900000000127';
const STRAW = '8900000000202';
const THIN_BAG = '8900000000303';
const GOOD_BAG = '8900000000404';
const RICE = '8900000000707';

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 5, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' },
      { productId: 'P-CIG', sku: 'CIG-PACK', name: 'Cigarettes 10s (demo)', baseUom: 'ea', unitPriceMinor: 180_00, taxBps: 2800, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 1, minimumAge: 18 } },
      { productId: 'P-STICK', sku: 'CIG-STICK', name: 'Cigarette stick (demo)', baseUom: 'ea', unitPriceMinor: 18_00, taxBps: 2800, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 10, minimumAge: 18 } },
      { productId: 'P-STRAW', sku: 'STRAW', name: 'Plastic straws (demo)', baseUom: 'ea', unitPriceMinor: 20_00, taxBps: 1800, status: 'active', regulatedFlags: { bannedSingleUsePlastic: true } },
      { productId: 'P-THIN', sku: 'BAG-50', name: 'Carry bag 50 micron (demo)', baseUom: 'ea', unitPriceMinor: 3_00, taxBps: 1800, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 50 } },
      { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 0, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
      { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
    ],
    barcodes: [
      { code: CIG_PACK, productId: 'P-CIG', kind: 'standard' }, { code: CIG_STICK, productId: 'P-STICK', kind: 'standard' },
      { code: STRAW, productId: 'P-STRAW', kind: 'standard' }, { code: THIN_BAG, productId: 'P-THIN', kind: 'standard' },
      { code: GOOD_BAG, productId: 'P-BAG', kind: 'standard' }, { code: RICE, productId: 'P-RICE', kind: 'standard' },
    ],
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): { productId: string }[]; payableMinor(): number } }
interface Doc { readonly document: { querySelector(selector: string): { hidden: boolean } | null } }

describe.skipIf(!HAVE_BROWSER)('the served till enforces the legal gates (B5 · B6 · B14 · B19)', () => {
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

  async function till(stampValidTo: string): Promise<{ edge: EdgeProcess; page: Page }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-legal-gates-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({
        dir, key: KEY,
        pack: {
          version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [],
          // The store setup's scale register (B6): this lane's scale and the last day its stamp is valid.
          weighingScales: [{ assetId: 'SCALE-L1', laneIds: ['lane-1'], approvalNo: 'LM/TN/APP/0042', capacityGrams: 30_000, lastStampedOn: day(-300), reverificationDueOn: stampValidTo }],
        },
      }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return { edge, page };
  }
  const scan = async (page: Page, code: string): Promise<void> => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const lines = (page: Page): Promise<string[]> => page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.basket().map((l) => l.productId));
  const refusalShown = (page: Page): Promise<unknown> => page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#refusal') as { hidden: boolean }).hidden);
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

  it('B5 · B6: on a current stamp, 333 g at ₹99.99/kg rings ₹33.29 and lands on the disk at that amount, naming the scale', async () => {
    const { edge, page } = await till(day(120));
    await scan(page, BANANA);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    expect(await page.textContent('#total')).toBe('₹33.29');
    await payCash(page);
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    const saved = JSON.parse(first.record) as { total: number; lines: { productId: string; quantityMinor: number; unitPriceMinor: number; lineTotalMinor: number; scaleCheck?: { scales: { assetId: string; reverificationDueOn: string }[] } }[] };
    expect(saved.total).toBe(33_29);
    expect(saved.lines[0]).toMatchObject({ productId: 'P-BAN', quantityMinor: 333, unitPriceMinor: 99_99, lineTotalMinor: 33_29 });
    expect(saved.lines[0]!.scaleCheck?.scales).toEqual([{ assetId: 'SCALE-L1', reverificationDueOn: day(120) }]);
  });

  it('B6: a lapsed stamp refuses the weighed line on screen, by name; rice still sells; the box refuses a weighed record before its disk', async () => {
    const { edge, page } = await till(day(-2));
    await scan(page, BANANA);
    await refusalShown(page);
    expect(await page.textContent('#refusal-title')).toBe('Cannot be sold');
    expect(await page.textContent('#refusal-text')).toBe(`The weighing scale on this lane (SCALE-L1) had its Legal Metrology verification run out on ${day(-2)}. Nothing can be sold by weight on this lane until it is re-verified — use another lane and tell the manager.`);
    expect(await auditPage(page, { expectLang: 'en' }), 'the refusal panel').toEqual([]);
    await shot(page, 'till-scale-lapsed');
    expect(await lines(page)).toEqual([]);
    await page.click('#refusal-ok');
    await scan(page, RICE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);

    // A page that skipped the gate posts a weighed sale straight to the box: refused before the disk, in words.
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ id: 'S-SKIP', number: 'R-SKIP', laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: day(0), committedAt: new Date().toISOString(), lines: [{ productId: 'P-BAN', quantityMinor: 500, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: 49_99 }], tenders: [{ kind: 'cash', amount: { minor: 49_99, currency: 'INR' }, status: 'settled' }], total: 49_99 }),
    });
    const body = await res.json() as { committed: boolean; refusedBecause?: string; laneMessage?: string };
    expect(body).toMatchObject({ committed: false, refusedBecause: 'weighed_on_lapsed_scale' });
    expect(body.laneMessage).toMatch(/^Do not take payment\. The weighing scale on this lane \(SCALE-L1\)/);
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });

  it('B14: a loose cigarette is refused; a whole pack asks "18 or over?" and joins the bill only on Yes', async () => {
    const { page } = await till(day(120));
    await scan(page, CIG_STICK);
    await refusalShown(page);
    expect(await page.textContent('#refusal-title')).toBe('Cannot be sold');
    expect(await page.textContent('#refusal-text')).toBe('Cigarette stick (demo) is tobacco and is sold only in whole packs (at least 10). Loose cigarettes cannot be sold — this line is 1.');
    await shot(page, 'till-loose-cigarette');
    await page.click('#refusal-ok');
    expect(await lines(page)).toEqual([]);

    await scan(page, CIG_PACK);
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#pay') as { hidden: boolean }).hidden);
    expect(await page.textContent('#pay-title')).toBe('Cigarettes 10s (demo) is age restricted. Check the customer\'s identification. Is the customer 18 or over?');
    expect(await lines(page)).toEqual([]);
    await page.click('#pay-kinds button:first-child'); // Yes — ID checked
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    expect(await lines(page)).toEqual(['P-CIG']);
  });

  it('B19: a banned straw and a 50-micron bag are refused by name; a 120-micron bag rings as its own ₹5 line and lands on the disk', async () => {
    const { edge, page } = await till(day(120));
    await scan(page, STRAW);
    await refusalShown(page);
    expect(await page.textContent('#refusal-text')).toBe('Plastic straws (demo) is a banned single-use plastic item. It cannot be sold — keep it off the bill and tell the manager.');
    await shot(page, 'till-banned-plastic');
    await page.click('#refusal-ok');
    await scan(page, THIN_BAG);
    await refusalShown(page);
    expect(await page.textContent('#refusal-text')).toBe('Carry bag 50 micron (demo) is a 50-micron plastic carry bag, thinner than the 120-micron minimum. It cannot be sold — offer a 120-micron, cloth or paper bag.');
    await page.click('#refusal-ok');
    expect(await lines(page)).toEqual([]);

    await scan(page, RICE);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 1);
    await scan(page, GOOD_BAG);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 2);
    expect(await lines(page)).toEqual(['P-RICE', 'P-BAG']);
    expect(await page.textContent('#total')).toBe('₹75.00');
    await payCash(page);
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    const saved = JSON.parse(first.record) as { lines: { productId: string; unitPriceMinor: number; lineTotalMinor: number; carryBag?: unknown }[] };
    expect(saved.lines.find((l) => l.productId === 'P-BAG')).toMatchObject({ unitPriceMinor: 5_00, lineTotalMinor: 5_00, carryBag: { material: 'plastic', thicknessMicrons: 120 } });
  });
});
