import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **D14-FR-02 · R8-3 — the price kiosk, in a real browser, served by a real store computer from its SIGNED price list with
 * no head office at all.** A scanned code shows the till's price and how old the list is; a recalled item is never
 * quoted; once the owner's "stop quoting after" minutes are set, an older list says "check at the counter". The page
 * posts nothing: every request it makes is a GET for its own files. English and Tamil. Skips without a browser.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['price', 'kiosk', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

function signedPack(builtAt: string) {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 9, builtAt,
    products: [
      { productId: 'P-RICE', sku: 'RICE-1', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 70_00, taxBps: 0, status: 'active' },
      { productId: 'P-TIN', sku: 'TIN-1', name: 'Fish tin (recalled)', baseUom: 'ea', unitPriceMinor: 90_00, taxBps: 0, status: 'active', recallBlock: true },
    ],
    barcodes: [{ code: '8900000000707', productId: 'P-RICE', kind: 'standard' }, { code: '8900000000808', productId: 'P-TIN', kind: 'standard' }],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-manager', publishedAt: builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

type Doc = { document: { querySelector(s: string): { textContent: string | null } | null } };

describe.skipIf(!HAVE_BROWSER)('the price kiosk (D14-FR-02)', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'price-kiosk'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 120_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function kiosk(builtAt: string, policies: Record<string, unknown>): Promise<{ page: Page; requests: string[] }> {
    const dir = await mkdtemp(join(tmpdir(), 'sre-price-kiosk-'));
    dirs.push(dir);
    await writeSignedPack(dir, signedPack(builtAt));
    const packFile = join(dir, 'store-pack.json');
    await import('node:fs/promises').then((fs) => fs.writeFile(packFile, JSON.stringify({ version: 1, policies: { tradingDayCutoff: '00:00', storeId: 'store-1', ...policies } })));
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (r) => { requests.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/price-kiosk/`, { waitUntil: 'load' });
    await page.waitForFunction(() => (globalThis as unknown as { kiosk?: unknown }).kiosk !== undefined, undefined, { timeout: 15_000 });
    return { page, requests };
  }
  const scan = async (page: Page, code: string): Promise<void> => { await page.keyboard.type(code); await page.keyboard.press('Enter'); };
  const answer = (page: Page): Promise<string> => page.evaluate(() => (globalThis as unknown as Doc).document.querySelector('#answer')?.textContent ?? '');

  it('quotes the signed price with the list\'s age, never a recalled item, posts nothing; Tamil too', async () => {
    const { page, requests } = await kiosk(new Date(Date.now() - 2 * 3_600_000).toISOString(), {});
    expect(await page.textContent('#age-words')).toMatch(/updated 2 hour\(s\) ago/);
    expect(await page.textContent('#limit')).toMatch(/not set by the owner/);
    await scan(page, '8900000000707');
    expect(await answer(page)).toMatch(/Ponni rice 1kg: ₹70\.00\. Offers are applied at the till/);
    await scan(page, '8900000000808');
    expect(await answer(page)).toMatch(/not on sale here/);
    await scan(page, '123');
    expect(await answer(page)).toMatch(/not in this shop's list/);
    await page.click('#lang');
    expect(await page.textContent('#title')).toBe('விலை சரிபார்ப்பு');
    expect(await answer(page)).toMatch(/பட்டியலில் இல்லை/);
    // Read-only: nothing but GETs for the kiosk's own page and files.
    expect(requests.filter((r) => !r.startsWith('GET /price-kiosk/'))).toEqual([]);
  });

  it('once the owner sets the limit, a list older than it says "check the price at the counter"', async () => {
    const { page } = await kiosk(new Date(Date.now() - 5 * 3_600_000).toISOString(), { kioskStaleAfterMinutes: 240 });
    expect(await page.textContent('#limit')).toMatch(/older than 240 minutes/);
    await scan(page, '8900000000707');
    expect(await answer(page)).toMatch(/too old to quote from\. Please check the price at the counter/);
  });
});
