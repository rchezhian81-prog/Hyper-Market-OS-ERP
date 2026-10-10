import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **FUL-01 — production moves ORDINARY stock (audit HIGH · M11-FR-01/02/03 · M08-FR-01/02/04 · hard rule #2).**
 *
 * The audit ran a production run and a quality release and found the shop's availability unchanged — FLOUR 500 / SUGAR 300
 * before and after, the finished CAKE nowhere — because production kept its consumption on a private stream. Now:
 *   receive ingredients → a run uses them up (they leave the ordinary M08 position in the same write as the run) → the finished
 *   batch waits in quarantine (not on hand, not sellable) → quality releases it (on hand, with its batch and expiry, at the
 *   run's own cost) → a sale draws it down — and the valuation reconciles: the ingredients' value moved into the cakes, none of
 *   it was spent twice. Two runs judged on the same flour cannot both use it. The plain movements route cannot type a
 *   production movement. In-memory store and, with DATABASE_URL, real PostgreSQL. Synthetic data only.
 */

const KITCHEN = 'KITCHEN';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function kitchen(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-chef', 'store_manager');
  await h.provisionRole(t, 'u-qc', 'store_manager');
  const receive = async (productId: string, qty: number, unitCostMinor: number) => expect((await call('POST', '/v1/inventory/movements', 'u-owner', {
    movementId: `rcv-${productId}`, productId, locationId: KITCHEN, kind: 'received', quantityMinor: qty, uom: 'g', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor,
  }, `rcv-${productId}`)).status).toBeLessThan(300);
  await receive('FLOUR', 500, 5);
  await receive('SUGAR', 300, 8);
  expect((await call('POST', '/v1/production/departments/cafe', 'u-owner', {}, 'dept')).status).toBeLessThan(300);
  // The production cost register at the same figures the deliveries cost — so the value moved can be reconciled exactly.
  expect((await call('POST', '/v1/production/costs/FLOUR', 'u-owner', { unitCostMinor: 5, currency: 'INR' }, 'c-f')).status).toBeLessThan(300);
  expect((await call('POST', '/v1/production/costs/SUGAR', 'u-owner', { unitCostMinor: 8, currency: 'INR' }, 'c-s')).status).toBeLessThan(300);
  expect((await call('POST', '/v1/production/recipes/cake', 'u-owner', {
    departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea',
    inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }, { productId: 'SUGAR', quantityMinor: 50, uom: 'g' }],
    shelfLifeHours: 48, expectedYieldBp: 10_000, yieldToleranceBp: 500,
  }, 'recipe')).status).toBe(201);
  const onHand = async (productId: string): Promise<number> =>
    ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows
      .filter((r) => r.locationId === KITCHEN).reduce((n, r) => n + r.onHandMinor, 0);
  const valuation = async (): Promise<{ byProduct: Record<string, number>; total: number; unvalued: Record<string, number> }> => {
    const v = (await call('GET', '/v1/inventory/valuation', 'u-owner')).body as { rows: { productId: string; locationId: string; value: { minor: number }; unvaluedMinor?: number }[]; totalValueMinor: number };
    const byProduct: Record<string, number> = {};
    const unvalued: Record<string, number> = {};
    for (const r of v.rows.filter((x) => x.locationId === KITCHEN)) {
      byProduct[r.productId] = (byProduct[r.productId] ?? 0) + r.value.minor;
      unvalued[r.productId] = (unvalued[r.productId] ?? 0) + (r.unvaluedMinor ?? 0);
    }
    return { byProduct, total: v.totalValueMinor, unvalued };
  };
  const run = (runId: string, batches: number, key = runId) => call('POST', `/v1/production/runs/${runId}`, 'u-chef', { recipeId: 'cake', batches, actualOutputMinor: batches, outputBatchId: `CAKE-${runId}`, locationId: KITCHEN, currency: 'INR' }, key);
  return { call, onHand, valuation, run };
}

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

