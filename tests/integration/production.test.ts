import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// In-store production (M11-FR-01, API-04) end to end through the real API. A production run is two
// halves on one stock truth: ingredients consumed (stock out) and a finished batch created (stock in,
// into quarantine until quality releases it). The authoritative rules are the pure `produceBatch`
// engine — this proves they are reachable, authorized and persisted: a run cannot issue more than is
// on hand (refused before anything is consumed), the finished batch carries its own batch id and
// expiry, repeated runs deplete the shelf (prior consumption is layered on M08), and a run id is used
// once.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const seedOnHand = (h: ApiHarness, t: string, u: string, productId: string, qty: number) => {
  const movementId = `mv-${productId}`;
  return h.request({
    method: 'POST', path: '/v1/inventory/movements', userId: u, tenantId: t, idempotencyKey: movementId,
    body: { movementId, productId, locationId: 'KITCHEN', kind: 'received', quantityMinor: qty, uom: 'g', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: u },
  });
};

const registerRecipe = (h: ApiHarness, t: string, u: string, recipeId: string, key?: string) =>
  h.request({
    method: 'POST', path: `/v1/production/recipes/${recipeId}`, userId: u, tenantId: t, idempotencyKey: key ?? `rc-${recipeId}`,
    body: {
      departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea',
      inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }, { productId: 'SUGAR', quantityMinor: 50, uom: 'g' }],
      shelfLifeHours: 48, expectedYieldBp: 10_000, yieldToleranceBp: 500,
    },
  });

const commitRun = (h: ApiHarness, t: string, u: string, runId: string, body: Record<string, unknown>, key?: string) =>
  h.request({ method: 'POST', path: `/v1/production/runs/${runId}`, userId: u, tenantId: t, idempotencyKey: key ?? `run-${runId}`, body });

const readRuns = (h: ApiHarness, t: string, u: string) =>
  h.request({ method: 'GET', path: '/v1/production/runs', userId: u, tenantId: t, query: { locationId: 'KITCHEN' } });

interface RunBody { outputProductId: string; outputBatchId: string; outputQuantityMinor: number; expiresAt: string; inputCostMinor: number; outputUnitCostMinor: number; yieldBp: number; yieldVerdict: string }

describe('production: consume ingredients, create a finished batch in quarantine, refuse a short run (M11-FR-01)', () => {
  it('commits a run that consumes raw materials and yields a finished batch with its own id and expiry', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'FLOUR', 500);
    await seedOnHand(h, A, 'u-owner', 'SUGAR', 300);
    expect((await registerRecipe(h, A, 'u-owner', 'r1')).status).toBe(201);

    const res = await commitRun(h, A, 'u-owner', 'run-1', {
      recipeId: 'r1', batches: 2, actualOutputMinor: 2, outputBatchId: 'CAKE-B1', locationId: 'KITCHEN',
      unitCosts: { FLOUR: 5, SUGAR: 8 }, currency: 'INR', // ₹0.05/g flour, ₹0.08/g sugar
    });
    expect(res.status).toBe(201);
    const b = res.body as RunBody;
    // 2 batches → FLOUR 200×5 + SUGAR 100×8 = 1000 + 800 = 1800 minor; 2 cakes → 900/cake.
    expect(b).toMatchObject({ outputProductId: 'CAKE', outputBatchId: 'CAKE-B1', outputQuantityMinor: 2, inputCostMinor: 1_800, outputUnitCostMinor: 900, yieldVerdict: 'as_expected' });
    // Expiry is 48h after production, carried on the finished batch (M10).
    expect(typeof b.expiresAt).toBe('string');
    expect(Date.parse(b.expiresAt)).toBeGreaterThan(Date.parse('2026-08-08T00:00:00.000Z'));

    const runs = (await readRuns(h, A, 'u-owner')).body as { runs: { runId: string }[] };
    expect(runs.runs.map((r) => r.runId)).toContain('run-1');
  });

  it('refuses a run that would issue more than is on hand — nothing is consumed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'FLOUR', 150); // only enough for 1 batch (needs 100/batch)
    await seedOnHand(h, A, 'u-owner', 'SUGAR', 300);
    await registerRecipe(h, A, 'u-owner', 'r1');

    const short = await commitRun(h, A, 'u-owner', 'run-short', { recipeId: 'r1', batches: 2, actualOutputMinor: 2, outputBatchId: 'X', locationId: 'KITCHEN' });
    expect(short.status).toBe(422);
    expect(codeOf(short)).toBe('production_short');
    // Nothing recorded — the run is not on the list.
    expect(((await readRuns(h, A, 'u-owner')).body as { runs: unknown[] }).runs).toHaveLength(0);
  });

  it('depletes the shelf across runs — a second run sees what the first consumed', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'FLOUR', 250);
    await seedOnHand(h, A, 'u-owner', 'SUGAR', 300);
    await registerRecipe(h, A, 'u-owner', 'r1');

    expect((await commitRun(h, A, 'u-owner', 'run-1', { recipeId: 'r1', batches: 2, actualOutputMinor: 2, outputBatchId: 'C1', locationId: 'KITCHEN' })).status).toBe(201); // uses FLOUR 200
    // Only 50 FLOUR left; a 1-batch run needs 100 → short.
    const second = await commitRun(h, A, 'u-owner', 'run-2', { recipeId: 'r1', batches: 1, actualOutputMinor: 1, outputBatchId: 'C2', locationId: 'KITCHEN' });
    expect(codeOf(second)).toBe('production_short');
  });

  it('refuses an unknown recipe and is idempotent on the run id', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await seedOnHand(h, A, 'u-owner', 'FLOUR', 500);
    await seedOnHand(h, A, 'u-owner', 'SUGAR', 300);

    expect(codeOf(await commitRun(h, A, 'u-owner', 'run-x', { recipeId: 'ghost', batches: 1, actualOutputMinor: 1, outputBatchId: 'G', locationId: 'KITCHEN' }))).toBe('recipe_not_found');

    await registerRecipe(h, A, 'u-owner', 'r1');
    expect((await commitRun(h, A, 'u-owner', 'run-1', { recipeId: 'r1', batches: 1, actualOutputMinor: 1, outputBatchId: 'C1', locationId: 'KITCHEN' })).status).toBe(201);
    // Same run id, different transport key → reaches the handler → refused as already committed.
    expect(codeOf(await commitRun(h, A, 'u-owner', 'run-1', { recipeId: 'r1', batches: 1, actualOutputMinor: 1, outputBatchId: 'C1', locationId: 'KITCHEN' }, 'run-1-again'))).toBe('run_already_committed');
  });

  it('is authorized (cashier may neither produce nor read), per-tenant isolated, and validates input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await seedOnHand(h, A, 'u-mgr', 'FLOUR', 500);
    await seedOnHand(h, A, 'u-mgr', 'SUGAR', 300);
    await registerRecipe(h, A, 'u-mgr', 'r1');

    expect((await commitRun(h, A, 'u-mgr', 'run-m', { recipeId: 'r1', batches: 1, actualOutputMinor: 1, outputBatchId: 'M1', locationId: 'KITCHEN' })).status).toBe(201);
    expect((await commitRun(h, A, 'u-cash', 'run-c', { recipeId: 'r1', batches: 1, actualOutputMinor: 1, outputBatchId: 'C', locationId: 'KITCHEN' })).status).toBe(403);
    expect((await readRuns(h, A, 'u-cash')).status).toBe(403);
    expect((await registerRecipe(h, A, 'u-cash', 'r2', 'rc-cash')).status).toBe(403);

    // Malformed recipe: no inputs.
    expect(codeOf(await h.request({ method: 'POST', path: '/v1/production/recipes/r-bad', userId: 'u-owner', tenantId: A, idempotencyKey: 'rc-bad', body: { departmentId: 'cafe', outputProductId: 'X', outputQuantityMinor: 1, outputUom: 'ea', inputs: [], shelfLifeHours: 24 } }))).toBe('not_readable_as_a_recipe');

    // Per-tenant: tenant B sees none of A's runs.
    await h.seedOwner(B, 'u-owner-b');
    expect(((await readRuns(h, B, 'u-owner-b')).body as { runs: unknown[] }).runs).toHaveLength(0);
  });
});

