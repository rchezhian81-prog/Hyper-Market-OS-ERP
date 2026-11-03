import { describe, it, expect } from 'vitest';
import { createProductionPlanSession, PRODUCTION_PLAN_COPY, planAmount, planStateWords } from '../../apps/web-erp/src/production-plan-session';
import { createProductionCostsSession, PRODUCTION_COSTS_COPY, presentCostRun, type CostRun } from '../../apps/web-erp/src/production-costs-session';
import { productionCostOf, productionRoutes, type StoredRun } from '../../services/inventory/src/production';
import { ROLE_CATALOGUE as ROLES } from '../../services/api/src/roles';
import { ERP_NAVIGATION } from '../../apps/web-erp/src/navigation';

/**
 * W4 · M11-FR-01 / M11-FR-02 / M11-FR-03 — the sessions behind the Production page's plan and batch-trace sections and the
 * Production costs page. Each asks only head office's own read routes (nothing is written), refuses before any call for a
 * person not named or not permitted, and says head office's refusals in its own words.
 *   • M11-FR-01 "plan production": `GET /v1/production/plan` — advice; a day typed wrong is refused before the call.
 *   • M11-FR-03 "a batch is traceable": `GET /v1/production/batches/:id/inputs` (production.read) and
 *     `GET /v1/production/input-batches/:id/trace` (quality.lottrace.read).
 *   • M11-FR-02 §28 "costing reviewed by Finance": `GET /v1/production/costs` under its own word `production.cost.read`,
 *     held by the accountant; a yield outside the range is an exception (error tone, its money), a run not valued is never ₹0.
 */

function fakeHeadOffice(answer: (path: string) => { status: number; body: unknown }) {
  const sent: { method: string; path: string }[] = [];
  const fetch = (async (path: string, init: { method: string }) => {
    sent.push({ method: init.method, path });
    const a = answer(path);
    return { ok: a.status < 300, status: a.status, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const STAFF = { userId: 'u-mgr', permissions: ['production.read', 'quality.lottrace.read'] };
const READER = { userId: 'u-read', permissions: ['production.read'] };

describe('the plan and batch-trace sections of the Production page (M11-FR-01 · M11-FR-03)', () => {
  it('every word has a Tamil twin', () => {
    expect(Object.keys(PRODUCTION_PLAN_COPY.ta).sort()).toEqual(Object.keys(PRODUCTION_PLAN_COPY.en).sort());
    expect(planStateWords('ta', 'no_sales_history')).toBe(PRODUCTION_PLAN_COPY.ta.s_no_sales_history);
    expect(planAmount('en', 12, 'ea')).toBe('12 pieces');
    expect(planAmount('en', 2500, 'g')).toBe('2500 g');
  });

  it('the plan asks GET /v1/production/plan for the place, and the day only when one is typed', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: { forDay: '2026-11-04', lines: [], notOperated: [] } }));
    const s = createProductionPlanSession({ viewer: STAFF, fetch: ho.fetch });
    expect((await s.plan({ locationId: ' br-1 ' })).result).toBe('ok');
    expect((await s.plan({ locationId: 'br-1', forDay: '2026-11-10' })).result).toBe('ok');
    expect(ho.sent).toEqual([
      { method: 'GET', path: '/v1/production/plan?locationId=br-1' },
      { method: 'GET', path: '/v1/production/plan?locationId=br-1&forDay=2026-11-10' },
    ]);
  });

  it('a missing place or a day typed wrong is refused before any call; nobody named and a role without production read send nothing', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: {} }));
    const s = createProductionPlanSession({ viewer: STAFF, fetch: ho.fetch });
    expect(await s.plan({ locationId: '  ' })).toEqual({ result: 'invalid', why: 'needLocation' });
    expect(await s.plan({ locationId: 'br-1', forDay: '10/11/2026' })).toEqual({ result: 'invalid', why: 'badDay' });
    expect(await createProductionPlanSession({ viewer: undefined, fetch: ho.fetch }).plan({ locationId: 'br-1' })).toEqual({ result: 'invalid', why: 'nobody' });
    const cashier = createProductionPlanSession({ viewer: { userId: 'u-cash', permissions: ['pos.sale.record'] }, fetch: ho.fetch });
    expect(cashier.may).toEqual({ named: true, read: false, trace: false });
    expect(await cashier.plan({ locationId: 'br-1' })).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await cashier.inputsOf('CAKE-1')).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.sent).toEqual([]);
  });

  it('a batch\'s inputs and the forward trace ask exactly their routes; the forward trace needs the batch-trace word', async () => {
    const ho = fakeHeadOffice((p) => ({ status: 200, body: p.includes('/inputs') ? { outputBatchId: 'CAKE 1', runs: [] } : { batchId: 'FL-7', outputs: [], runsWithoutRecordedInputs: 0 } }));
    const s = createProductionPlanSession({ viewer: STAFF, fetch: ho.fetch });
    expect((await s.inputsOf('CAKE 1')).result).toBe('ok');
    expect((await s.traceForward('FL-7')).result).toBe('ok');
    expect(await s.traceForward(' ')).toEqual({ result: 'invalid', why: 'needBatch' });
    expect(await createProductionPlanSession({ viewer: READER, fetch: ho.fetch }).traceForward('FL-7')).toEqual({ result: 'invalid', why: 'cannotTrace' });
    expect(ho.sent).toEqual([
      { method: 'GET', path: '/v1/production/batches/CAKE%201/inputs' },
      { method: 'GET', path: '/v1/production/input-batches/FL-7/trace' },
    ]);
  });

  it('head office\'s refusal is passed on in its own words; a lost link is a lost link', async () => {
    const ho = fakeHeadOffice(() => ({ status: 404, body: { error: { code: 'output_batch_not_produced', whatHappened: 'No production run made batch X.' } } }));
    expect(await createProductionPlanSession({ viewer: STAFF, fetch: ho.fetch }).inputsOf('X')).toEqual({ result: 'refused', status: 404, code: 'output_batch_not_produced', whatHappened: 'No production run made batch X.' });
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    expect(await createProductionPlanSession({ viewer: STAFF, fetch: down }).plan({ locationId: 'br-1' })).toEqual({ result: 'lost_link' });
  });
});

