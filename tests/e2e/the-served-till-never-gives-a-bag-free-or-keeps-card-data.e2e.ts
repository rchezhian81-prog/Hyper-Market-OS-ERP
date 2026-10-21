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
import { prepareTillBox, signInThroughScreen, signInAtLane, operatorHeader } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **Follow-up F1 (till) in a real browser against a REAL store computer (B19 NEW-1 · B6 NEW-2 · OB-160 · C10 NEW-3).**
 *
 * The box holds head office's SIGNED catalogue pack — which now signs every product's unit and the barcode rules — with an
 * offer that would give the 120-micron carry bag away. A real Chromium drives the real till shell:
 *
 *   • NEW-1 — the till refuses the bag offer and SAYS so on screen; the bag rings at ₹5 and lands on the disk at ₹5;
 *   • OB-160 — 15 cigarettes from packs of 10 are refused at the till, and posted straight to the box they are refused
 *     before its disk;
 *   • NEW-2 — a weighed banana sent to the box as "L" on a lane whose scale stamp lapsed is refused before the disk;
 *   • NEW-3 — a sale whose tender carries a card number, a security code and an expiry is KEPT (it happened) with those
 *     removed: nothing card-like is in any file the store computer wrote.
 *
 * Screenshots for the owner are written only when SRE_SHOTS names a directory. Skips where no browser binary is present.
 * Synthetic data only (the card number is the public test number card networks publish).
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const SHOTS = process.env['SRE_SHOTS'];
const KEY = ['f1', 'till', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const PAN = ['4111', '1111', '1111', '1111'].join('');
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const CIG_STICK = '8900000000127';
const GOOD_BAG = '8900000000404';
const RICE = '8900000000707';

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 5, builtAt: new Date().toISOString(),
    products: [
      { productId: 'P-BAN', sku: '000123', name: 'Banana (loose)', baseUom: 'kg', unitPriceMinor: 99_99, taxBps: 0, status: 'active' },
      { productId: 'P-STICK', sku: 'CIG-STICK', name: 'Cigarette stick (demo)', baseUom: 'ea', unitPriceMinor: 18_00, taxBps: 2800, status: 'active', regulatedFlags: { tobacco: true, packMinimumMinor: 10, minimumAge: 18 } },
      { productId: 'P-BAG', sku: 'BAG-120', name: 'Carry bag 120 micron', baseUom: 'ea', unitPriceMinor: 5_00, taxBps: 0, status: 'active', regulatedFlags: { carryBag: true, plasticMaterial: 'plastic', plasticThicknessMicrons: 120 } },
      { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
    ],
    barcodes: [
      { code: CIG_STICK, productId: 'P-STICK', kind: 'standard' }, { code: GOOD_BAG, productId: 'P-BAG', kind: 'standard' }, { code: RICE, productId: 'P-RICE', kind: 'standard' },
    ],
    embeddedRules: [{ prefix: '2', itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' }],
    // A "free carry bag" offer that slipped into the pack (a pack built before head office refused such offers).
    promotions: [{ id: 'PR-FREEBAG', kind: 'amount_off', status: 'active', startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', productIds: ['P-BAG'], amountOffMinor: 5_00 }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): { productId: string; qty: number }[]; payableMinor(): number; scan(i: unknown): void; refusedOffers(): { offerId: string }[] } }
interface Doc { readonly document: { querySelector(selector: string): { hidden: boolean; textContent: string | null } | null } }

describe.skipIf(!HAVE_BROWSER)('F1: the served till never gives a bag free, sells a part pack, skips a scale, or keeps card data', () => {
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

  async function till(stampValidTo: string): Promise<{ edge: EdgeProcess; page: Page; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-f1-till-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({
        dir, key: KEY,
        pack: {
          version: 1, policies: { tradingDayCutoff: '02:00', storeId: 'store-1' }, lossPreventionRules: [],
          weighingScales: [{ assetId: 'SCALE-L1', laneIds: ['lane-1'], approvalNo: 'LM/TN/APP/0042', capacityGrams: 30_000, lastStampedOn: day(-300), reverificationDueOn: stampValidTo, certificateRef: 'LM/VC/2025/0042' }],
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
  const postSale = async (edge: EdgeProcess, record: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/sales`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ laneId: 'lane-1', cashierId: 'u-lanecash', tradingDay: day(0), committedAt: new Date().toISOString(), ...record }),
    });
    return await res.json() as Record<string, unknown>;
  };

  it('NEW-1: the till refuses the free-bag offer and says so on screen; the bag rings at ₹5 and lands on the disk at ₹5', async () => {
    const { edge, page } = await till(day(120));
    await page.waitForFunction(() => !((globalThis as unknown as Doc).document.querySelector('#offers-refused')!.hidden));
    expect(await page.textContent('#offers-refused')).toContain('PR-FREEBAG');
    expect(await page.textContent('#offers-refused')).toMatch(/would give a carry bag free/);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.refusedOffers().map((o) => o.offerId))).toEqual(['PR-FREEBAG']);
    expect(await auditPage(page, { expectLang: 'en' }), 'the till with the notice').toEqual([]);
    await scan(page, RICE);
    await scan(page, GOOD_BAG);
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().length === 2);
    expect(await page.textContent('#total')).toBe('₹75.00');
    await shot(page, 'till-free-bag-offer-refused');
    await payCash(page);
    await expect.poll(async () => (await readLog(edge.log.path)).length, { timeout: 10_000 }).toBe(1);
    const [first] = await readLog(edge.log.path);
    if (first?.ok !== true) throw new Error('the sale did not land on the box');
    const saved = JSON.parse(first.record) as { lines: { productId: string; lineTotalMinor: number }[] };
    expect(saved.lines.find((l) => l.productId === 'P-BAG')?.lineTotalMinor).toBe(5_00);
  });

  it('OB-160: 15 sticks from packs of 10 are refused at the till and, posted straight to the box, refused before its disk', async () => {
    const { edge, page } = await till(day(120));
    const tried = await page.evaluate(() => {
      try { (globalThis as unknown as PosWindow).posSession!.scan({ productId: 'P-STICK', description: 'Cigarette stick (demo)', unitPriceMinor: 18_00, qty: 15 }); return 'sold'; } catch (e) { return (e as { refusals?: { reason: string }[] }).refusals?.[0]?.reason ?? String(e); }
    });
    expect(tried).toBe('tobacco_not_whole_packs');
    const box = await postSale(edge, { id: 'S-PART', number: 'R-PART', total: 270_00, lines: [{ productId: 'P-STICK', quantityMinor: 15, uom: 'ea', unitPriceMinor: 18_00, lineTotalMinor: 270_00 }], tenders: [{ kind: 'cash', amount: { minor: 270_00, currency: 'INR' }, status: 'settled' }] });
    expect(box).toMatchObject({ committed: false, refusedBecause: 'tobacco_not_whole_packs' });
    expect(String(box['laneMessage'])).toMatch(/whole packs of 10\. This line is 15/);
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });

  it('NEW-2: a weighed banana sent to the box as "L" on a lapsed lane is refused before the disk — the box\'s catalogue says kg', async () => {
    const { edge } = await till(day(-2));
    for (const uom of ['L', 'ea']) {
      const box = await postSale(edge, { id: `S-${uom}`, number: `R-${uom}`, total: 33_29, lines: [{ productId: 'P-BAN', quantityMinor: 333, uom, unitPriceMinor: 99_99, lineTotalMinor: 33_29 }], tenders: [{ kind: 'cash', amount: { minor: 33_29, currency: 'INR' }, status: 'settled' }] });
      expect(box, uom).toMatchObject({ committed: false, refusedBecause: 'weighed_on_lapsed_scale' });
    }
    expect(await readLog(edge.log.path)).toHaveLength(0);
  });

  it('NEW-3: a sale whose tender carries a card number is KEPT with it removed; no file the store computer wrote holds it', async () => {
    const { edge, dir } = await till(day(120));
    // A card-machine link sends a sale with the card's details in its tender, under a bill number the box issued.
    const token = await signInAtLane(edge.lane!.port, 'u-lanecash');
    const numbered = await (await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/receipt-numbers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify({ requestKey: 'rk-card-1' }),
    })).json() as { issued: boolean; receiptNumber: string };
    expect(numbered.issued).toBe(true);
    const hostile = await postSale(edge, {
      id: 'S-CARD', number: numbered.receiptNumber, receiptNumber: numbered.receiptNumber, total: 70_00,
      lines: [{ productId: 'P-RICE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 70_00, lineTotalMinor: 70_00 }],
      tenders: [{ kind: 'cash', amount: { minor: 70_00, currency: 'INR' }, status: 'settled', ref: PAN, card: { pan: PAN, cvv: '123', expiry: '12/29' } }],
    });
    expect(hostile).toMatchObject({ committed: true, cardDataNotice: expect.stringMatching(/were NOT kept/) as unknown });
    expect(JSON.stringify(hostile)).not.toContain(PAN);
    const [kept] = await readLog(edge.log.path);
    if (kept?.ok !== true) throw new Error('the sale was not kept');
    expect(JSON.parse(kept.record)).toMatchObject({ id: 'S-CARD', tenders: [{ kind: 'cash', status: 'settled', cardDataRemoved: { fields: ['card.cvv', 'card.expiry', 'card.pan', 'ref'] } }] });
    let files = 0;
    for (const f of await readdir(dir, { recursive: true })) {
      const p = join(dir, String(f));
      try { expect(await readFile(p, 'utf8'), String(f)).not.toContain(PAN); files += 1; } catch (e) { if ((e as { code?: string }).code !== 'EISDIR') throw e; }
    }
    expect(files).toBeGreaterThan(1);
  });
});
