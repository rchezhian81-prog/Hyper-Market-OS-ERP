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
 * **OB-506 (M12-FR-02): the cashier rings a retail quotation up at the till by its number, through the SCREEN (the till change
 * is minimal and additive: one entry under More, its step in its own file).**
 *
 * In a real Chromium against a real edge whose head office is a stand-in answering the convert route: More → "Quotation
 * number" → the eight digits on the till's own keypad → the store computer asks head office to convert it for THIS bill
 * (under its own credential) → the line is rung through this till's pack and lowered to the quoted ₹450 (from ₹480) → paid.
 * The same number on another bill is refused in words (it is on bill …); with head office unreachable the till says so
 * plainly and rings nothing; the option is not offered while a basket is on the till. Tamil.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['served', 'till', 'quote', 'number', 'key'].join('-').padEnd(48, '0');
const BOX_TOKEN = TEST_IDP.issue({ sub: 'u-box', tenantId: 't-sre', branchId: 'store-1' });
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});
interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>; nextReceipt(): Promise<string>; newSale(): void; payableMinor(): number; currentBillRef(): string } }

describe.skipIf(!existsSync(CHROMIUM))('the served till rings a quotation up by its number (OB-506)', () => {
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
    return out;
  };
  const more = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, label: string): Promise<void> => { await page.click(`#pay-kinds button:text-is("${label}")`); };

  it('More → Quotation number → eight digits → rung at the quoted price → paid; again → refused; line down → said, nothing rung; Tamil', async () => {
    let online = true;
    const converts: { url: string; body: { saleId: string; laneId: string; cashierId: string }; auth: string }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      if (u === 'https://cloud.example.test/v1/pos/quotations/48151623/convert') {
        const body = JSON.parse(String(init?.body)) as { saleId: string; laneId: string; cashierId: string };
        converts.push({ url: u, body, auth: String((init?.headers as Record<string, string>)['authorization']) });
        return converts.length === 1
          ? new Response(JSON.stringify({ quotationId: '48151623', converted: true, saleId: body.saleId, saleLines: [{ lineId: 'l1', productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 45_000, quantityMinor: 2, uom: 'ea', taxBps: 0 }] }), { status: 200 })
          : new Response(JSON.stringify({ quotationId: '48151623', converted: false, alreadyConverted: true, saleId: converts[0]!.body.saleId }), { status: 200 });
      }
      return new Response('{}', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const said: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-quotation-'));
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

    // ── The cashier keys the number on the customer's quotation: the line rung at the QUOTED price (₹450, not ₹480).
    expect(await more(page)).toContain('Quotation number');
    await choose(page, 'Quotation number');
    await keyDigits(page, '48151623');
    const rung = await shown(page);
    expect(rung.text).toBe('Quotation 48151623: 1 line(s) rung at the quoted prices. Check the goods, then take the payment.');
    await page.waitForSelector('#lines tr');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.payableMinor())).toBe(90_000);
    const billRef = await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.currentBillRef());
    expect(converts).toEqual([{ url: 'https://cloud.example.test/v1/pos/quotations/48151623/convert', body: { saleId: billRef, laneId: 'lane-1', cashierId: 'u-lanecash' }, auth: `Bearer ${BOX_TOKEN}` }]);
    // While a basket is on the till, the option is not offered — a quotation is rung on its own bill.
    expect(await more(page)).not.toContain('Quotation number');
    await page.click('#pay-cancel');
    await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      await w.posSession!.tenderCash('S-quote-1', await w.posSession!.nextReceipt(), new Date().toISOString());
      w.posSession!.newSale();
    });
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { total: number; lines: { unitPriceMinor: number; priceOverride?: { approvedBy?: string } }[] }] : []));
    expect(sold).toEqual([expect.objectContaining({ total: 90_000 })]);
    expect(sold[0]!.lines[0]).toMatchObject({ unitPriceMinor: 45_000, priceOverride: { approvedBy: 'quotation 48151623' } });

    // ── The same number on a new bill: refused in words, naming the bill it is on; nothing rung.
    await more(page);
    await choose(page, 'Quotation number');
    await keyDigits(page, '48151623');
    expect((await shown(page)).text).toBe(`Quotation 48151623 was already rung up on bill ${billRef}. A quotation becomes one bill — nothing was rung.`);
    // ── Head office out of reach: said plainly; nothing rung.
    online = false;
    await more(page);
    await choose(page, 'Quotation number');
    await keyDigits(page, '48151623');
    expect((await shown(page)).text).toMatch(/^A quotation is rung up through head office, and head office cannot be reached now\. Nothing was rung\./);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.payableMinor())).toBe(0);

    // ── Tamil: the option and the plain words.
    await page.click('#lang');
    expect(await more(page)).toContain('விலைப்புள்ளி எண்');
    await choose(page, 'விலைப்புள்ளி எண்');
    await keyDigits(page, '48151623');
    expect((await shown(page)).text).toMatch(/தலைமை அலுவலகத்தை அடைய முடியவில்லை/);
    expect(errors).toEqual([]);
  }, 90_000);
});
