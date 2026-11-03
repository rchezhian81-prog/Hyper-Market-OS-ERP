import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright-core';
import { startInboxShop, ok, OWNER, MGR, type InboxShop } from './lib/ai-inbox-shop';
import { says } from './lib/r4c-box-page';

/**
 * **W4 (M11-FR-01 · M11-FR-02 · M11-FR-03) — production is planned, costed for Finance and traced, in a real browser, on the
 * PRODUCTION API over real PostgreSQL.** Every figure is head office's own:
 *   • M11-FR-01 "plan production": on the Production page the store manager asks for the plan for her café; the cake has no
 *     sales to go by yet and the page SAYS so (never a silent 0). Its button only copies the recipe into the run form; she
 *     records the run herself (two batches, 14 cakes where the recipe expects 20). The plan wrote nothing.
 *   • M11-FR-03 "traceable": she types the cake batch and sees the flour batch that went into it (earliest expiry first),
 *     then types the flour batch and sees it went into the cake batch, with its sales.
 *   • M11-FR-02 §28 "costing reviewed by Finance": the ACCOUNTANT opens Production costs — the page asks its own word,
 *     `production.cost.read` — and sees the run's ingredient cost (head office's figure), its cost per cake, and the
 *     30 % yield shortfall as an EXCEPTION with its money (P-08). The accountant is refused the production board and plan
 *     (least privilege); a cashier is refused the costs.
 * Synthetic data, a fresh tenant. Needs DATABASE_URL and the pre-installed Chromium; without either it SKIPS.
 */

const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] ?? '/opt/pw-browsers/chromium';
const DATABASE_URL = process.env['DATABASE_URL'];
const KEY = ['w4', 'production', 'e2e', 'key'].join('-').padEnd(48, '0');
const ACCOUNTANT = 'u-acc';
const CASHIER = 'u-cash';
const STORE = 'br-1';