const RUN: CostRun = {
  runId: 'r1', recipeId: 'coffee-cake', departmentId: 'cafe', locationId: 'br-1', outputProductId: 'CAKE', outputBatchId: 'CAKE-1',
  outputQuantityMinor: 14, outputUom: 'ea', at: '2026-11-03T05:00:00.000Z', producedBy: 'u-mgr', currency: 'INR',
  valued: true, inputCostMinor: 20_000, unitCostPerWholeMinor: 1_429,
  lines: [{ productId: 'FLOUR', quantityMinor: 3_000, uom: 'g', unitCostMinor: 5, source: 'average_buying_cost', valueMinor: 15_000 }],
  notValuedBecause: [], yieldBp: 7_000, yieldVerdict: 'low_yield',
  exceptions: [{ kind: 'yield_variance', detail: '6 ea less than the recipe expects — check the process, the portioning or the measurement', value: { minor: 8_574, currency: 'INR' } }],
  costBasis: 'run_cost',
};

describe('the Production costs page — costing reviewed by Finance (M11-FR-02)', () => {
  it('every word has a Tamil twin', () => {
    expect(Object.keys(PRODUCTION_COSTS_COPY.ta).sort()).toEqual(Object.keys(PRODUCTION_COSTS_COPY.en).sort());
  });

  it('the page asks its own word: the accountant holds production.cost.read and nothing else of production; the menu item asks it', () => {
    const accountant = ROLES.find((r) => r.id === 'accountant')!;
    expect(accountant.permissions).toContain('production.cost.read');
    expect(accountant.permissions.filter((p) => p.startsWith('production.'))).toEqual(['production.cost.read']);
    for (const id of ['owner', 'store_manager']) expect(ROLES.find((r) => r.id === id)!.permissions).toContain('production.cost.read');
    expect(ROLES.find((r) => r.id === 'cashier')!.permissions).not.toContain('production.cost.read');
    expect(ERP_NAVIGATION.find((i) => i.id === 'production-costs')).toMatchObject({ path: '/production-costs', requires: 'production.cost.read' });
    const route = productionRoutes({} as never).find((r) => r.method === 'GET' && r.path === '/v1/production/costs');
    expect(route?.permission).toBe('production.cost.read');
  });

  it('reads GET /v1/production/costs only — and refuses before any call for nobody or a role without the word', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: { runs: [RUN], withExceptions: 1, notValued: 0, asAt: 'x' } }));
    const acc = createProductionCostsSession({ viewer: { userId: 'u-acc', permissions: ['production.cost.read'] }, fetch: ho.fetch });
    expect((await acc.read()).result).toBe('ok');
    expect((await acc.read('br-1')).result).toBe('ok');
    expect(await createProductionCostsSession({ viewer: undefined, fetch: ho.fetch }).read()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await createProductionCostsSession({ viewer: READER, fetch: ho.fetch }).read()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/production/costs' }, { method: 'GET', path: '/v1/production/costs?locationId=br-1' }]);
  });

  it('a yield outside the range is an exception in words and tone, with its money; each line names its cost source', () => {
    const p = presentCostRun('en', RUN);
    expect(p).toMatchObject({ tone: 'error', stateWord: 'Exception', made: '14 piece', inputCost: '₹200.00', unitCost: '₹14.29 per piece', yieldWords: '70.00% — below the recipe' });
    expect(p.exceptionLines).toEqual(['6 ea less than the recipe expects — check the process, the portioning or the measurement (worth ₹85.74)']);
    expect(p.lines).toEqual(['FLOUR — 3000 g — ₹150.00 (average buying cost)']);
    expect(presentCostRun('ta', RUN).stateWord).toBe(PRODUCTION_COSTS_COPY.ta.w_exception);
  });

  it('a run not valued is said by name, never ₹0; a clean run reads Costed', () => {
    const notValued = presentCostRun('en', { ...RUN, exceptions: [], yieldVerdict: 'as_expected', yieldBp: 10_000, valued: false, inputCostMinor: null, unitCostPerWholeMinor: null, notValuedBecause: ['SUGAR'], lines: [{ productId: 'SUGAR', quantityMinor: 500, uom: 'g', unitCostMinor: null, source: 'none', valueMinor: null }] });
    expect(notValued).toMatchObject({ tone: 'degraded', stateWord: 'Not valued', inputCost: 'not valued', unitCost: 'not valued', notValuedLine: 'No cost for: SUGAR' });
    expect(notValued.lines).toEqual(['SUGAR — 500 g — not valued (no cost)']);
    expect(presentCostRun('en', { ...RUN, exceptions: [], yieldVerdict: 'as_expected', yieldBp: 10_000 })).toMatchObject({ tone: 'ok', stateWord: 'Costed' });
  });
});

