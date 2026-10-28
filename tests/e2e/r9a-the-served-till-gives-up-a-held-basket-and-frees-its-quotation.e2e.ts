import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { prepareTillBox, signInThroughScreen } from '../support/till-operator';
import { readLog } from '../../edge/store-edge/src/file-log';
import { TEST_IDP } from '../support/api-harness';

/**
 * **R9-A · OB-533 (owner, 28 Oct 2026): a quotation rung up on a bill that is then HELD — the held basket carries the quotation
 * number; giving the held basket up frees the quotation with the reason on record; recalling it keeps the quotation attached
 * — through the SCREEN.** In a real Chromium against a real edge whose head office is a stand-in: the cashier rings quotation
 * 48151623 up, presses Hold (the basket goes to the store computer's disk with the quotation), recalls it (the quotation comes
 * back attached), holds it again, and — head office out of reach — More → "Give up a held basket" → the basket → a reason.
 * The box keeps the release on its own disk and the till says the quotation is freed; when the line is back the box sends it
 * ONCE to head office's free route, from the bill it was rung up on, with who and why. Tamil words.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['served', 'till', 'held', 'quote', 'key'].join('-').padEnd(48, '0');
const BOX_TOKEN = TEST_IDP.issue({ sub: 'u-box', tenantId: 't-sre', branchId: 'store-1' });
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});
interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; payableMinor(): number; currentBillRef(): string; quotationsOnBill(): readonly string[] } }

describe.skipIf(!existsSync(CHROMIUM))('the served till gives up a held basket that carries a quotation, and frees it (OB-533)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  const savedFetch = globalThis.fetch;
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'pos'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 90_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    globalThis.fetch = savedFetch;
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const keyDigits = async (page: Page, digits: string): Promise<void> => {
    await page.waitForSelector('#sheet:not([hidden])');
    for (const digit of digits) await page.click(`#keypad button:text-is("${digit}")`);
    await page.click('#sheet-ok');
  };
  const shown = async (page: Page): Promise<{ title: string; text: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const out = { title: (await page.textContent('#refusal-title')) ?? '', text: (await page.textContent('#refusal-text')) ?? '' };
    await page.click('#refusal-ok');
    await page.waitForSelector('#refusal', { state: 'hidden' });
    return out;
  };
  const more = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, label: string): Promise<void> => {
    await page.waitForSelector(`#pay-kinds button:text-is("${label}")`);
    await page.click(`#pay-kinds button:text-is("${label}")`);
  };

  it('rung up → Hold → recall (still attached) → Hold → give up: kept on the box offline; sent once from the bill it was rung on; Tamil', async () => {
    let online = true;
    const converts: string[] = [];
    const frees: Record<string, unknown>[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
      if (u === 'https://cloud.example.test/v1/pos/quotations/48151623/convert') {
        converts.push(String(body['saleId']));
        return new Response(JSON.stringify({ quotationId: '48151623', converted: true, saleId: body['saleId'], saleLines: [{ lineId: 'l1', productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 45_000, quantityMinor: 2, uom: 'ea', taxBps: 0 }] }), { status: 200 });
      }
      if (u === 'https://cloud.example.test/v1/pos/quotations/48151623/free/synced') {
        frees.push(body);
        return new Response(JSON.stringify({ quotationId: '48151623', freed: true, state: 'issued' }), { status: 201 });
      }
      return new Response('{}', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const said: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-held-quote-'));
    dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK, 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_PACK_FILE: packFile,
      EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
      CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: BOX_TOKEN,
      ...await prepareTillBox({ dir, key: KEY, pack: JSON.parse(PACK) as Record<string, unknown> }),
    }, (line: string) => { said.push(line); }))!;
    if (edge === undefined) throw new Error(said.join('\n'));
    stops.push(() => edge.stop());
    const context = await browser.newContext();
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/pos/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession?.hasCatalogue() === true, undefined, { timeout: 15_000 });
    await signInThroughScreen(page);
    const onBill = () => page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.quotationsOnBill());
    const payable = () => page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.payableMinor());

    // Rung up by its number, then HELD: the basket (and its quotation) goes to the box; the till is clear.
    await more(page);
    await choose(page, 'Quotation number');
    await keyDigits(page, '48151623');
    await shown(page);
    const billRef = await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.currentBillRef());
    expect(converts).toEqual([billRef]);
    await page.click('#hold');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.payableMinor() === 0);
    expect(await onBill()).toEqual([]);
    // RECALLED: the quotation comes back attached, at the quoted price.
    await page.click('#hold');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.payableMinor() === 90_000);
    expect(await onBill()).toEqual(['48151623']);
    // HELD again; then head office goes out of reach and the customer does not come back — the cashier gives it up.
    await page.click('#hold');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.payableMinor() === 0);
    online = false;
    expect(await more(page)).toContain('Give up a held basket');
    await choose(page, 'Give up a held basket');
    await page.waitForSelector('#pay-kinds button:has-text("Toor dal 1kg")');
    await page.click('#pay-kinds button:has-text("Toor dal 1kg")');
    await choose(page, 'Customer left without it');
    const givenUp = await shown(page);
    expect(givenUp.text).toBe('Basket given up. It stays on the record. Quotation 48151623 is freed again — head office is told now, or as soon as its line is back; it can then be rung up on a later bill.');
    expect(await payable()).toBe(0);
    // On the box's own disk: the release, from the bill it was rung up on, with the cashier it verified and the reason.
    const kept = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []));
    expect(kept.map((e) => e.type)).toEqual(['QuotationFreedAtTill']);
    expect(kept[0]!.payload).toMatchObject({ quotationId: '48151623', saleId: billRef, freedBy: 'u-lanecash', reason: 'customer_left', laneId: 'lane-1', via: 'held_basket_given_up' });
    expect(frees).toEqual([]);

    // The line is back: sent once.
    online = true;
    await edge.syncOnce!();
    expect(frees).toHaveLength(1);
    expect(frees[0]).toMatchObject({ quotationId: '48151623', saleId: billRef, freedBy: 'u-lanecash', reason: 'customer_left' });
    await edge.syncOnce!();
    expect(frees).toHaveLength(1);

    // Tamil: rung up again on a new bill, held, given up — the till says the quotation is freed in Tamil.
    await page.click('#lang');
    await more(page);
    await choose(page, 'விலைப்புள்ளி எண்');
    await keyDigits(page, '48151623');
    await shown(page);
    await page.click('#hold');
    await page.waitForFunction(() => (globalThis as unknown as PosWindow).posSession!.payableMinor() === 0);
    await more(page);
    await choose(page, 'நிறுத்திய கூடையைக் கைவிடு');
    await page.waitForSelector('#pay-kinds button:has-text("Toor dal 1kg")');
    await page.click('#pay-kinds button:has-text("Toor dal 1kg")');
    await choose(page, 'வாடிக்கையாளர் வாங்காமல் சென்றார்');
    expect((await shown(page)).text).toMatch(/^கூடை கைவிடப்பட்டது; பதிவில் இருக்கும்\. விலைப்புள்ளி 48151623 மீண்டும் விடுவிக்கப்பட்டது/);
    expect(errors).toEqual([]);
  }, 120_000);
});
