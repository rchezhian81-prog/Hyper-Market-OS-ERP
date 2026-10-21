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
import { splitInclusive } from '../../packages/pricing/src/pricing';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { prepareTillBox, signInThroughScreen, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **OB-173 "A" (owner, 17 Oct 2026, "Never discount bags") in a real browser against a REAL store computer.**
 *
 * The box holds head office's SIGNED catalogue pack with a basket-wide 10% offer (it names no product, so it reaches every
 * line it may). A real Chromium drives the real till shell:
 *
 *   • rice ×2, ghee and a ₹5 carry bag ring to ₹431.00 on screen: 10% off the ₹473.33 of goods (₹47.33), nothing off the bag;
 *   • paid in cash, the sale lands on the box's disk with the bag at ₹5.00, the discount spread over the goods to the paisa,
 *     the lines adding up to the total and the GST pulled from what each line actually charged;
 *   • a sale posted straight to the box with the bag charged ₹4.50 (an old till that spread the offer onto it) is refused
 *     before the disk, in the cashier's words.
 *
 * Screenshots for the owner are written only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 * Synthetic data only.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['ob173', 'till', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const BAG = '8900000000404';
const RICE = '8900000000707';
const GHEE = '8900000000808';

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 5, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 500, status: 'active' },
      { productId: 'P-GHEE', sku: 'GHEE-500', name: 'Ghee 500ml', baseUom: 'ea', unitPriceMinor: 333_33, taxBps: 1200, status: 'active' },
      { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 1800, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
    ],
    barcodes: [{ code: BAG, productId: 'P-BAG', kind: 'standard' }, { code: RICE, productId: 'P-RICE', kind: 'standard' }, { code: GHEE, productId: 'P-GHEE', kind: 'standard' }],
    promotions: [{ id: 'PR-TEN', kind: 'percent_off', status: 'active', startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', percentBps: 1_000 }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): { productId: string }[]; payableMinor(): number; refusedOffers(): { offerId: string }[] } }
type Line = { productId: string; quantityMinor: number; unitPriceMinor: number; lineTotalMinor: number; taxRateBps: number };

describe.skipIf(!HAVE_BROWSER)('OB-173: the served till never discounts a carry bag — a basket-wide 10% offer leaves the bag at ₹5', () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob173-till-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    // No cloud is configured: the till and its store computer price and judge the bag on their own (P-01).
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({ dir, key: KEY, pack: { version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [] } }),
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

  it('rice ×2 + ghee + bag under 10% off: ₹431.00 on screen; the disk has the bag at ₹5.00, the discount spread exactly and the GST right', async () => {
    const { edge, page } = await till();
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.refusedOffers())).toEqual([]);
    for (const code of [RICE, RICE, GHEE, BAG]) await scan(page, code);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 4);
    expect(await page.textContent('#total')).toBe('₹431.00');
    if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'till-bag-never-discounted.png') }); }
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    const saved = JSON.parse(first.record) as { lines: Line[]; total: number; netMinor: number; taxMinor: number };
    const sum = (id: string): number => saved.lines.filter((l) => l.productId === id).reduce((n, l) => n + l.lineTotalMinor, 0);
    expect(saved.lines.find((l) => l.productId === 'P-BAG')).toMatchObject({ unitPriceMinor: 5_00, lineTotalMinor: 5_00 });
    expect(sum('P-RICE')).toBe(126_00);
    expect(sum('P-GHEE')).toBe(300_00);
    expect(saved.total).toBe(431_00);
    expect(saved.lines.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(saved.total);
    const inside = saved.lines.map((l) => splitInclusive(money(l.lineTotalMinor, 'INR'), rate(l.taxRateBps)));
    expect(saved.taxMinor).toBe(inside.reduce((n, s) => n + s.tax.minor, 0));
    expect(saved.netMinor + saved.taxMinor).toBe(saved.total);
  });

  it('a sale posted straight to the box with the bag charged ₹4.50 is refused before the disk', async () => {
    const { edge } = await till();
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({
        laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: day(0), committedAt: new Date().toISOString(), id: 'S-OLD', number: 'R-OLD', total: 67_50,
        lines: [
          { productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 63_00, taxRateBps: 500 },
          { productId: 'P-BAG', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_00, lineTotalMinor: 4_50, taxRateBps: 1800 },
        ],
        tenders: [{ kind: 'cash', amount: { minor: 67_50, currency: 'INR' }, status: 'settled' }],
      }),
    });
    const box = await res.json() as Record<string, unknown>;
    expect(box).toMatchObject({ committed: false, refusedBecause: 'carry_bag_discounted' });
    expect(String(box['laneMessage'])).toMatch(/always charged its full price/);
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });
});
