import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
 * **Follow-up F7 in a real browser against a REAL store computer (verifier r2final NEW-2, L1 and NEW-3).**
 *
 * The box holds head office's SIGNED pack with a basket-wide ₹100-off offer. A real Chromium drives the real till shell:
 *
 *   • NEW-2 — the verifier's basket: 333 g of banana at ₹99.99/kg (₹33.29 charged), rice ₹70 and a ₹5 carry bag, all at
 *     5% GST. The ₹100 is taken from the ₹103.29 of goods by what each line ACTUALLY charges: the screen shows ₹8.29, and
 *     the disk has the banana at ₹1.06, the rice at ₹2.23 and the bag at its full ₹5 — no line and no GST below zero, the
 *     lines adding to the total and net + GST equal to the total (the old till recorded the banana at −₹25.53);
 *   • L1 — a carry bag posted straight to the box as "kg" and charged a paisa is refused before the disk;
 *   • NEW-3 — a card number sent as a JSON NUMBER (and nested in another field) is removed before the box's disk.
 *
 * Screenshots for the owner are written only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 * Synthetic data only (the card number is the public test number card networks publish).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['f7', 'till', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const PAN = ['4111', '1111', '1111', '1111'].join('');
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const BANANA_333G = '2000123003330';
const RICE = '8900000000707';
const BAG = '8900000000404';

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 5, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 500, status: 'active' },
      { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 500, status: 'active' },
      { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 500, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
    ],
    barcodes: [{ code: RICE, productId: 'P-RICE', kind: 'standard' }, { code: BAG, productId: 'P-BAG', kind: 'standard' }],
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
    promotions: [{ id: 'PR-100', kind: 'amount_off', status: 'active', startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', amountOffMinor: 100_00 }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): { productId: string }[]; payableMinor(): number } }
type Line = { productId: string; quantityMinor: number; uom: string; unitPriceMinor: number; lineTotalMinor: number; taxRateBps: number };

describe.skipIf(!HAVE_BROWSER)('F7: the served till spreads an offer by what each line charges; a bag and a card number stay safe at the box', () => {
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

  async function till(): Promise<{ edge: EdgeProcess; page: Page; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-f7-till-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    // No cloud: the till and its store computer price and judge on their own (P-01).
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({
        dir, key: KEY,
        pack: {
          version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [],
          weighingScales: [{ assetId: 'SCALE-L1', laneIds: ['lane-1'], approvalNo: 'LM/TN/APP/0042', capacityGrams: 30_000, lastStampedOn: day(-300), reverificationDueOn: day(120), certificateRef: 'LM/VC/2025/0042' }],
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
    return { edge, page, dir };
  }
  const scan = async (page: Page, code: string): Promise<void> => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const postSale = async (edge: EdgeProcess, record: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: day(0), committedAt: new Date().toISOString(), ...record }),
    });
    return await res.json() as Record<string, unknown>;
  };

  it('NEW-2: banana 333 g + rice + bag under ₹100 off — ₹8.29 on screen; the disk adds up, nothing below zero, the bag at ₹5', async () => {
    const { edge, page } = await till();
    for (const code of [BANANA_333G, RICE, BAG]) await scan(page, code);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 3);
    expect(await page.textContent('#total')).toBe('₹8.29');
    if (SHOTS !== undefined) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, 'till-offer-by-what-each-line-charges.png') }); }
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child'); // Cash
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child'); // Exact
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    const saved = JSON.parse(first.record) as { lines: Line[]; total: number; netMinor: number; taxMinor: number };
    const of = (id: string): Line => saved.lines.find((l) => l.productId === id)!;
    expect(of('P-BAN')).toMatchObject({ quantityMinor: 333, uom: 'kg', unitPriceMinor: 99_99, lineTotalMinor: 1_06 });
    expect(of('P-RICE').lineTotalMinor).toBe(2_23);
    expect(of('P-BAG')).toMatchObject({ unitPriceMinor: 5_00, lineTotalMinor: 5_00 });
    expect(saved.total).toBe(8_29);
    expect(saved.lines.every((l) => l.lineTotalMinor >= 0)).toBe(true);
    expect(saved.lines.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(saved.total);
    const inside = saved.lines.map((l) => splitInclusive(money(l.lineTotalMinor, 'INR'), rate(l.taxRateBps)));
    expect(inside.every((s) => s.net.minor >= 0 && s.tax.minor >= 0)).toBe(true);
    expect(saved.taxMinor).toBe(inside.reduce((n, s) => n + s.tax.minor, 0));
    expect(saved.netMinor + saved.taxMinor).toBe(saved.total);
  });

  it('L1: a carry bag posted straight to the box as "kg" and charged a paisa is refused before the disk', async () => {
    const { edge } = await till();
    const box = await postSale(edge, {
      id: 'S-BAGKG', number: 'R-BAGKG', total: 1,
      lines: [{ productId: 'P-BAG', quantityMinor: 1, uom: 'kg', unitPriceMinor: 5_00, lineTotalMinor: 1, taxRateBps: 500 }],
      tenders: [{ kind: 'cash', amount: { minor: 1, currency: 'INR' }, status: 'settled' }],
    });
    expect(box).toMatchObject({ committed: false, refusedBecause: 'carry_bag_discounted' });
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });

  it('NEW-3: a card number sent as a JSON number, or nested, never reaches any file the store computer writes', async () => {
    const { edge, dir } = await till();
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const numbered = await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/receipt-numbers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify({ requestKey: 'rk-num-1' }),
    })).json() as { issued: boolean; receiptNumber: string };
    expect(numbered.issued).toBe(true);
    // Sent as raw JSON so the number stays a number on the wire.
    const body = `{"laneId":"lane-1","cashierId":"u-lanecash","tradingDay":"${day(0)}","committedAt":"${new Date().toISOString()}","id":"S-NUM","number":"${numbered.receiptNumber}","receiptNumber":"${numbered.receiptNumber}","total":7000,`
      + `"lines":[{"productId":"P-RICE","quantityMinor":1,"uom":"ea","unitPriceMinor":7000,"lineTotalMinor":7000,"taxRateBps":500}],`
      + `"tenders":[{"kind":"cash","amount":{"minor":7000,"currency":"INR"},"status":"settled","ref":${PAN},"points":{"deep":[${PAN}]}}]}`;
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, { method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body });
    const answer = await res.json() as Record<string, unknown>;
    expect(answer).toMatchObject({ committed: true, cardDataNotice: expect.stringMatching(/were NOT kept/) as unknown });
    const [kept] = await readLog(edge.log.path);
    if (kept?.ok !== true) throw new Error('the sale was not kept');
    expect(JSON.parse(kept.record)).toMatchObject({ id: 'S-NUM', tenders: [{ kind: 'cash', status: 'settled', amount: { minor: 70_00 }, cardDataRemoved: { fields: ['points', 'ref'] } }] });
    let files = 0;
    for (const f of await readdir(dir, { recursive: true })) {
      const p = join(dir, String(f));
      try { expect(await readFile(p, 'utf8'), String(f)).not.toContain(PAN); files += 1; } catch (e) { if ((e as { code?: string }).code !== 'EISDIR') throw e; }
    }
    expect(files).toBeGreaterThan(1);
  });
});
