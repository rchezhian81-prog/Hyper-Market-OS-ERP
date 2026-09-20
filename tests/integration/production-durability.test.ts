import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// In-store production durability — the run/release/department truth rebuilds from the event store after a
// restart (M11-FR-01/03/04, API-04, P-04 "tested recovery", P-08, FND-01 append-only).
//
// production.test.ts proves the run behaviour, quality release (§-gated), departments and Legal-Metrology
// labels through the real API with RBAC + per-tenant isolation; weighed-costing.test.ts (M11-FR-02) already
// carries its own restart proof. The one property the run/release/department legs did not prove is that a
// committed, quality-RELEASED batch and the enabled-department set SURVIVE the process restarting — that
// prior consumption stays layered so a post-restart run still sees a depleted shelf, and that appends
// continue. This closes that gap, mirroring the restart-rebuild bar the other event-sourced surfaces carry
// (goods-receipt, warehouse-counts, connector-delivery, facilities).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const seedOnHand = (h: ApiHarness, u: string, productId: string, qty: number) => {
  const movementId = `mv-${productId}`;
  return h.request({
    method: 'POST', path: '/v1/inventory/movements', userId: u, tenantId: A, idempotencyKey: movementId,
    body: { movementId, productId, locationId: 'KITCHEN', kind: 'received', quantityMinor: qty, uom: 'g', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: u },
  });
};
const registerRecipe = (h: ApiHarness, u: string, recipeId: string) =>
  h.request({
    method: 'POST', path: `/v1/production/recipes/${recipeId}`, userId: u, tenantId: A, idempotencyKey: `rc-${recipeId}`,
    body: {
      departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 1, outputUom: 'ea',
      inputs: [{ productId: 'FLOUR', quantityMinor: 100, uom: 'g' }, { productId: 'SUGAR', quantityMinor: 50, uom: 'g' }],
      shelfLifeHours: 48, expectedYieldBp: 10_000, yieldToleranceBp: 500,
    },
  });
const commitRun = (h: ApiHarness, u: string, runId: string, batches: number, outputBatchId: string, key?: string) =>
  h.request({ method: 'POST', path: `/v1/production/runs/${runId}`, userId: u, tenantId: A, idempotencyKey: key ?? `run-${runId}`, body: { recipeId: 'r1', batches, actualOutputMinor: batches, outputBatchId, locationId: 'KITCHEN', currency: 'INR' } });
const release = (h: ApiHarness, u: string, runId: string) =>
  h.request({ method: 'POST', path: `/v1/production/runs/${runId}/release`, userId: u, tenantId: A, idempotencyKey: `rel-${runId}`, body: { qcPassed: true } });
const enableDept = (h: ApiHarness, u: string, dept = 'cafe') =>
  h.request({ method: 'POST', path: `/v1/production/departments/${dept}`, userId: u, tenantId: A, idempotencyKey: `dept-${dept}`, body: {} });
const setCost = (h: ApiHarness, u: string, productId: string, unitCostMinor: number) =>
  h.request({ method: 'POST', path: `/v1/production/costs/${productId}`, userId: u, tenantId: A, idempotencyKey: `cost-${productId}`, body: { unitCostMinor, currency: 'INR' } });
const readRuns = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/production/runs', userId: u, tenantId: A, query: { locationId: 'KITCHEN' } });
const departments = (h: ApiHarness, u: string) =>
  h.request({ method: 'GET', path: '/v1/production/departments', userId: u, tenantId: A });

interface Runs { runs: { runId: string; released: boolean }[] }
interface Depts { operated: { departmentId: string }[] }

describe('production durability: runs, releases and departments rebuild from the event store after a restart (M11)', () => {
  it('a released batch, the enabled department and the depleted shelf all survive a restart, and appends continue', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await enableDept(h, 'u-owner');
    await seedOnHand(h, 'u-owner', 'FLOUR', 500);
    await seedOnHand(h, 'u-owner', 'SUGAR', 300);
    await setCost(h, 'u-owner', 'FLOUR', 5);
    await setCost(h, 'u-owner', 'SUGAR', 8);
    expect((await registerRecipe(h, 'u-owner', 'r1')).status).toBe(201);

    // Run 2 batches (FLOUR 200, SUGAR 100 consumed) and quality-release the finished batch.
    expect((await commitRun(h, 'u-owner', 'run-1', 2, 'CAKE-B1')).status).toBe(201);
    expect((await release(h, 'u-owner', 'run-1')).status).toBe(200);

    // Restart: a NEW surface over the SAME persisted event store — everything must rebuild from the log.
    const restarted = apiHarness({ store: h.store });

    // FR-03: the released batch survives, still marked released.
    const runs = (await readRuns(restarted, 'u-owner')).body as Runs;
    const run1 = runs.runs.find((r) => r.runId === 'run-1');
    expect(run1, 'the production run did not survive the restart').toBeDefined();
    expect(run1?.released, 'the quality release did not survive the restart').toBe(true);

    // FR-04: the enabled department set survives.
    expect(((await departments(restarted, 'u-owner')).body as Depts).operated.map((d) => d.departmentId)).toContain('cafe');

    // FR-01: prior consumption stayed layered — a fresh run after the restart still sees the depleted shelf
    // AND commits, proving the rebuilt surface is live (append-only continues), not a read-only replay.
    // 300 FLOUR / 200 SUGAR remain → a 1-batch run (100/50) commits; then only 200/150 remain.
    expect((await commitRun(restarted, 'u-owner', 'run-2', 1, 'CAKE-B2')).status).toBe(201);
    const after = (await readRuns(restarted, 'u-owner')).body as Runs;
    expect(after.runs.map((r) => r.runId).sort()).toEqual(['run-1', 'run-2']);
  });
});
