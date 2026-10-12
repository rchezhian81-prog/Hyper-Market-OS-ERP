import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/day-book';
import { averageBuyingCosts } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **OB-68 "A" (owner, 11 Oct 2026, in writing, "Production run's cost") — goods made in the store (FUL-13 · M11-FR-01/02 ·
 * OB-39 · OB-56 · M23 · WF-18 · P-08) are valued at their production run's own cost.**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL), one month at store S1's bakery:
 * flour 5 kg @ ₹40/kg and sugar 1 kg @ ₹60/kg are bought (₹260). A run makes 20 buns from 1 kg flour and 200 g sugar —
 * the run records its unit cost from the ingredients it consumed at the OB-39 average buying cost (₹40 + ₹12 = ₹52 → ₹2.60
 * a bun), each ingredient's source named. Quality releases them; 15 buns sell at ₹5 (+5% GST). Then:
 *   • the store's average cost of a bun is ₹2.60 (the store setup and the margin reports read the same rule);
 *   • the month-end stock valuation values the 5 buns left at ₹2.60 — the OB-56 adjustment no longer refuses them — and
 *     books cost of goods sold ₹39.00 = exactly the 15 buns sold (purchases ₹260 − closing ₹221: flour 4 kg ₹160, sugar
 *     800 g ₹48, buns ₹13); the P&L's gross margin is ₹36 on ₹75 (48%); the close's stock check agrees with the books.
 *   • A run whose ingredient has NO cost (butter received with none) records itself "not valued", naming butter; its
 *     cookies carry no cost; the month-end adjustment refuses, naming the cookies — never valued at zero.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const PERIOD = new Date().toISOString().slice(0, 7);
const TODAY = new Date().toISOString().slice(0, 10);

