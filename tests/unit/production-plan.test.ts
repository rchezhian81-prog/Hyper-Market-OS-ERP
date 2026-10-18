import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { proposeProductionPlan, sellingWindowDays, InvalidPlanInputError } from '../../packages/production/src/production-plan';
import { assignInputBatches } from '../../services/inventory/src/production';
import { productionPlanRoutes } from '../../services/inventory/src/production-plan';
import type { Recipe } from '../../packages/production/src/recipe';

/** D-25 (R3): the plan rule, the input-batch assignment, and that the plan surface cannot commit anything. */
const bun: Recipe = { recipeId: 'bun', departmentId: 'bakery', outputProductId: 'BUN', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48, expectedYieldBp: 9_000, inputs: [{ productId: 'FLOUR', quantityMinor: 500, uom: 'kg' }] };
const days = (from: string, qty: number, n: number) => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), forecastQty: qty }));

describe('D-25 production plan rule', () => {
  it('proposes whole batches within the shelf-life window and the yield, and says what is left over', () => {
    const p = proposeProductionPlan({ forDay: '2030-06-10', recipes: [bun], operatedDepartments: ['bakery'], forecastOf: () => days('2030-06-10', 20, 7), onHandUsableOf: () => 0 });
    expect(p.lines[0]).toMatchObject({ sellingWindowDays: 2, windowTo: '2030-06-11', demandMinor: 40, perBatchMinor: 9, proposedBatches: 4, proposedOutputMinor: 36, unmetMinor: 4, oneMoreBatchUnsoldMinor: 5, state: 'proposed', advisoryOnly: true });
  });
  it('stock still good on the day reduces the need; enough on hand proposes nothing', () => {
    expect(proposeProductionPlan({ forDay: '2030-06-10', recipes: [bun], operatedDepartments: ['bakery'], forecastOf: () => days('2030-06-10', 20, 7), onHandUsableOf: () => 22 }).lines[0]).toMatchObject({ needMinor: 18, proposedBatches: 2 });
    expect(proposeProductionPlan({ forDay: '2030-06-10', recipes: [bun], operatedDepartments: ['bakery'], forecastOf: () => days('2030-06-10', 20, 7), onHandUsableOf: () => 50 }).lines[0]).toMatchObject({ needMinor: 0, proposedBatches: 0, state: 'nothing_needed' });
  });
  it('a batch bigger than the need proposes none (bounded), and says so', () => {
    expect(proposeProductionPlan({ forDay: '2030-06-10', recipes: [bun], operatedDepartments: ['bakery'], forecastOf: () => days('2030-06-10', 2, 7), onHandUsableOf: () => 0 }).lines[0]).toMatchObject({ needMinor: 4, proposedBatches: 0, unmetMinor: 4, oneMoreBatchUnsoldMinor: 5, state: 'batch_bigger_than_need' });
  });
  it('no sales history is said, not guessed; a department not operated is named and left out', () => {
    const p = proposeProductionPlan({ forDay: '2030-06-10', recipes: [bun, { ...bun, recipeId: 'samosa', departmentId: 'kitchen' }], operatedDepartments: ['bakery'], forecastOf: () => undefined, onHandUsableOf: () => 0 });
    expect(p.lines.map((l) => [l.recipeId, l.state, l.proposedBatches])).toEqual([['bun', 'no_sales_history', 0]]);
    expect(p.notOperated).toEqual([{ recipeId: 'samosa', departmentId: 'kitchen' }]);
  });
  it('the selling window is whole days kept, at least one', () => {
    expect([sellingWindowDays(6), sellingWindowDays(24), sellingWindowDays(36), sellingWindowDays(72)]).toEqual([1, 1, 1, 3]);
    expect(() => proposeProductionPlan({ forDay: '10/06/2030', recipes: [], operatedDepartments: [], forecastOf: () => undefined, onHandUsableOf: () => 0 })).toThrow(InvalidPlanInputError);
  });
});

describe('D-25 input batches', () => {
  const consumed = [{ productId: 'FLOUR', quantityMinor: 1_000, uom: 'kg' }];
  const held = () => [{ batchId: 'F-1', onHandMinor: 600, expiry: '2030-07-01' }, { batchId: 'F-2', onHandMinor: 2_000, expiry: '2030-08-01' }, { batchId: null, onHandMinor: 50 }];
  it('earliest expiry first, then what no batch covers is not known (never guessed)', () => {
    expect(assignInputBatches(consumed, [], held)).toEqual({ ok: true, batches: [
      { productId: 'FLOUR', batchId: 'F-1', quantityMinor: 600, uom: 'kg', source: 'fefo_assigned' },
      { productId: 'FLOUR', batchId: 'F-2', quantityMinor: 400, uom: 'kg', source: 'fefo_assigned' },
    ] });
    expect(assignInputBatches(consumed, [], () => [{ batchId: 'F-1', onHandMinor: 300 }])).toEqual({ ok: true, batches: [
      { productId: 'FLOUR', batchId: 'F-1', quantityMinor: 300, uom: 'kg', source: 'fefo_assigned' },
      { productId: 'FLOUR', batchId: null, quantityMinor: 700, uom: 'kg', source: 'not_known' },
    ] });
  });
  it('named batches must add up and be on hand', () => {
    expect(assignInputBatches(consumed, [{ productId: 'FLOUR', batchId: 'F-2', quantityMinor: 1_000 }], held)).toMatchObject({ ok: true, batches: [{ batchId: 'F-2', source: 'captured' }] });
    expect(assignInputBatches(consumed, [{ productId: 'FLOUR', batchId: 'F-2', quantityMinor: 900 }], held)).toMatchObject({ ok: false, code: 'input_batches_do_not_add_up' });
    expect(assignInputBatches(consumed, [{ productId: 'FLOUR', batchId: 'F-1', quantityMinor: 1_000 }], held)).toMatchObject({ ok: false, code: 'input_batch_not_on_hand' });
  });
});

describe('D-25 guardrail: the plan proposes, a person commits', () => {
  it('the plan surface is reads only and holds no write port', () => {
    const noop = async () => { throw new Error('not called'); };
    const routes = productionPlanRoutes({ now: () => '', recipes: noop, enabledDepartments: noop, soldNear: noop, usableOnHand: noop, runs: noop, soldOfBatch: noop });
    expect(routes.every((r) => r.method === 'GET')).toBe(true);
    const src = readFileSync('services/inventory/src/production-plan.ts', 'utf8').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['recordRun', 'appendMovement', '.append(', 'ProductionRunCommitted']) expect(src).not.toContain(forbidden);
    const engine = readFileSync('packages/production/src/production-plan.ts', 'utf8').replace(/\/\/.*$/gm, '');
    expect(engine).not.toMatch(/import .*persistence|recordRun|append/);
  });
  it('committing a run needs a person holding production.plan.commit (no AI or machine role holds it)', () => {
    const roles = readFileSync('services/api/src/roles.ts', 'utf8');
    const machine = roles.slice(roles.indexOf('id: STORE_COMPUTER_ROLE_ID'));
    expect(machine).not.toContain('production.plan.commit');
    const run = readFileSync('services/inventory/src/production.ts', 'utf8');
    expect(run).toMatch(/path: '\/v1\/production\/runs\/:runId',\s*permission: 'production\.plan\.commit'/);
  });
});
