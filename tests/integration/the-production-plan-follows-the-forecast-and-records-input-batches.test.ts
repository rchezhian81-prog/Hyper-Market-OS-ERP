import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import { productionInputsForOutputBatch } from '../../services/api/src/r3-ops-adapters';
import { certifyFoodHandler } from '../support/food-handler';

/**
 * D-25 (R3) — on the real API, in memory and on PostgreSQL, with a cold restart: "for an operated department, the plan
 * proposes batches per recipe from the forecast, bounded by shelf life and expected yield. A run records its input batch
 * IDs. A trace of an input batch reaches the output batch and its sales." A person commits each run (P-05).
 */
const backings = r3OpsBackings();
const FOR_DAY = '2030-06-10';
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('the production plan follows the forecast and runs record their input batches — on $name (D-25)', ({ harness, restart }) => {
  it('plan from the forecast → a person commits → input batches recorded (FEFO and named) → trace to the output batch and its sales', async () => {
    let h: ApiHarness = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await certifyFoodHandler(h.store, T, 'u-owner'); // OB-502: food-handling work needs a valid certificate
    await certifyFoodHandler(h.store, T, 'u-baker'); // OB-502: food-handling work needs a valid certificate
    await h.provisionRole(T, 'u-baker', 'store_manager');
    await h.provisionRole(T, 'u-qc', 'store_manager');
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.enableFeature(T, 'dept.bakery');
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S1', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/production/departments/bakery', {}), 'bakery on');
    const receive = (id: string, productId: string, grams: number, batchId: string, expiry: string) => ok(req('POST', '/v1/inventory/movements', {
      movementId: id, productId, locationId: 'S1', kind: 'received', quantityMinor: grams, uom: 'kg', occurredAt: '2030-04-01T01:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 4_000, batchId, expiry,
    }), id);
    await receive('rx-f1', 'FLOUR', 600, 'F-1', '2030-07-01');
    await receive('rx-f2', 'FLOUR', 2_000, 'F-2', '2030-08-01');
    await receive('rx-s1', 'SUGAR', 1_000, 'S-1', '2030-12-01');
    // Bun: 10 a batch, 90% expected yield (9 good), keeps 48 h → a two-day selling window. A cafe recipe: not operated here.
    await ok(req('POST', '/v1/production/recipes/bun', { departmentId: 'bakery', outputProductId: 'BUN', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48, expectedYieldBp: 9_000, yieldToleranceBp: 2_000, inputs: [{ productId: 'FLOUR', quantityMinor: 500, uom: 'kg' }, { productId: 'SUGAR', quantityMinor: 100, uom: 'kg' }] }), 'bun recipe');
    await ok(req('POST', '/v1/production/recipes/latte', { departmentId: 'cafe', outputProductId: 'LATTE', outputQuantityMinor: 1, outputUom: 'ea', shelfLifeHours: 1, inputs: [{ productId: 'MILK', quantityMinor: 200, uom: 'l' }] }), 'latte recipe');
    // Eight weeks of bun sales, 20 a day, before the day planned.
    for (let i = 1; i <= 56; i++) {
      const day = addDays(FOR_DAY, -i);
      await ok(req('POST', '/v1/sales', {
        saleId: `SB-${i}`, receiptNumber: `RB-${i}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: day, committedAt: `${day}T09:00:00Z`,
        totalMinor: 20 * 500, currency: 'INR', packVersion: 1,
        lines: [{ productId: 'BUN', quantityMinor: 20, uom: 'ea', unitPriceMinor: 500, lineTotalMinor: 20 * 500 }], tenders: [{ kind: 'cash', amountMinor: 20 * 500 }],
      }), `sale ${day}`);
    }

    // ── the plan: from the forecast, bounded by the 2-day shelf life and the 90% yield; advisory ───────────────
    expect((await req('GET', '/v1/production/plan', undefined, 'u-till', { locationId: 'S1', forDay: FOR_DAY })).status).toBe(403);
    const plan = (await ok(req('GET', '/v1/production/plan', undefined, 'u-baker', { locationId: 'S1', forDay: FOR_DAY }), 'plan')).body as {
      lines: { recipeId: string; sellingWindowDays: number; demandMinor: number; perBatchMinor: number; proposedBatches: number; proposedOutputMinor: number; unmetMinor: number; oneMoreBatchUnsoldMinor: number; state: string; advisoryOnly: boolean }[];
      notOperated: { recipeId: string; departmentId: string }[]; advisoryOnly: boolean;
    };
    expect(plan.advisoryOnly).toBe(true);
    expect(plan.notOperated).toEqual([{ recipeId: 'latte', departmentId: 'cafe' }]);
    expect(plan.lines).toEqual([expect.objectContaining({ recipeId: 'bun', sellingWindowDays: 2, demandMinor: 40, perBatchMinor: 9, proposedBatches: 4, proposedOutputMinor: 36, unmetMinor: 4, oneMoreBatchUnsoldMinor: 5, state: 'proposed', advisoryOnly: true })]);
    // Reading the plan made nothing.
    expect(((await req('GET', '/v1/production/runs')).body as { runs: unknown[] }).runs).toEqual([]);

    h = restart(h); // ── COLD RESTART ──────────────────────────────────────────────────────────────────────────

    // ── a person commits each run; the run records its input batches ────────────────────────────────────────
    expect((await req('POST', '/v1/production/runs/run-1', { recipeId: 'bun', batches: 2, actualOutputMinor: 18, outputBatchId: 'BUN-0610-A', locationId: 'S1' }, 'u-till')).status).toBe(403);
    const r1 = (await ok(req('POST', '/v1/production/runs/run-1', { recipeId: 'bun', batches: 2, actualOutputMinor: 18, outputBatchId: 'BUN-0610-A', locationId: 'S1', planRef: `plan:S1:${FOR_DAY}:bun` }, 'u-baker'), 'run 1')).body as { inputBatches: { productId: string; batchId: string | null; quantityMinor: number; source: string }[]; planRef: string };
    // Earliest expiry first: F-1's 600 g, then 400 g from F-2; sugar from S-1.
    expect(r1.inputBatches).toEqual([
      { productId: 'FLOUR', batchId: 'F-1', quantityMinor: 600, uom: 'kg', source: 'fefo_assigned' },
      { productId: 'FLOUR', batchId: 'F-2', quantityMinor: 400, uom: 'kg', source: 'fefo_assigned' },
      { productId: 'SUGAR', batchId: 'S-1', quantityMinor: 200, uom: 'kg', source: 'fefo_assigned' },
    ]);
    expect(r1.planRef).toBe(`plan:S1:${FOR_DAY}:bun`);
    const batchOnHand = async (p: string, b: string) => (((await req('GET', '/v1/inventory/batches', undefined, 'u-owner', { locationId: 'S1', productId: p })).body as { batches: { batchId: string | null; onHandMinor: number }[] }).batches.find((x) => x.batchId === b)?.onHandMinor ?? 0);
    expect(await batchOnHand('FLOUR', 'F-1')).toBe(0);
    expect(await batchOnHand('FLOUR', 'F-2')).toBe(1_600);
    // Named batches must add up and be on hand; a named batch is recorded as captured.
    expect(code(await req('POST', '/v1/production/runs/run-x', { recipeId: 'bun', batches: 1, actualOutputMinor: 9, outputBatchId: 'BUN-X', locationId: 'S1', inputBatches: [{ productId: 'FLOUR', batchId: 'F-2', quantityMinor: 400 }] }, 'u-baker'))).toBe('input_batches_do_not_add_up');
    expect(code(await req('POST', '/v1/production/runs/run-y', { recipeId: 'bun', batches: 1, actualOutputMinor: 9, outputBatchId: 'BUN-Y', locationId: 'S1', inputBatches: [{ productId: 'FLOUR', batchId: 'F-1', quantityMinor: 500 }] }, 'u-baker'))).toBe('input_batch_not_on_hand');
    const r2 = (await ok(req('POST', '/v1/production/runs/run-2', { recipeId: 'bun', batches: 1, actualOutputMinor: 9, outputBatchId: 'BUN-0610-B', locationId: 'S1', inputBatches: [{ productId: 'FLOUR', batchId: 'F-2', quantityMinor: 500 }] }, 'u-baker'), 'run 2')).body as { inputBatches: { batchId: string; source: string }[] };
    expect(r2.inputBatches.map((x) => `${x.batchId}:${x.source}`)).toEqual(['F-2:captured', 'S-1:fefo_assigned']);

    // ── the D-26 hop for Lane 3, and its route ────────────────────────────────────────────────────────────────
    const inputs = await productionInputsForOutputBatch({ store: h.store, now: () => new Date().toISOString() }, T, 'BUN-0610-A');
    expect(inputs).toEqual([{ runId: 'run-1', outputProductId: 'BUN', inputsRecorded: true, inputBatches: r1.inputBatches }]);
    expect(((await ok(req('GET', '/v1/production/batches/BUN-0610-A/inputs'), 'inputs')).body as { runs: unknown[] }).runs).toEqual(inputs);
    expect(code(await req('GET', '/v1/production/batches/NOPE/inputs'))).toBe('output_batch_not_produced');

    // ── the trace: ingredient batch F-1 → output batch BUN-0610-A → its sales ──────────────────────────────────
    await ok(req('POST', '/v1/production/runs/run-1/release', { qcPassed: true }, 'u-qc'), 'release');
    await ok(req('POST', '/v1/sales', {
      saleId: 'S-BUN-1', receiptNumber: 'R-BUN-1', laneId: 'lane-1', locationId: 'S1', cashierId: 'u-owner', tradingDay: FOR_DAY, committedAt: `${FOR_DAY}T10:00:00Z`,
      totalMinor: 1_500, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'BUN', quantityMinor: 3, uom: 'ea', unitPriceMinor: 500, lineTotalMinor: 1_500, batchId: 'BUN-0610-A' }], tenders: [{ kind: 'cash', amountMinor: 1_500 }],
    }), 'bun sale');
    const trace = (await ok(req('GET', '/v1/production/input-batches/F-1/trace'), 'trace')).body as { outputs: { outputBatchId: string; inputUsed: { quantityMinor: number }[]; sales: { saleId: string; quantityMinor: number }[] }[] };
    expect(trace.outputs).toHaveLength(1);
    expect(trace.outputs[0]).toMatchObject({ outputBatchId: 'BUN-0610-A', inputUsed: [{ quantityMinor: 600 }] });
    expect(trace.outputs[0]!.sales).toEqual([expect.objectContaining({ saleId: 'S-BUN-1', quantityMinor: 3 })]);
    const traceF2 = (await req('GET', '/v1/production/input-batches/F-2/trace')).body as { outputs: { outputBatchId: string }[] };
    expect(traceF2.outputs.map((o) => o.outputBatchId).sort()).toEqual(['BUN-0610-A', 'BUN-0610-B']);
  }, 120_000);
});