async function bakery(harness: () => ApiHarness) {
  const h = harness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-baker', 'store_manager');
  await h.provisionRole(T, 'u-qc', 'store_manager');
  await h.provisionRole(T, 'u-acct', 'accountant');
  await h.enableFeature(T, 'dept.bakery');
  let n = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${n += 1}` }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
  await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
  await ok(call('POST', '/v1/production/departments/bakery', 'u-owner', {}), 'bakery on');
  const receive = (id: string, productId: string, grams: number, perKgMinor?: number) => ok(call('POST', '/v1/inventory/movements', 'u-owner', {
    movementId: id, productId, locationId: 'S1', kind: 'received', quantityMinor: grams, uom: 'kg', occurredAt: `${TODAY}T01:00:00.000Z`, enteredBy: 'u-owner', ...(perKgMinor === undefined ? {} : { unitCostMinor: perKgMinor }),
  }), id);
  return { h, T, call, ok, receive };
}

describe.each(backings)('OB-68 — goods made in the store are valued at their production run\'s cost — on $name', ({ harness }) => {
  it('a bakery run records its cost from the ingredients at their average; the buns sell; the month end values them and books gross margin', async () => {
    const { h, T, call, ok, receive } = await bakery(harness);
    await receive('rcv-flour', 'FLOUR', 5_000, 4_000); // 5 kg @ ₹40/kg
    await receive('rcv-sugar', 'SUGAR', 1_000, 6_000); // 1 kg @ ₹60/kg
    await ok(call('POST', '/v1/production/recipes/bun', 'u-owner', {
      departmentId: 'bakery', outputProductId: 'BUN', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48,
      inputs: [{ productId: 'FLOUR', quantityMinor: 500, uom: 'kg' }, { productId: 'SUGAR', quantityMinor: 100, uom: 'kg' }],
    }), 'recipe');

    // ── The run: 2 batches, 20 buns. Its cost is the ingredients it consumed at the OB-39 average — recorded on the run.
    const made = await ok(call('POST', '/v1/production/runs/run-1', 'u-baker', { recipeId: 'bun', batches: 2, actualOutputMinor: 20, outputBatchId: 'BUN-1', locationId: 'S1' }), 'run');
    expect(made.body).toMatchObject({ inputCostMinor: 5_200, outputUnitCostMinor: 260, costKnown: true, uncostedProducts: [] });
    const rc = (made.body as { runCost: { valued: boolean; inputCostMinor: number; unitCostPerWholeMinor: number; lines: { productId: string; quantityMinor: number; source: string; unitCostMinor: number; valueMinor: number }[] } }).runCost;
    expect(rc).toMatchObject({ valued: true, inputCostMinor: 5_200, unitCostPerWholeMinor: 260, notValuedBecause: [] });
    expect(rc.lines.map((l) => [l.productId, l.quantityMinor, l.source, l.unitCostMinor, l.valueMinor])).toEqual([
      ['FLOUR', 1_000, 'average_buying_cost', 4_000, 4_000], ['SUGAR', 200, 'average_buying_cost', 6_000, 1_200],
    ]);
    // On the run's register too.
    const runs = (await call('GET', '/v1/production/runs', 'u-owner')).body as { runs: { runId: string; runCost?: { unitCostPerWholeMinor: number } }[] };
    expect(runs.runs.find((r) => r.runId === 'run-1')?.runCost?.unitCostPerWholeMinor).toBe(260);
    await ok(call('POST', '/v1/production/runs/run-1/release', 'u-qc', { qcPassed: true }), 'release');

    // ── The store's average cost of a bun is the run's cost (the store setup and the margin reports read this rule).
    const avg = await averageBuyingCosts({ store: h.store, now: () => new Date().toISOString() }, T);
    expect(avg.costOf('BUN', 'S1')).toBe(260);
    expect(avg.costOf('FLOUR', 'S1')).toBe(4_000);

    // ── 15 buns sell at ₹5 + 5% GST.
    await ok(call('POST', '/v1/sales', 'u-owner', {
      saleId: 'SL-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-owner', locationId: 'S1', tradingDay: TODAY, committedAt: `${TODAY}T05:00:00.000Z`,
      totalMinor: 7_875, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'BUN', quantityMinor: 15, uom: 'ea', unitPriceMinor: 525, lineTotalMinor: 7_875, taxRateBps: 500 }],
      tenders: [{ kind: 'cash', amountMinor: 7_875 }],
    }), 'sale');

    // ── The month end: the buns are valued at the run's cost — not refused; cost of goods sold is exactly the 15 sold.
    await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', DEFAULT_RETAIL_POSTING_MAP), 'map');
    await ok(call('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-owner', undefined), 'day book');
    const preview = (await call('GET', `/v1/finance/periods/${PERIOD}/stock-valuation`, 'u-acct')).body as { valuation: { closing: { productId: string; onHandMinor: number; unitCostMinor: number | null; valueMinor: number | null }[]; unvalued: unknown[]; closingValueMinor: number; purchases: { purchasesMinor: number } } };
    expect(preview.valuation.unvalued).toEqual([]);
    expect(preview.valuation.closing.map((l) => [l.productId, l.onHandMinor, l.unitCostMinor, l.valueMinor])).toEqual([
      ['BUN', 5, 260, 1_300], ['FLOUR', 4_000, 4_000, 16_000], ['SUGAR', 800, 6_000, 4_800],
    ]);
    expect(preview.valuation.purchases.purchasesMinor).toBe(26_000); // a production run is not a purchase
    const adj = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    expect((adj.body as { posted: { stockPeriod: Record<string, number> } }).posted.stockPeriod).toMatchObject({ booksInventoryBeforeMinor: 0, purchasesMinor: 26_000, closingValueMinor: 22_100, costOfSalesMinor: 3_900 });

    const suggested = ((await call('GET', '/v1/finance/account-classes', 'u-acct')).body as { suggested: Record<string, string> }).suggested;
    await ok(call('PUT', '/v1/finance/account-classes', 'u-owner', { classes: suggested }), 'classes');
    const pl = (await call('GET', `/v1/finance/periods/${PERIOD}/profit-and-loss`, 'u-acct')).body as { grossMargin: Record<string, number>; notInTheBooks: string[] };
    expect(pl.grossMargin).toEqual({ revenueMinor: 7_500, costOfSalesMinor: 3_900, grossMarginMinor: 3_600, marginBps: 4_800 });
    const ev = (await call('GET', `/v1/finance/periods/${PERIOD}/independent-evidence`, 'u-acct')).body as { checks: { name: string; leftMinor: number; rightMinor: number }[] };
    expect(ev.checks.find((c) => c.name === `Stock value at the close of ${PERIOD}`)).toMatchObject({ leftMinor: 22_100, rightMinor: 22_100 });
  }, 120_000);

  it('a run whose ingredient has no cost is "not valued" by name — its output carries no cost and the month end names it, never zero', async () => {
    const { call, ok, receive } = await bakery(harness);
    await receive('rcv-flour', 'FLOUR', 2_000, 4_000);
    await receive('rcv-butter', 'BUTTER', 1_000); // received with NO cost
    await ok(call('POST', '/v1/production/recipes/cookie', 'u-owner', {
      departmentId: 'bakery', outputProductId: 'COOKIE', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 72,
      inputs: [{ productId: 'FLOUR', quantityMinor: 500, uom: 'kg' }, { productId: 'BUTTER', quantityMinor: 200, uom: 'kg' }],
    }), 'recipe');
    const made = await ok(call('POST', '/v1/production/runs/run-c', 'u-baker', { recipeId: 'cookie', batches: 1, actualOutputMinor: 10, outputBatchId: 'CK-1', locationId: 'S1' }), 'run');
    expect(made.body).toMatchObject({ costKnown: false, uncostedProducts: ['BUTTER'], runCost: { valued: false, inputCostMinor: null, unitCostPerWholeMinor: null, notValuedBecause: ['BUTTER'] } });
    await ok(call('POST', '/v1/production/runs/run-c/release', 'u-qc', { qcPassed: true }), 'release');
    await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', DEFAULT_RETAIL_POSTING_MAP), 'map');
    const v = (await call('GET', `/v1/finance/periods/${PERIOD}/stock-valuation`, 'u-acct')).body as { valuation: { unvalued: { productId: string; onHandMinor: number; valueMinor: number | null }[] } };
    expect(v.valuation.unvalued.map((l) => [l.productId, l.onHandMinor, l.valueMinor])).toEqual([['BUTTER', 800, null], ['COOKIE', 10, null]]);
    const adj = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(codeOf(adj)).toBe('stock_not_valued');
    expect((adj.body as { error: { whatHappened: string } }).error.whatHappened).toContain('COOKIE at S1 (10 ea on hand)');
  }, 120_000);

  it('OB-68 / OB-70: a product with a VALUED run and a NOT-VALUED run — the not-valued run\'s units are listed by run, never priced at the other run\'s average', async () => {
    const { h, T, call, ok, receive } = await bakery(harness);
    await receive('rcv-flour', 'FLOUR', 2_000, 4_000); // 2 kg @ ₹40/kg
    await receive('rcv-butter-1', 'BUTTER', 500); // butter received with NO cost — and no registered cost (OB-70 has nothing to fall back to)
    await ok(call('POST', '/v1/production/recipes/cookie', 'u-owner', {
      departmentId: 'bakery', outputProductId: 'COOKIE', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 72,
      inputs: [{ productId: 'FLOUR', quantityMinor: 500, uom: 'kg' }, { productId: 'BUTTER', quantityMinor: 200, uom: 'kg' }],
    }), 'recipe');
    // Run 1: butter has no cost anywhere — the run is NOT valued; its 10 cookies carry no cost.
    const nv = await ok(call('POST', '/v1/production/runs/run-nv', 'u-baker', { recipeId: 'cookie', batches: 1, actualOutputMinor: 10, outputBatchId: 'CK-NV', locationId: 'S1' }), 'run nv');
    expect(nv.body).toMatchObject({ costKnown: false, runCost: { valued: false, notValuedBecause: ['BUTTER'] } });
    await ok(call('POST', '/v1/production/runs/run-nv/release', 'u-qc', { qcPassed: true }), 'release nv');
    // Butter bought at a cost (₹500/kg): run 2 IS valued — ₹20 flour + ₹100 butter = ₹120 for 10 cookies, ₹12 each.
    await receive('rcv-butter-2', 'BUTTER', 1_000, 50_000);
    const v = await ok(call('POST', '/v1/production/runs/run-v', 'u-baker', { recipeId: 'cookie', batches: 1, actualOutputMinor: 10, outputBatchId: 'CK-V', locationId: 'S1' }), 'run v');
    expect(v.body).toMatchObject({ costKnown: true, runCost: { valued: true, inputCostMinor: 12_000 } });
    await ok(call('POST', '/v1/production/runs/run-v/release', 'u-qc', { qcPassed: true }), 'release v');
    // The product HAS an average now — from the valued run only (₹12 a cookie).
    expect((await averageBuyingCosts({ store: h.store, now: () => new Date().toISOString() }, T)).costOf('COOKIE', 'S1')).toBe(1_200);
    await ok(call('PUT', '/v1/finance/posting-map', 'u-owner', DEFAULT_RETAIL_POSTING_MAP), 'map');

    // Month end: 20 cookies on hand. The valued run's 10 at ₹12; the not-valued run's 10 are their own line, unvalued, named.
    type Line = { productId: string; onHandMinor: number; unitCostMinor: number | null; valueMinor: number | null; notValuedRuns?: string[] };
    const val = async () => ((await call('GET', `/v1/finance/periods/${PERIOD}/stock-valuation`, 'u-acct')).body as { valuation: { closing: Line[]; unvalued: Line[] } }).valuation;
    let valuation = await val();
    expect(valuation.closing.filter((l) => l.productId === 'COOKIE').map((l) => [l.onHandMinor, l.unitCostMinor, l.valueMinor, l.notValuedRuns ?? null])).toEqual([
      [10, 1_200, 12_000, null], [10, null, null, ['run-nv']],
    ]);
    expect(valuation.unvalued.map((l) => [l.productId, l.onHandMinor, l.notValuedRuns])).toEqual([['COOKIE', 10, ['run-nv']]]);
    const refused = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(codeOf(refused)).toBe('stock_not_valued');
    expect((refused.body as { error: { whatHappened: string } }).error.whatHappened).toContain('COOKIE at S1 (10 ea on hand) — made by production run(s) run-nv, not valued');

    // 10 cookies sell: stock on hand is the latest arrivals (the valued run's) — the not-valued units have left stock, so
    // nothing is unvalued any more and the month's adjustment posts.
    await ok(call('POST', '/v1/sales', 'u-owner', {
      saleId: 'SL-C', receiptNumber: 'R-C', laneId: 'lane-1', cashierId: 'u-owner', locationId: 'S1', tradingDay: TODAY, committedAt: `${TODAY}T05:00:00.000Z`,
      totalMinor: 2_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'COOKIE', quantityMinor: 10, uom: 'ea', unitPriceMinor: 200, lineTotalMinor: 2_000, taxRateBps: 0 }],
      tenders: [{ kind: 'cash', amountMinor: 2_000 }],
    }), 'sale');
    valuation = await val();
    expect(valuation.unvalued).toEqual([]);
    expect(valuation.closing.filter((l) => l.productId === 'COOKIE').map((l) => [l.onHandMinor, l.unitCostMinor, l.valueMinor])).toEqual([[10, 1_200, 12_000]]);
    await ok(call('POST', `/v1/finance/day-book/${TODAY}/post`, 'u-owner', undefined), 'day book');
    const adj = await call('POST', `/v1/finance/periods/${PERIOD}/stock-adjustment`, 'u-acct', {});
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
  }, 120_000);
});