const release = (h: ApiHarness, t: string, u: string, runId: string, qcPassed: boolean, key?: string) =>
  h.request({ method: 'POST', path: `/v1/production/runs/${runId}/release`, userId: u, tenantId: t, idempotencyKey: key ?? `rel-${runId}`, body: { qcPassed } });

describe('production quality release: nothing sellable until a named person passes it (M11-FR-03)', () => {
  const setup = async (h: ApiHarness, u = 'u-owner') => {
    await h.seedOwner(A, u);
    await seedOnHand(h, A, u, 'FLOUR', 500);
    await seedOnHand(h, A, u, 'SUGAR', 300);
    await registerRecipe(h, A, u, 'r1');
    expect((await commitRun(h, A, u, 'run-1', { recipeId: 'r1', batches: 1, actualOutputMinor: 1, outputBatchId: 'C1', locationId: 'KITCHEN' })).status).toBe(201);
  };

  it('a produced batch stays in quarantine until released, then becomes sellable', async () => {
    const h = apiHarness();
    await setup(h);
    // Before release: the run is recorded but not released.
    const before = ((await readRuns(h, A, 'u-owner')).body as { runs: { runId: string; released: boolean }[] }).runs.find((r) => r.runId === 'run-1');
    expect(before?.released).toBe(false);

    const rel = await release(h, A, 'u-owner', 'run-1', true);
    expect(rel.status).toBe(200);
    expect((rel.body as { released: boolean; releasedBy: string }).released).toBe(true);
    expect((rel.body as { releasedBy: string }).releasedBy).toBe('u-owner');

    const after = ((await readRuns(h, A, 'u-owner')).body as { runs: { runId: string; released: boolean }[] }).runs.find((r) => r.runId === 'run-1');
    expect(after?.released).toBe(true);
  });

  it('refuses to release a batch that failed its quality check — it stays in quarantine', async () => {
    const h = apiHarness();
    await setup(h);
    const rel = await release(h, A, 'u-owner', 'run-1', false);
    expect(rel.status).toBe(422);
    expect(codeOf(rel)).toBe('qc_failed');
    // Still not released.
    expect(((await readRuns(h, A, 'u-owner')).body as { runs: { runId: string; released: boolean }[] }).runs.find((r) => r.runId === 'run-1')?.released).toBe(false);
  });

  it('refuses a second release of the same batch, and an unknown run', async () => {
    const h = apiHarness();
    await setup(h);
    expect((await release(h, A, 'u-owner', 'run-1', true)).status).toBe(200);
    expect(codeOf(await release(h, A, 'u-owner', 'run-1', true, 'rel-run-1-again'))).toBe('batch_already_released');
    expect(codeOf(await release(h, A, 'u-owner', 'ghost', true))).toBe('run_not_found');
  });

  it('is authorized — a cashier cannot release stock for sale', async () => {
    const h = apiHarness();
    await setup(h, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    expect((await release(h, A, 'u-cash', 'run-1', true, 'rel-cash')).status).toBe(403);
  });
});
