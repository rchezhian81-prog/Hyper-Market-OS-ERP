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
 * **OB-523 (owner, 28 Oct 2026): cancelling a bill that rang a quotation up frees the quotation again, with a reason on record,
 * through the SCREEN.** In a real Chromium against a real edge whose head office is a stand-in: the cashier rings quotation
 * 48151623 up, then More → "Cancel the whole bill" → a preset reason → "Yes, cancel the bill". Head office is out of reach:
 * the store computer keeps each line's void and the quotation's release on its own disk, the till clears and says so. When
 * the line is back the box sends the release ONCE to head office's free route (with who and why) and the voids to loss
 * prevention. The option is not offered on an empty till; Tamil words.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const KEY = ['served', 'till', 'cancel', 'bill', 'key'].join('-').padEnd(48, '0');
const BOX_TOKEN = TEST_IDP.issue({ sub: 'u-box', tenantId: 't-sre', branchId: 'store-1' });
const PACK = JSON.stringify({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' },
  lossPreventionRules: [],
  products: [{ productId: 'P1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 48_000, uom: 'ea', barcodes: ['8901234567890'], availableMinor: 100, taxBps: 0, status: 'active' }],
});
interface PosWindow { readonly posSession?: { hasCatalogue(): boolean; payableMinor(): number; currentBillRef(): string; quotationsOnBill(): readonly string[] } }

describe.skipIf(!existsSync(CHROMIUM))('the served till cancels a quotation\'s bill and frees the quotation (OB-523)', () => {
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

  it('rung up → More → Cancel the whole bill → reason → yes: kept on the box offline, cleared; sent once when the line is back; Tamil', async () => {
    let online = true;
    const converts: string[] = [];
    const frees: { body: Record<string, unknown>; key: string }[] = [];
    const voids: Record<string, unknown>[] = [];
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
        frees.push({ body, key: String((init?.headers as Record<string, string>)['idempotency-key']) });
        return new Response(JSON.stringify({ quotationId: '48151623', freed: true, state: 'issued' }), { status: 201 });
      }
      if (u.startsWith('https://cloud.example.test/v1/loss-prevention/activity/')) { voids.push(body); return new Response(JSON.stringify({ recorded: true }), { status: 201 }); }
      return new Response('{}', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const said: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'sre-served-till-cancel-bill-'));
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

    // An empty till: nothing to cancel, so the option is not offered.
    expect(await more(page)).not.toContain('Cancel the whole bill');
    await page.click('#pay-cancel');

    // Rung up by its number.
    await more(page);
    await choose(page, 'Quotation number');
    await keyDigits(page, '48151623');
    expect((await shown(page)).text).toMatch(/^Quotation 48151623: 1 line\(s\) rung at the quoted prices\./);
    const billRef = await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.currentBillRef());
    expect(converts).toEqual([billRef]);

    // Head office goes out of reach; the customer walks away — the cashier cancels the whole bill.
    online = false;
    expect(await more(page)).toContain('Cancel the whole bill');
    await choose(page, 'Cancel the whole bill');
    await choose(page, 'Customer left without it');
    await choose(page, 'Yes, cancel the bill');
    const cancelled = await shown(page);
    expect(cancelled.title).toBe('Cancel the whole bill');
    expect(cancelled.text).toBe('Bill cancelled: 1 line(s) voided with the reason. Quotation 48151623 is freed again — head office is told now, or as soon as its line is back; it can then be rung up on a later bill.');
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.payableMinor())).toBe(0);
    expect(await page.evaluate(() => (globalThis as unknown as PosWindow).posSession!.quotationsOnBill())).toEqual([]);
    // On the box's own disk: the void and the release, with the cashier it verified and the reason.
    const kept = (await readLog(edge.deviceEventsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as { type: string; payload: Record<string, unknown> }] : []));
    expect(kept.map((e) => e.type)).toEqual(['TillActivityRecorded', 'QuotationFreedAtTill']);
    expect(kept[1]!.payload).toMatchObject({ quotationId: '48151623', saleId: billRef, freedBy: 'u-lanecash', reason: 'customer_left', laneId: 'lane-1' });
    expect(frees).toEqual([]);

    // The line is back: the box sends each once.
    online = true;
    await edge.syncOnce!();
    expect(frees).toHaveLength(1);
    expect(frees[0]!.body).toMatchObject({ quotationId: '48151623', saleId: billRef, freedBy: 'u-lanecash', reason: 'customer_left' });
    expect(voids).toEqual([expect.objectContaining({ kind: 'void', billRef, reason: 'customer_left', valueMinor: 90_000 })]);
    await edge.syncOnce!();
    expect(frees).toHaveLength(1);

    // Tamil: the option, the reason and the confirmation in the cashier's words.
    await page.click('#lang');
    await more(page);
    await choose(page, 'விலைப்புள்ளி எண்');
    await keyDigits(page, '48151623');
    await shown(page);
    expect(await more(page)).toContain('முழு பில்லையும் ரத்து செய்');
    await choose(page, 'முழு பில்லையும் ரத்து செய்');
    await choose(page, 'தவறான விலைப்புள்ளி உள்ளிடப்பட்டது');
    await choose(page, 'ஆம், பில்லை ரத்து செய்');
    expect((await shown(page)).text).toMatch(/^பில் ரத்து செய்யப்பட்டது: 1 வரி\(கள்\) காரணத்துடன் நீக்கப்பட்டன\./);
    expect(errors).toEqual([]);
  }, 120_000);
});
