import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { writeSignedPack } from '../../edge/store-edge/src/signed-pack-file';
import { writeHeldWorkFeeds } from '../../edge/store-edge/src/work-feeds-file';
import { hmacSigner } from '../../services/catalogue/src/index';
import { publishPack } from '../../services/catalogue/src/pack';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **The production screen works at the counter with the line down, in a real browser on the REAL store box (OB-288 lane 2
 * · P2 · M11-FR-01/02/03 · §31 · P-01 · P-08).**
 *
 * The box is started with NO cloud at all and with what it last took from head office restored from its disk: the
 * production board and recipes (`work-feeds.json`) and the signed catalogue (`signed-pack.json`). At the actual screen a
 * person:
 *   • RECORDS a run — saved on this device, handed to the box, on the box's fsync'd device-events log in the cook's name,
 *     listed with the shared state words ("With the store computer"), and a reload sends nothing twice;
 *   • WEIGHS in and out — grams only, no price typed; more out than in is refused before it is saved;
 *   • RELEASES a batch — the decision saved the same way;
 *   • PRINTS a counter label from the box — the name and price are the catalogue's, the batch and use-by the run's (head
 *     office's board, or the run just saved here, its use-by from the recipe's shelf life); a label the box cannot vouch for
 *     is refused in words.
 * Head office booking each once is proven by tests/integration/the-store-box-keeps-offline-work-and-books-it-once.test.ts.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const HAVE_BROWSER = existsSync(CHROMIUM);
const KEY = ['production', 'counter', 'offline', 'signing', 'key'].join('-').padEnd(48, '0');
const TENANT = 't-sre';
const NOW = new Date().toISOString();
const HOUR = 3_600_000;

interface ProdWindow {
  readonly laneWriteBase?: string;
  readonly productionRelay?: unknown;
  readonly productionTasks?: { view(lang: 'en'): { saved: { kind: string; state: string; id: string }[]; labelFromBox: boolean; canWeigh: boolean } };
}

const PACK_JSON = JSON.stringify({
  version: 1, lossPreventionRules: [],
  policies: { tradingDayCutoff: '02:00', storeId: 'S1', branchId: 'S1' },
  productionPolicy: { userId: 'u-cook', permissions: ['production.read', 'production.plan.commit', 'production.release', 'production.recipe.manage'] },
});

async function boxWithHeldWork(dir: string): Promise<void> {
  const snapshot: CatalogueSnapshot = {
    tenantId: TENANT, version: 4, builtAt: NOW,
    products: [{ productId: 'CAKE', sku: 'CAKE', name: 'Plum cake', baseUom: 'ea', unitPriceMinor: 12_000, taxBps: 500, status: 'active' }],
    barcodes: [{ code: '8901234567890', productId: 'CAKE', kind: 'standard' }],
  };
  const published = publishPack({ snapshot, approvals: [], signer: hmacSigner(KEY), publishedBy: 'u-owner', publishedAt: NOW });
  if (!published.ok || published.pack === undefined) throw new Error(published.detail);
  await writeSignedPack(dir, published.pack);
  const asAt = new Date(Date.now() - 30 * 60_000).toISOString();
  await writeHeldWorkFeeds(dir, TENANT, {
    production: {
      receivedAt: asAt,
      feed: {
        name: 'production', asAt,
        body: {
          runs: [{ runId: 'run-ho', departmentId: 'cafe', outputProductId: 'CAKE', outputBatchId: 'CAKE-HO', outputQuantityMinor: 6, outputUom: 'ea', expiresAt: new Date(Date.now() + 40 * HOUR).toISOString(), at: new Date(Date.now() - 2 * HOUR).toISOString(), outputUnitCostMinor: 4_000, currency: 'INR', costKnown: true, uncostedProducts: [], yieldVerdict: 'as_expected', exceptions: [], released: false }],
          recipes: [{ recipeId: 'r-cake', departmentId: 'cafe', outputProductId: 'CAKE', outputUom: 'ea', shelfLifeHours: 48 }],
          enabledDepartments: ['cafe'],
        },
      },
    },
  });
}

