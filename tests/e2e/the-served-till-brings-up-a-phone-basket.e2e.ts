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
 * **OB-350 scan-and-go at the lane — the cashier brings a customer's phone basket up through the SCREEN, and the till prices
 * it (the till change is minimal and additive: one entry under More, beside the held-bill recall).**
 *
 * In a real Chromium against a real edge whose head office is a stand-in answering the recall route: More → "Phone basket
 * (scan and go)" → the six digits on the till's own keypad → the lines are rung through THIS till's pack (₹480 each from
 * the box's pack — head office sends no price) → paid as any bill. The same code again is refused in head office's words;
 * with the line down the till says to scan the items; the option is not offered while a basket is on the till. Tamil.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['served', 'till', 'phone', 'basket', 'key'].join('-').padEnd(48, '0');
const BOX_TOKEN = TEST_IDP.issue({ sub: 'u-box', tenantId: 't-sre', branchId: 'store-1' });
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});
interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; tenderCash(saleId: string, receiptNumber: string, atIsoUtc: string): Promise<string>; nextReceipt(): Promise<string>; newSale(): void; payableMinor(): number } }

describe.skipIf(!existsSync(CHROMIUM))('the served till brings up a scan-and-go phone basket and prices it (OB-350)', () => {
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
  const shown = async (page: Page): Promise<{ title: string; text: string; bill: string }> => {
    await page.waitForSelector('#refusal:not([hidden])');
    const out = { title: (await page.textContent('#refusal-title')) ?? '', text: (await page.textContent('#refusal-text')) ?? '', bill: (await page.locator('#refusal').innerText()) };
    await page.click('#refusal-ok');
    return out;
  };
  const more = async (page: Page): Promise<string[]> => {
    await page.click('#more');
    await page.waitForSelector('#pay:not([hidden])');
    return page.$$eval('#pay-kinds button', (b) => b.map((x) => x.textContent ?? ''));
  };
  const choose = async (page: Page, label: string): Promise<void> => { await page.click(`#pay-kinds button:text-is("${label}")`); };

  it('More → Phone basket → six digits → rung at the till\'s own prices → paid; again → refused; line down → scan the items; Tamil', async () => {
    // Head office, as far as this box can tell: the recall route, once; the line can be cut.
    let online = true;
    const recalls: { url: string; body: unknown; auth: string }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1:')) return savedFetch(url, init);
      if (!online) throw new Error('ENETUNREACH');
      if (u === 'https://cloud.example.test/v1/store/scan-and-go/123456/recall') {
        recalls.push({ url: u, body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>)['authorization']) });
        return recalls.length === 1
          ? new Response(JSON.stringify({ recalled: true, code: '123456', lines: [{ productId: 'P1', name: 'Toor dal 1kg', quantityMinor: 2, barcode: '8901234567890' }] }), { status: 200 })
          : new Response(JSON.stringify({ error: { code: 'already_recalled', whatHappened: 'This basket was already brought up at till lane-1. A basket is brought up once.' } }), { status: 409 });
      }
      return new Response('{}', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const said: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-phone-basket-'));
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

    // ── The cashier keys the code from the customer's phone: two lines' worth rung at THIS till's price.
    expect(await more(page)).toContain('Phone basket (scan and go)');
    await choose(page, 'Phone basket (scan and go)');
    await keyDigits(page, '123456');
    const brought = await shown(page);
    expect(brought.text).toBe('Phone basket 123456: 1 line(s) rung at the till\'s prices. Check the bag, then take the payment.');
    await page.waitForSelector('#lines tr');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.payableMinor())).toBe(96_000);
    expect(recalls).toEqual([{ url: 'https://cloud.example.test/v1/store/scan-and-go/123456/recall', body: { laneId: 'lane-1', cashierId: 'u-lanecash' }, auth: `Bearer ${BOX_TOKEN}` }]);
    // While a basket is on the till, the option is not offered — a phone basket never joins another customer's.
    expect(await more(page)).not.toContain('Phone basket (scan and go)');
    await page.click('#pay-cancel');
    await page.evaluate(async () => {
      const w = globalThis as unknown as PosWindow;
      await w.posSession!.tenderCash('S-phone-1', await w.posSession!.nextReceipt(), new Date().toISOString());
      w.posSession!.newSale();
    });
    const sold = (await readLog(edge.log.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { total: number }] : []));
    expect(sold).toEqual([expect.objectContaining({ total: 96_000 })]);

    // ── The same code again: refused in head office's words; nothing rung.
    await more(page);
    await choose(page, 'Phone basket (scan and go)');
    await keyDigits(page, '123456');
    expect((await shown(page)).text).toBe('This basket was already brought up at till lane-1. A basket is brought up once.');
    // ── The line down: the till says to scan the items — the sale never needs it.
    online = false;
    await more(page);
    await choose(page, 'Phone basket (scan and go)');
    await keyDigits(page, '123456');
    expect((await shown(page)).text).toMatch(/Scan the items as usual/);

    // ── Tamil.
    await page.click('#lang');
    expect(await more(page)).toContain('ஃபோன் கூடை (ஸ்கேன் செய்து செல்)');
    await page.click('#pay-cancel');
    expect(errors).toEqual([]);
  }, 90_000);
});