describe.each(backings)('FUL-01 — production moves ordinary stock — on $name', ({ harness }) => {
  it('receive → make (ingredients leave the shelf, the cakes wait in quarantine) → release (on hand at the run\'s cost, with batch and expiry) → sell; the value reconciles', async () => {
    const h = harness();
    const t = randomUUID();
    const k = await kitchen(h, t);
    expect(await k.valuation()).toMatchObject({ byProduct: { FLOUR: 2_500, SUGAR: 2_400 } });

    // The audit's case: run 2 batches. The ingredients LEAVE the ordinary position — every reader sees it.
    const made = await k.run('run-1', 2);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ outputQuantityMinor: 2, inputCostMinor: 1_800, outputUnitCostMinor: 900, costKnown: true });
    expect(await k.onHand('FLOUR')).toBe(300);
    expect(await k.onHand('SUGAR')).toBe(200);
    expect(await k.onHand('CAKE')).toBe(0); // in quarantine: made, not sellable
    let v = await k.valuation();
    expect(v.byProduct).toMatchObject({ FLOUR: 1_500, SUGAR: 1_600 });
    expect(v.byProduct['CAKE'] ?? 0).toBe(0);
    // The same run sent again is the same run — the flour does not leave twice.
    expect((await k.run('run-1', 2, 'run-1-again')).status).toBe(409);
    expect(await k.onHand('FLOUR')).toBe(300);

    // A failed check keeps the batch out of stock; a pass releases it — on hand, at the run's own cost.
    expect(codeOf(await k.call('POST', '/v1/production/runs/run-1/release', 'u-qc', { qcPassed: false }, 'rel-fail'))).toBe('qc_failed');
    expect(await k.onHand('CAKE')).toBe(0);
    const released = await k.call('POST', '/v1/production/runs/run-1/release', 'u-qc', { qcPassed: true }, 'rel-ok');
    expect(released.status).toBe(200);
    expect(await k.onHand('CAKE')).toBe(2);
    v = await k.valuation();
    expect(v.byProduct).toMatchObject({ FLOUR: 1_500, SUGAR: 1_600, CAKE: 1_800 });
    // Value conserved: what the ingredients lost (1,000 + 800), the cakes carry — nothing spent, nothing created.
    expect(v.byProduct['FLOUR']! + v.byProduct['SUGAR']! + v.byProduct['CAKE']!).toBe(2_500 + 2_400);
    // The batch and its expiry are on the ordinary position (FEFO, recalls and holds read these).
    expect(released.body).toMatchObject({ released: true, batchId: 'CAKE-run-1' });

    // A sale draws a cake down; its cost of goods is the cake's, not the flour's.
    expect((await k.call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'sale-1', productId: 'CAKE', locationId: KITCHEN, kind: 'sold', quantityMinor: 1, uom: 'ea', occurredAt: new Date(Date.now() + 1000).toISOString(), enteredBy: 'u-owner' }, 'sale-1')).status).toBeLessThan(300);
    expect(await k.onHand('CAKE')).toBe(1);
    expect((await k.valuation()).byProduct['CAKE']).toBe(900);

    // A production movement cannot be typed on the plain movements route.
    const typed = await k.call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'fake-produced', productId: 'CAKE', locationId: KITCHEN, kind: 'produced', quantityMinor: 50, uom: 'ea', occurredAt: '2026-10-02T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 1 }, 'fake');
    expect(codeOf(typed)).toBe('production_uses_the_production_routes');
    expect(await k.onHand('CAKE')).toBe(1);
  }, 60_000);

  it('FUL-13: production → label → a TILL SALE of that batch — the run, its release, the label (batch, use-by, price) and the sale on /v1/sales agree; the cake leaves the shelf at its own cost', async () => {
    const h = harness();
    const t = randomUUID();
    const k = await kitchen(h, t);
    expect((await k.run('run-L', 2)).status).toBe(201);
    // Before release a label prints but the batch is not sellable (quarantine) — the label never makes stock.
    const label = await k.call('POST', '/v1/production/runs/run-L/label', 'u-owner', { productName: 'Coffee cake', netQuantity: '180 g', packerDetails: 'SRE Hyper Market, TN', priceMinor: 12_000, allergens: ['wheat', 'milk'] }, 'lbl-L');
    expect(label.status, JSON.stringify(label.body)).toBe(200);
    const lines = (label.body as { batchId: string; lines: string[] }).lines.join('\n');
    expect(label.body).toMatchObject({ runId: 'run-L', batchId: 'CAKE-run-L' });
    expect(lines).toContain('Coffee cake');
    expect(lines).toContain('CAKE-run-L');
    expect(await k.onHand('CAKE')).toBe(0);
    expect((await k.call('POST', '/v1/production/runs/run-L/release', 'u-qc', { qcPassed: true }, 'rel-L')).status).toBe(200);
    expect(await k.onHand('CAKE')).toBe(2);
    const runs = (await k.call('GET', '/v1/production/runs', 'u-owner')).body as { runs: { runId: string; outputBatchId: string; expiresAt: string }[] };
    const made = runs.runs.find((r) => r.runId === 'run-L')!;
    expect(lines).toContain(made.expiresAt.slice(0, 10)); // the use-by the label carries is the run's own

    // The till sells one labelled cake: the sale names the label's batch and price; the box sends it to head office.
    const committedAt = new Date(Date.now() + 1_000).toISOString();
    const sale = await k.call('POST', '/v1/sales', 'u-owner', {
      saleId: 'S-cake', receiptNumber: 'R-cake', laneId: 'lane-1', cashierId: 'u-owner', locationId: KITCHEN, tradingDay: committedAt.slice(0, 10), committedAt,
      totalMinor: 12_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'CAKE', quantityMinor: 1, uom: 'ea', unitPriceMinor: 12_000, lineTotalMinor: 12_000, batchId: made.outputBatchId, batchExpiry: made.expiresAt.slice(0, 10) }],
      tenders: [{ kind: 'cash', amountMinor: 12_000 }],
    }, 'sale-cake');
    expect(sale.status, JSON.stringify(sale.body)).toBe(202);
    expect(await k.onHand('CAKE')).toBe(1);
    // Its cost of goods is the cake's (₹9.00 from the run), not the flour's; the rest stays valued at the run's cost.
    expect((await k.valuation()).byProduct['CAKE']).toBe(900);
    const batches = (await k.call('GET', '/v1/inventory/batches', 'u-owner', undefined, undefined, { locationId: KITCHEN, productId: 'CAKE' })).body as { batches: { batchId: string; onHandMinor: number }[] };
    expect(batches.batches).toEqual([expect.objectContaining({ batchId: 'CAKE-run-L', onHandMinor: 1 })]);
  }, 60_000);

  it('FUL-08: a recipe edit that keeps the same number of ingredients is a NEW version (100 g → 150 g flour); the same recipe again is no new version; going back is a version too; each run names the version it used', async () => {
    const h = harness();
    const t = randomUUID();
    const k = await kitchen(h, t);
    const recipe = (flour: number, key: string) => k.call('POST', '/v1/production/recipes/cake', 'u-owner', {
      departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea',
      inputs: [{ productId: 'FLOUR', quantityMinor: flour, uom: 'g' }, { productId: 'SUGAR', quantityMinor: 50, uom: 'g' }],
      shelfLifeHours: 48, expectedYieldBp: 10_000, yieldToleranceBp: 500,
    }, key);
    const same = await recipe(100, 'r-same');
    expect(same.body).toMatchObject({ version: 1, changed: false });
    const edited = await recipe(150, 'r-150');
    expect(edited.status).toBe(201);
    expect(edited.body).toMatchObject({ version: 2, changed: true });
    expect((edited.body as { digest: string }).digest).not.toBe((same.body as { digest: string }).digest);
    // The next run makes to the EDITED recipe: 150 g flour a batch.
    expect((await k.run('run-v2', 1)).status).toBe(201);
    expect(await k.onHand('FLOUR')).toBe(350);
    const runs = (await k.call('GET', '/v1/production/runs', 'u-owner', undefined, undefined, { locationId: KITCHEN })).body as { runs: { runId: string; recipeDigest?: string }[] };
    expect(runs.runs.find((r) => r.runId === 'run-v2')?.recipeDigest).toBe((edited.body as { digest: string }).digest);
    // Going back to 100 g is a third version — never a silent collapse onto the history.
    expect((await recipe(100, 'r-back')).body).toMatchObject({ version: 3, changed: true });
    expect((await k.run('run-v3', 1)).status).toBe(201);
    expect(await k.onHand('FLOUR')).toBe(250);
  }, 60_000);

  it('two runs judged on the same flour at once: never more flour used than there is — the loser is refused by name', async () => {
    const h = harness();
    const t = randomUUID();
    const k = await kitchen(h, t);
    // 500 g flour; each run of 3 batches needs 300 g.
    const [a, b] = await Promise.all([k.run('run-a', 3), k.run('run-b', 3)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    const lost = a.status === 201 ? b : a;
    expect(['concurrent_change', 'production_short']).toContain(codeOf(lost));
    expect(await k.onHand('FLOUR')).toBe(200);
    expect(await k.onHand('SUGAR')).toBe(150);
  }, 60_000);
});