describe.skipIf(!HAVE_BROWSER)('the production screen at the counter with the line down, on the real box (OB-288 lane 2 · P2)', () => {
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

  const ready = (page: Page) => page.waitForFunction(() => (globalThis as unknown as ProdWindow).productionTasks !== undefined && (globalThis as unknown as ProdWindow).productionRelay !== undefined, undefined, { timeout: 15_000 });
  const saved = (page: Page) => page.evaluate(() => (globalThis as unknown as ProdWindow).productionTasks!.view('en').saved);

  it('a run, a weigh and a release are saved through the box with no cloud; labels come from the box; a reload sends nothing twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-prod-e2e-')); dirs.push(dir);
    const packFile = join(dir, 'store-pack.json');
    await writeFile(packFile, PACK_JSON, 'utf8');
    await boxWithHeldWork(dir);
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
    await page.goto(`http://127.0.0.1:${edge.screens!.port}/production/`, { waitUntil: 'load' });
    await ready(page);
    expect(errors).toEqual([]);
    // Head office's board as the box last heard it, and how old it is (P-08) — the batch waiting for release is shown.
    expect((await page.textContent('#board-asof')) ?? '').toContain("Head office's board as the store computer last heard it");
    await page.waitForSelector('li.row[data-run-id="run-ho"]');

    // RECORD A RUN — saved here, handed to the box.
    await page.fill('#run-recipe', 'r-cake'); await page.fill('#run-batches', '2'); await page.fill('#run-output', '2');
    await page.fill('#run-batch', 'CAKE-77'); await page.fill('#run-location', 'S1-KITCHEN');
    await page.click('#run');
    await page.waitForSelector('#result:not([hidden])');
    expect((await page.textContent('#result-text')) ?? '').toContain('Run saved on this screen');
    await page.waitForFunction(() => (globalThis as unknown as ProdWindow).productionTasks!.view('en').saved.some((w) => w.kind === 'run' && w.state === 'handed_to_box'), undefined, { timeout: 10_000 });
    expect((await page.textContent('#saved-rows')) ?? '').toContain('With the store computer');

    // WEIGH — more out than in is refused before it is saved; then a good weigh is saved.
    for (const [id, v] of [['#weigh-dept', 'meat_fish'], ['#weigh-in', 'CHICKEN'], ['#weigh-in-g', '1000'], ['#weigh-out', 'CUTS'], ['#weigh-out-g', '1200']]) await page.fill(id, v);
    await page.click('#weigh');
    expect((await page.textContent('#result-text')) ?? '').toContain('More came out than went in');
    await page.fill('#weigh-out-g', '800');
    await page.click('#weigh');
    expect((await page.textContent('#result-text')) ?? '').toContain('Weights saved on this screen');

    // RELEASE head office's waiting batch — a decision saved the same way.
    await page.click('li.row[data-run-id="run-ho"] button.release');
    await page.waitForFunction(() => ((document.getElementById('result-text')?.textContent) ?? '').includes('Decision saved on this screen'), undefined, { timeout: 5_000 });
    await page.waitForFunction(() => (globalThis as unknown as ProdWindow).productionTasks!.view('en').saved.filter((w) => w.state === 'handed_to_box').length === 3, undefined, { timeout: 10_000 });

    // On the box's own disk, in the cook's name, in order.
    const records = (await readLog(edge.deviceEventsLog.path)).filter((r) => r.ok).map((r) => JSON.parse(r.ok ? r.record : '{}') as { type: string; payload: Record<string, unknown> });
    expect(records.map((r) => r.type)).toEqual(['ProductionRunCaptured', 'WeighedRunCaptured', 'ProductionReleaseDecided']);
    expect(records[0]?.payload).toMatchObject({ storeId: 'S1', recipeId: 'r-cake', batches: 2, actualOutputMinor: 2, outputBatchId: 'CAKE-77', locationId: 'S1-KITCHEN', producedBy: 'u-cook', source: 'production-screen' });
    expect(records[1]?.payload).toMatchObject({ storeId: 'S1', departmentId: 'meat_fish', inputs: [{ productId: 'CHICKEN', weightGrams: 1000 }], outputs: [{ productId: 'CUTS', weightGrams: 800 }], weighedBy: 'u-cook' });
    expect(JSON.stringify(records[1]?.payload)).not.toContain('costPerKg'); // no price typed at the counter
    expect(records[2]?.payload).toMatchObject({ runId: 'run-ho', qcPassed: true, releasedBy: 'u-cook' });

    // LABEL from the box: head office's run — name and price are the catalogue's, no name or price box on the form.
    expect(await page.isHidden('#label-name')).toBe(true);
    expect(await page.isHidden('#label-price')).toBe(true);
    await page.selectOption('#label-run', 'run-ho');
    await page.fill('#label-net', '1 piece'); await page.fill('#label-packer', 'SRE Hyper Market, Tamil Nadu'); await page.fill('#label-allergens', 'cereals_gluten, eggs');
    await page.click('#label');
    await page.waitForSelector('#label-out:not([hidden])');
    const printed = (await page.textContent('#label-out')) ?? '';
    expect(printed).toContain('Plum cake'); expect(printed).toContain('Batch CAKE-HO'); expect(printed).toContain('INR 120.00'); expect(printed).toContain('8901234567890');
    // …and the run just saved here, before head office has it: its use-by from the recipe (made now + 48 h).
    const runId = (await saved(page)).find((w) => w.kind === 'run')!.id;
    await page.selectOption('#label-run', runId);
    await page.click('#label');
    await page.waitForFunction(() => ((document.getElementById('label-out')?.textContent) ?? '').includes('Batch CAKE-77'), undefined, { timeout: 5_000 });
    // A label with no allergen declaration is refused in words; nothing printed.
    await page.fill('#label-allergens', '');
    await page.click('#label');
    await page.waitForFunction(() => ((document.getElementById('result-text')?.textContent) ?? '').includes('allergen declaration'), undefined, { timeout: 5_000 });
    expect(await page.isHidden('#label-out')).toBe(true);

    // RELOAD: all three still listed with the box's word; nothing re-sent to the box.
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForFunction(() => (globalThis as unknown as ProdWindow).productionTasks!.view('en').saved.length === 3, undefined, { timeout: 10_000 });
    expect(edge.deviceEventsOutbox.all()).toHaveLength(3);
  });
});