describe('head office\'s production costing view (M11-FR-02, pure)', () => {
  const base = {
    runId: 'r0', recipeId: 'bread', departmentId: 'bakery', locationId: 'br-1', outputProductId: 'LOAF', outputBatchId: 'L-1',
    outputQuantityMinor: 2_000, outputUom: 'kg', expiresAt: '', inputCostMinor: 3_000, outputUnitCostMinor: 2, currency: 'INR' as const,
    costKnown: true, uncostedProducts: [], yieldBp: 10_000, yieldVerdict: 'as_expected', exceptions: [], consumed: [], producedBy: 'u', at: '2026-11-01T00:00:00Z',
  } satisfies StoredRun;

  it('a run recorded before run costing is shown on its registered cost (per whole unit) and says so', () => {
    expect(productionCostOf(base)).toMatchObject({ valued: true, inputCostMinor: 3_000, unitCostPerWholeMinor: 2_000, lines: [], costBasis: 'registered_cost' });
    expect(productionCostOf({ ...base, costKnown: false, uncostedProducts: ['YEAST'] })).toMatchObject({ valued: false, inputCostMinor: null, unitCostPerWholeMinor: null, notValuedBecause: ['YEAST'] });
  });

  it('a run with its own cost (OB-68) carries its lines and sources as recorded', () => {
    const runCost = { valued: false, inputCostMinor: null, unitCostPerWholeMinor: null, notValuedBecause: ['SALT'], lines: [{ productId: 'SALT', quantityMinor: 10, uom: 'g', unitCostMinor: null, source: 'none' as const, valueMinor: null }] };
    expect(productionCostOf({ ...base, runCost })).toMatchObject({ valued: false, inputCostMinor: null, notValuedBecause: ['SALT'], lines: runCost.lines, costBasis: 'run_cost' });
  });
});
