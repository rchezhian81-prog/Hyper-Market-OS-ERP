import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { says } from './lib/r4c-box-page';

/**
 * **W3 (M11-FR-01 · M11-FR-03 · M11-FR-04) — production from a NEW shop, in a real browser, on the PRODUCTION API over real
 * PostgreSQL.** One connected run of the whole department journey, every figure head office's own:
 *   • the shop runs no production department yet: the Recipes page says so, and the store manager switches the café on from
 *     the page (M11-FR-04 — the page used to say "switch one on first" with no way to do it);
 *   • she adds the café's cake recipe (kilograms typed, grams held) — version 1 (M11-FR-01);
 *   • on the Production page she records a run of it, releases the batch for sale, and repacks part of it into a new batch
 *     that keeps the source's expiry; head office's lot trace shows the repack (M11-FR-03);
 *   • a cashier is offered no switch-on and no recipe form, and head office refuses the switch-on to him.
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w3', 'production', 'e2e', 'key'].join('-').padEnd(48, '0');
const CASHIER = 'u-cash';
const STORE = 'br-1';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('production from a new shop, on the production API (M11)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, branchId: STORE, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/production', html: 'production.html', dataGlobal: 'productionData', extraData: async () => ({ productionLocationId: STORE }) },
      alsoPages: [{ path: '/production-recipes', html: 'production-recipes.html', dataGlobal: 'productionRecipesData' }],
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier', undefined, [STORE]);
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        const at = new Date(Date.now() - 86_400_000).toISOString();
        for (const [id, qty] of [['FLOUR', 10_000], ['SUGAR', 5_000]] as const) {
          await ok(req('/v1/inventory/movements', { movementId: `rx-${id}`, productId: id, locationId: STORE, kind: 'received', quantityMinor: qty, uom: 'kg', occurredAt: at, enteredBy: OWNER, unitCostMinor: 5 }), `receive ${id}`);
        }
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, STORE);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.method() !== 'GET') writes.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, errors, close: () => context.close() };
  };

  it('switch the café on, add a recipe, record a run, release it and repack part of it — all on head office over PostgreSQL', async () => {
    const r = await open(MGR, '/production-recipes');
    // ── a new shop: no department runs yet, and the page says so beside the way to switch one on
    await says(r.page, '#cards', /Departments switched on\s*0/);
    await says(r.page, '#no-departments', /No production department is switched on/);
    await says(r.page, '#dept-rows li[data-department="cafe"]', /Café\s*Not switched on\s*Switch on/);
    expect(r.writes).toEqual([]);
    await r.page.click('#dept-on-cafe');
    await says(r.page, '#dept-status', /^Switched on: Café\.$/);
    await says(r.page, '#dept-rows li[data-department="cafe"]', /Café\s*Switched on$/);
    await says(r.page, '#cards', /Departments switched on\s*1/);
    expect(r.writes).toEqual(['POST /v1/production/departments/cafe']);
    const operated = (await call('GET', '/v1/production/departments', OWNER)).body as { operated: { departmentId: string }[] };
    expect(operated.operated.map((d) => d.departmentId)).toEqual(['cafe']);

    // ── the recipe, in the café
    expect(await r.page.inputValue('#r-department')).toBe('cafe');
    await r.page.fill('#r-code', 'coffee-cake');
    await r.page.fill('#r-product', 'CAKE');
    await r.page.fill('#r-qty', '10');
    await r.page.fill('#r-hours', '48');
    await r.page.fill('#in-product-0', 'FLOUR');
    await r.page.fill('#in-qty-0', '1.5');
    await r.page.click('#add-ingredient');
    await r.page.fill('#in-product-1', 'SUGAR');
    await r.page.fill('#in-qty-1', '0.5');
    await r.page.click('#save-recipe');
    await says(r.page, '#recipe-status', /^Recipe saved as version 1\.$/);
    const held = (await call('GET', '/v1/production/recipes', OWNER)).body as { recipes: { recipeId: string; departmentId: string; inputs: { productId: string; quantityMinor: number }[] }[] };
    expect(held.recipes).toEqual([expect.objectContaining({ recipeId: 'coffee-cake', departmentId: 'cafe', inputs: [expect.objectContaining({ productId: 'FLOUR', quantityMinor: 1_500 }), expect.objectContaining({ productId: 'SUGAR', quantityMinor: 500 })] })]);
    expect(r.errors).toEqual([]);
    await r.close();

    // ── the Production page: a run of two batches, released, then six cakes repacked
    const p = await open(MGR, '/production');
    await p.page.waitForSelector('#runner:not([hidden])');
    expect(await p.page.inputValue('#run-location')).toBe(STORE);
    await p.page.fill('#run-recipe', 'coffee-cake');
    await p.page.fill('#run-batches', '2');
    await p.page.fill('#run-output', '20');
    await p.page.fill('#run-batch', 'CAKE-1');
    await p.page.click('#run');
    await says(p.page, '#result-text', /Run recorded/);
    await p.page.waitForSelector('#rows button.release', { timeout: 15_000 });
    const runs = (await call('GET', '/v1/production/runs', OWNER)).body as { runs: { runId: string; outputBatchId?: string; released?: boolean }[] };
    const run = runs.runs.find((x) => x.outputBatchId === 'CAKE-1');
    expect(run, JSON.stringify(runs)).toBeDefined();
    await p.page.click('#rows button.release');
    await p.page.waitForFunction(() => (globalThis as unknown as { document: { querySelectorAll(s: string): { length: number } } }).document.querySelectorAll('#rows button.release').length === 0, undefined, { timeout: 15_000 });
    const after = (await call('GET', '/v1/production/runs', OWNER)).body as { runs: { runId: string; released?: boolean }[] };
    expect(after.runs.find((x) => x.runId === run!.runId)?.released).toBe(true);

    await p.page.waitForSelector('#repack:not([hidden])');
    await p.page.fill('#rp-department', 'cafe');
    await p.page.fill('#rp-product', 'CAKE');
    expect(await p.page.inputValue('#rp-location')).toBe(STORE);
    await p.page.fill('#rp-source', 'CAKE-1');
    await p.page.fill('#rp-new', 'CAKE-1-R1');
    await p.page.fill('#rp-qty', '6');
    await p.page.click('#repack-go');
    await says(p.page, '#repack-status', /^Repacked\. The new batch keeps expiry .+; it waits for its quality release below\.$/);
    const chain = (await call('GET', '/v1/quality/lot-trace/CAKE-1/chain', OWNER)).body as { rows: { hop: string }[] };
    expect(chain.rows.some((x) => x.hop === 'production_used' && JSON.stringify(x).includes('CAKE-1-R1'))).toBe(true);
    expect(p.writes).toEqual(expect.arrayContaining([
      expect.stringMatching(/^POST \/v1\/production\/runs\/[^/]+$/), `POST /v1/production/runs/${run!.runId}/release`,
    ]));
    expect(p.errors).toEqual([]);
    await p.close();
  }, 180_000);

  it('a cashier is offered no switch-on and no recipe form, and head office refuses the switch-on to him', async () => {
    const c = await open(CASHIER, '/production-recipes');
    await says(c.page, '#page-status', /\S/);
    expect(await c.page.isVisible('#editor')).toBe(false);
    expect(await c.page.locator('#dept-rows button').count()).toBe(0);
    expect(c.writes).toEqual([]);
    await c.close();
    const refused = await call('POST', '/v1/production/departments/kitchen', CASHIER, {});
    expect(refused.status).toBe(403);
  });
});
