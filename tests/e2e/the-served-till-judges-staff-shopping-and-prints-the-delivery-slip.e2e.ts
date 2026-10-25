import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { readLog } from '../../edge/store-edge/src/file-log';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { loyaltyMemberKey, memberRefFor } from '../../packages/loyalty/src/index';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { auditPage } from './lib/a11y-audit';

/**
 * **The served till, in a real browser, against a REAL store computer with no head office at all (hard rule #1):**
 *
 *   • OB-301 — a staff member's own shopping (their member number keyed on the bill) is refused by the store computer
 *     before anything is saved: the owner has not named the service-desk till yet ("not set"). The panel says so under its
 *     own heading, in English — and in Tamil when the till is in Tamil. Nothing reaches the box's disk.
 *   • OB-352 — a bill marked for delivery for a customer WITHOUT the app shows the delivery slip under the bill (the job,
 *     the bill, blank lines for the address, landmark, phone and slot) and "Print delivery slip" beside the truck mark,
 *     which prints it; for a member WITH the app (as the box's copy of the members says) the bill says to choose in the app,
 *     and no slip is offered.
 *
 * Synthetic data only. Skips where no browser binary is present.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['till', 'staff', 'slip', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const ean = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};
const RICE = ean('890100000102');
const MOBILE = { ravi: '9840011111', app: '9840022222', walkIn: '9840033333' };
const memberOf = (mobile: string): string => memberRefFor(loyaltyMemberKey(KEY), mobile)!;

const PRINT_RECORDER = `
  window.prints = [];
  window.print = () => { const a = document.getElementById('print-area'); window.prints.push({ copy: a.dataset.copy, number: a.dataset.number, lang: a.lang, text: a.textContent }); };`;

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 3, builtAt: new Date().toISOString(),
    products: [
      { productId: 'p-rice', sku: 'RICE', name: 'Ponni rice 5kg', baseUom: 'ea', unitPriceMinor: 400_00, taxBps: 0, hsnCode: '1006', status: 'active' },
      { productId: 'p-del', sku: 'DELIVERY', name: 'Home delivery', baseUom: 'ea', unitPriceMinor: 30_00, taxBps: 1800, hsnCode: '996813', status: 'active' },
    ],
    barcodes: [{ code: RICE, productId: 'p-rice', kind: 'standard' }],
    promotions: [],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; basket(): { productId: string; voided: boolean }[] } }

describe.skipIf(!HAVE_BROWSER)('the served till judges staff shopping and prints the delivery slip (OB-301 · OB-352)', () => {
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

  const boxWith = async (policies: Record<string, unknown>): Promise<{ edge: EdgeProcess; dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-staff-slip-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    // The box's copy of the members (head office's wallet feed): one member has the app.
    await writeFile(join(dir, 'loyalty-wallets.json'), `${JSON.stringify({
      tenantId: TENANT, receivedAt: new Date().toISOString(),
      feed: {
        tenantId: TENANT, generatedAt: new Date(Date.now() - 60_000).toISOString(), rule: { pointsPer100Inr: 0, pointValuePaise: 0, tillSpendCapPaise: 0 },
        members: [
          { memberRef: memberOf(MOBILE.app), points: 0, storeCreditMinor: 0, appliedSpendRefs: [], appLinked: true },
          { memberRef: memberOf(MOBILE.walkIn), points: 0, storeCreditMinor: 0, appliedSpendRefs: [] },
        ],
      },
    })}\n`, 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_LANE_PORT: '0',
      ...await prepareTillBox({ dir, key: KEY, pack: { version: 1, policies: { tradingDayCutoff: '00:00', storeId: 'store-1', ...policies }, lossPreventionRules: [] } }),
    }, () => {}))!;
    stops.push(() => edge.stop());
    return { edge, dir };
  };
  const open = async (edge: EdgeProcess): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    await page.addInitScript(PRINT_RECORDER);
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => { const w = globalThis as unknown as PosWindow; return w.posSession !== undefined && w.posSession.hasCatalogue(); }, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    return page;
  };
  const scanRice = async (page: Page): Promise<void> => {
    await page.keyboard.type(RICE); await page.keyboard.press('Enter');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.basket().some((l) => l.productId === 'p-rice' && !l.voided));
  };
  const panel = async (page: Page): Promise<{ title: string; text: string; bill: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    return { title: (await page.textContent('#refusal-title')) ?? '', text: (await page.textContent('#refusal-text')) ?? '', bill: (await page.textContent('#refusal-receipt')) ?? '' };
  };
  const payCash = async (page: Page): Promise<void> => {
    await page.click('#tender');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:first-child');
    await page.waitForSelector('#quick button');
    await page.click('#quick button:first-child');
  };
  const nameMember = async (page: Page, mobile: string): Promise<void> => {
    await page.click('#more');
    await page.waitForSelector('#pay-kinds button');
    const labels = await page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
    const label = labels.find((l) => l.startsWith('Loyalty member'))!;
    await page.click(`#pay-kinds button:text-is("${label}")`);
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of mobile) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
    await panel(page);
    await page.click('#refusal-ok');
  };
  const deliver = async (page: Page): Promise<void> => {
    await page.click('#more');
    await page.waitForSelector('#pay-kinds button');
    await page.click('#pay-kinds button:has-text("Deliver this bill")');
    await panel(page);
    await page.click('#refusal-ok');
  };
  const disk = async (edge: EdgeProcess) => (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

  it('OB-301: a staff member\'s own shopping is refused before the disk — the service desk is "not set" — in English and in Tamil', async () => {
    const { edge } = await boxWith({ staffPurchase: { staffDiscountCapBps: null, serviceDeskLaneIds: null, staffAccounts: [{ customerRef: memberOf(MOBILE.ravi), employeeId: 'u-ravi' }] } });
    const page = await open(edge);
    await scanRice(page);
    await nameMember(page, MOBILE.ravi);
    await payCash(page);
    const en = await panel(page);
    expect(en.title).toContain('Staff shopping — not saved');
    expect(en.text).toContain('the owner has not named the service-desk till yet (not set)');
    expect(en.text).toContain('Nothing was saved');
    expect(await auditPage(page, { expectLang: 'en' }), 'the staff-shopping panel').toEqual([]);
    await page.click('#refusal-ok');
    await page.click('#lang');
    await payCash(page);
    const ta = await panel(page);
    expect(ta.title).toContain('பணியாளர் பொருட்கள் — சேமிக்கப்படவில்லை');
    expect(ta.text).toContain('அமைக்கப்படவில்லை');
    expect(await disk(edge)).toEqual([]);
  }, 90_000);

  it('OB-352: no app → the delivery slip under the bill and "Print delivery slip", which prints; a member with the app → choose in the app, no slip', async () => {
    const { edge } = await boxWith({ tillDeliveryFeeProductId: 'p-del' });
    const page = await open(edge);
    await scanRice(page);
    await deliver(page);
    await payCash(page);
    const sold = await panel(page);
    expect(sold.bill).toContain('DELIVERY SLIP');
    expect(sold.bill).toMatch(/Delivery job: till-S-/);
    expect(sold.bill).toContain('Address: ________________________');
    expect(sold.bill).toContain('Delivery slot (day and time): ________________________');
    expect(await page.isVisible('#print-slip')).toBe(true);
    expect(await page.locator('#print-slip svg').count()).toBe(1);
    expect(await auditPage(page, { expectLang: 'en' }), 'the bill with its delivery slip').toEqual([]);
    await page.click('#print-slip');
    const prints = await page.evaluate(() => (globalThis as unknown as { prints: { copy: string; text: string }[] }).prints);
    expect(prints).toHaveLength(1);
    expect(prints[0]!.copy).toBe('delivery-slip');
    expect(prints[0]!.text).toContain('DELIVERY SLIP');
    await page.click('#refusal-ok');
    expect((await disk(edge))[0]!['delivery']).toEqual({ requested: true, feeProductId: 'p-del', feeMinor: 30_00 });

    // A member WITH the app, the till in Tamil: the bill says to choose in the app; no slip is offered.
    await scanRice(page);
    await nameMember(page, MOBILE.app);
    await deliver(page);
    await page.click('#lang');
    await payCash(page);
    const app = await panel(page);
    expect(app.bill).toContain('SRE செயலியில்');
    expect(app.bill).not.toContain('________________________');
    expect(await page.isVisible('#print-slip')).toBe(false);
    expect(await disk(edge)).toHaveLength(2);
  }, 90_000);
});
