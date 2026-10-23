import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { hmacSigner, publishPack } from '../../services/catalogue/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **The Recalls and trace page is served from the store box too (OB-288 integration follow-up · M10-FR-03/04 · P-01).**
 *
 * The real box, with NO cloud, serves /recall-trace/ in a real browser. The page opens as the quality/recall screen's
 * person, in English and Tamil, and — what the box can say on its own — lists what THIS store's tills refuse right now
 * from the signed catalogue it holds: a product blocked for one batch, and one blocked whole. Head office's own lists
 * (recalls, trace, call list) say they could not be reached rather than showing an empty "nothing" (P-08). The payload's
 * edges (no catalogue held, nobody named, permissions unknown) are proven by
 * tests/unit/the-box-serves-the-recall-trace-page.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['recall', 'trace', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';

function signedPack() {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 7, builtAt: new Date(Date.now() - 3_600_000).toISOString(), scope: { tenantId: TENANT, storeId: 'S1' },
    products: [
      { productId: 'P-PANEER', sku: 'PANEER', name: 'Paneer 200g', baseUom: 'ea', unitPriceMinor: 9_000, taxBps: 500, status: 'active', recallBlock: true, blockedBatches: ['B-1'] },
      { productId: 'P-CURD', sku: 'CURD', name: 'Curd 400g', baseUom: 'ea', unitPriceMinor: 6_000, taxBps: 500, status: 'active', recallBlock: true },
      { productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 7_000, taxBps: 0, status: 'active' },
    ],
    barcodes: [],
  };
  const result = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-owner', publishedAt: snapshot.builtAt });
  if (!result.ok || result.pack === undefined) throw new Error(result.detail);
  return result.pack;
}

describe.skipIf(!HAVE_BROWSER)('the Recalls and trace page served from the store box, with the line down', () => {
  let browser: Browser;
  const dirs: string[] = [];
  const stops: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 180_000);
  afterAll(async () => { await browser?.close(); });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('opens on the box with no cloud, says what this store\'s tills refuse now, in English and Tamil, and says head office could not be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-recall-box-')); dirs.push(dir);
    await writeSignedPack(dir, signedPack());
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1, lossPreventionRules: [], policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' },
      expiryPolicy: { nearExpiryDays: 2, userId: 'u-qc' },
      roles: [{ id: 'qc', name: 'Quality', permissions: ['quality.lottrace.read', 'quality.recall.read'] }],
      roleAssignments: [{ userId: 'u-qc', roleId: 'qc', branchScope: 'all' }],
    }), 'utf8');
    const edge: EdgeProcess = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
    }, () => {}))!;
    stops.push(() => edge.stop());
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    stops.push(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(`http://127.0.0.1:${edge.screens!.port}/recall-trace/`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await page.waitForSelector('#r-box:not([hidden])', { timeout: 10_000 });
    expect((await page.textContent('#whoami')) ?? '').toContain('u-qc');
    expect((await page.textContent('#r-box-h')) ?? '').toContain('What this store\'s tills refuse now');
    expect((await page.textContent('#r-box-asof')) ?? '').toContain('From catalogue v7 on this store computer');
    expect((await page.textContent('#r-box-rows li[data-product="P-PANEER"]')) ?? '').toContain('batches B-1');
    expect((await page.textContent('#r-box-rows li[data-product="P-CURD"]')) ?? '').toContain('every batch');
    expect(await page.locator('#r-box-rows li').count()).toBe(2);
    // Head office cannot be reached from here: its own list says so — never an empty "nothing has been started".
    await page.waitForFunction(() => (globalThis as unknown as { document: { getElementById(i: string): { hidden: boolean; textContent: string | null } | null } }).document.getElementById('r-none')?.hidden === false, undefined, { timeout: 10_000 });
    expect((await page.textContent('#r-none')) ?? '').toContain('Head office could not be read');
    // Tamil.
    await page.click('#lang');
    expect((await page.textContent('#r-box-h')) ?? '').toContain('பில் கவுண்டர்கள்');
    expect((await page.textContent('#r-box-rows li[data-product="P-CURD"]')) ?? '').toContain('எல்லாத் தொகுதிகளும்');
    // The page is on the box's menu, with the chrome every ERP page carries.
    expect(await page.locator('script[src="./sre-chrome.js"]').count()).toBe(1);
    expect(errors).toEqual([]);
  });
});