describe.skipIf(!existsSync(CHROMIUM) || DATABASE_URL === undefined)('production planned, costed for Finance and traced, on the production API (M11)', () => {
  let browser: Browser;
  let shop: InboxShop;
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown) =>
    shop.cloud().request({ method, path, userId, branchId: STORE, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }) });

  beforeAll(async () => {
    execFileSync('node', ['scripts/build-app.mjs', 'web-erp'], { stdio: 'ignore' });
    shop = await startInboxShop({
      databaseUrl: DATABASE_URL!, tenantId: randomUUID(), signingKey: KEY,
      page: { path: '/production', html: 'production.html', dataGlobal: 'productionData', extraData: async () => ({ productionLocationId: STORE }) },
      alsoPages: [{ path: '/production-costs', html: 'production-costs.html', dataGlobal: 'productionCostsData' }],
      seed: async (cloud) => {
        await cloud.grant(CASHIER, 'cashier', undefined, [STORE]);
        await cloud.grant(ACCOUNTANT, 'accountant', undefined, [STORE]);
        const req = (path: string, body: unknown) => cloud.request({ method: 'POST', path, userId: OWNER, body, idempotencyKey: `seed-${randomUUID()}` });
        const at = new Date(Date.now() - 86_400_000).toISOString();
        // ₹40 a kg of flour (batch FLOUR-B7), ₹50 a kg of sugar (no batch on the delivery)
        await ok(req('/v1/inventory/movements', { movementId: 'rx-FLOUR', productId: 'FLOUR', locationId: STORE, kind: 'received', quantityMinor: 10_000, uom: 'kg', occurredAt: at, enteredBy: OWNER, unitCostMinor: 4_000, batchId: 'FLOUR-B7' }), 'receive flour');
        await ok(req('/v1/inventory/movements', { movementId: 'rx-SUGAR', productId: 'SUGAR', locationId: STORE, kind: 'received', quantityMinor: 5_000, uom: 'kg', occurredAt: at, enteredBy: OWNER, unitCostMinor: 5_000 }), 'receive sugar');
        await ok(req('/v1/production/departments/cafe', {}), 'switch the café on');
        await ok(req('/v1/production/recipes/coffee-cake', {
          departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48, yieldToleranceBp: 500,
          inputs: [{ productId: 'FLOUR', quantityMinor: 1_500, uom: 'kg' }, { productId: 'SUGAR', quantityMinor: 500, uom: 'kg' }],
        }), 'the cake recipe');
      },
    });
    browser = await chromium.launch({ headless: true, executablePath: CHROMIUM });
  }, 300_000);
  afterAll(async () => { await browser?.close(); await shop?.stop(); });

  const open = async (who: string, path: string) => {
    const context = await browser.newContext();
    await shop.signIn(context, who, STORE);
    const page = await context.newPage();
    const writes: string[] = []; const reads: string[] = []; const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (!u.pathname.startsWith('/v1/')) return; (r.method() === 'GET' ? reads : writes).push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${shop.base}${path}`, { waitUntil: 'load' });
    return { page, writes, reads, errors, close: () => context.close() };
  };

  it('plan the café, record the run from it, trace the batch both ways, and Finance reviews its cost — all on head office over PostgreSQL', async () => {
    const p = await open(MGR, '/production');
    // ── M11-FR-01: the plan — advice only; the cake has no sales to go by, and the page says so
    await p.page.waitForSelector('#planner:not([hidden])');
    expect(await p.page.inputValue('#plan-location')).toBe(STORE);
    await p.page.click('#plan-go');
    await says(p.page, '#plan-status', /^Plan for \d{4}-\d{2}-\d{2} · learnt from sales \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    await says(p.page, '#plan-rows li[data-recipe="coffee-cake"]', /coffee-cake — CAKE.*No sales to go by yet — decide yourself.*Batches: 0/);
    expect(p.reads).toContain('GET /v1/production/plan');
    const madeBefore = p.writes.length;
    await p.page.click('#plan-rows li[data-recipe="coffee-cake"] button[data-use-recipe]');
    await says(p.page, '#plan-status', /put in the run form below/);
    expect(await p.page.inputValue('#run-recipe')).toBe('coffee-cake');
    expect(p.writes).toHaveLength(madeBefore); // the plan made nothing — a person records the run
    expect(p.writes.some((w) => w.includes('/v1/production/runs/'))).toBe(false);

    // ── she records the run herself: two batches, 14 cakes where the recipe expects 20
    await p.page.fill('#run-batches', '2');
    await p.page.fill('#run-output', '14');
    await p.page.fill('#run-batch', 'CAKE-1');
    await p.page.click('#run');
    await says(p.page, '#result-text', /Run recorded/);
    expect(p.writes.filter((w) => w.includes('/v1/production/runs/'))).toEqual([expect.stringMatching(/^POST \/v1\/production\/runs\/[^/]+$/)]);

    // ── M11-FR-03: what went into the cake batch, and forward from the flour batch
    await p.page.fill('#trace-batch', 'CAKE-1');
    await p.page.click('#trace-inputs');
    await says(p.page, '#trace-rows', /Ingredient batches in CAKE-1 \(CAKE\)/);
    await says(p.page, '#trace-rows', /FLOUR — FLOUR-B7 — 3(\.0+)? kg \(earliest expiry first\)/);
    await expect.poll(async () => p.page.locator('#trace-rows li[data-input-batch="FLOUR-B7"]').count()).toBe(1);
    await p.page.fill('#trace-batch', 'FLOUR-B7');
    await p.page.click('#trace-forward');
    await says(p.page, '#trace-rows li[data-output-batch="CAKE-1"]', /FLOUR-B7 went into CAKE-1 \(CAKE\).*sales: 0/);
    expect(p.reads).toEqual(expect.arrayContaining(['GET /v1/production/batches/CAKE-1/inputs', 'GET /v1/production/input-batches/FLOUR-B7/trace']));
    expect(p.writes.some((w) => /\/v1\/production\/(plan|batches|input-batches|costs)/.test(w))).toBe(false); // the plan and the trace only read
    expect(p.errors).toEqual([]);
    await p.close();

    // ── M11-FR-02: the accountant reviews the cost — head office's own figure, and the yield shortfall as an exception
    const held = (await call('GET', '/v1/production/costs', ACCOUNTANT)).body as { runs: { outputBatchId: string; valued: boolean; inputCostMinor: number | null; unitCostPerWholeMinor: number | null; yieldVerdict: string; exceptions: { kind: string }[] }[]; withExceptions: number };
    const cost = held.runs.find((r) => r.outputBatchId === 'CAKE-1');
    expect(cost, JSON.stringify(held)).toMatchObject({ valued: true, yieldVerdict: 'low_yield', exceptions: [expect.objectContaining({ kind: 'yield_variance' })] });
    expect(cost!.inputCostMinor).toBe(3 * 4_000 + 1 * 5_000); // 3 kg of flour at ₹40 + 1 kg of sugar at ₹50 (OB-68)
    const rupees = (m: number) => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const a = await open(ACCOUNTANT, '/production-costs');
    await says(a.page, '#cards', /Runs\s*1/);
    await says(a.page, '#cards', /Yield exceptions\s*1/);
    const row = '#cost-rows tr[data-batch="CAKE-1"]';
    await says(a.page, row, /Exception/);
    await says(a.page, row, new RegExp(rupees(cost!.inputCostMinor!).replace(/[.₹]/g, (c) => `\\${c}`)));
    await says(a.page, row, new RegExp(`${rupees(cost!.unitCostPerWholeMinor!).replace(/[.₹]/g, (c) => `\\${c}`)} per piece`));
    await says(a.page, row, /70\.00% — below the recipe · 6 ea less than the recipe expects.*\(worth ₹/);
    expect(await a.page.getAttribute(row, 'data-tone')).toBe('error');
    expect(a.reads).toContain('GET /v1/production/costs');
    expect(a.writes).toEqual([]);
    expect(a.errors).toEqual([]);
    await a.close();
    // least privilege: the accountant's word opens the costs, not the production board or the plan
    expect((await call('GET', '/v1/production/runs', ACCOUNTANT)).status).toBe(403);
    expect((await call('GET', `/v1/production/plan?locationId=${STORE}`, ACCOUNTANT)).status).toBe(403);
  }, 180_000);

  it('a cashier is told the costs are not for his role, sends nothing, and head office refuses him the costs', async () => {
    const c = await open(CASHIER, '/production-costs');
    await says(c.page, '#page-status', /Your role cannot see production costs\./);
    expect(c.reads).not.toContain('GET /v1/production/costs');
    expect(c.writes).toEqual([]);
    await c.close();
    expect((await call('GET', '/v1/production/costs', CASHIER)).status).toBe(403);
  });
});
