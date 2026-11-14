import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HAVE_BROWSER, startBoxPageShop, says, type BoxPageShop } from './lib/r4c-box-page';
import { aBranch } from '../support/a-branch';
import { certifyFoodHandler } from '../support/food-handler';

/**
 * **W4 (M11-FR-01 · M11-FR-02 · M11-FR-03): the plan, the batch trace and Production costs, served by the REAL store computer**
 * (head office's production route set in memory; every `/v1` call reaches it as the signed-in person). The Production page
 * shows the advisory plan and traces a cake batch back to its flour batch and the flour batch forward; the accountant's
 * Production costs page — served on its own word, `production.cost.read` — shows the run's cost and its yield shortfall as
 * an exception, in English and Tamil. A person who may only look at production is offered no forward trace.
 * Synthetic data. Needs the pre-installed Chromium; without it it SKIPS.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const ACC = 'u-acc'; const VIEWER = 'u-view';

describe.skipIf(!HAVE_BROWSER)('the plan, the batch trace and Production costs on the store computer (W4 · M11)', () => {
  let shop: BoxPageShop;
  beforeAll(async () => {
    shop = await startBoxPageShop({
      name: 'w4-production',
      pack: { productionPolicy: { permissions: [] } },
      people: [
        { userId: MGR, permissions: ['production.read', 'production.plan.commit', 'quality.lottrace.read'] },
        { userId: ACC, permissions: ['production.cost.read'] },
        { userId: VIEWER, permissions: ['production.read'] },
      ],
      seed: async (ho, T, store) => {
        await ho.seedOwner(T, OWNER);
        await aBranch(ho, T, OWNER, store);
        await ho.provisionRole(T, MGR, 'store_manager', [store]);
        await ho.provisionRole(T, ACC, 'accountant', [store]);
        await certifyFoodHandler(ho.store, T, MGR);
        const post = async (path: string, body: unknown, who = OWNER) => {
          const r = await ho.request({ method: 'POST', path, userId: who, tenantId: T, branchId: store, idempotencyKey: `seed-${path}-${JSON.stringify(body).length}-${Math.random()}`, body });
          if (r.status >= 300) throw new Error(`${path}: ${JSON.stringify(r.body)}`);
        };
        const at = new Date(Date.now() - 86_400_000).toISOString();
        await post('/v1/inventory/movements', { movementId: 'rx-FLOUR', productId: 'FLOUR', locationId: store, kind: 'received', quantityMinor: 10_000, uom: 'kg', occurredAt: at, enteredBy: OWNER, unitCostMinor: 4_000, batchId: 'FLOUR-B7' });
        await post('/v1/inventory/movements', { movementId: 'rx-SUGAR', productId: 'SUGAR', locationId: store, kind: 'received', quantityMinor: 5_000, uom: 'kg', occurredAt: at, enteredBy: OWNER, unitCostMinor: 5_000 });
        await post('/v1/production/departments/cafe', {});
        await post('/v1/production/recipes/coffee-cake', {
          departmentId: 'cafe', outputProductId: 'CAKE', outputQuantityMinor: 10, outputUom: 'ea', shelfLifeHours: 48, yieldToleranceBp: 500,
          inputs: [{ productId: 'FLOUR', quantityMinor: 1_500, uom: 'kg' }, { productId: 'SUGAR', quantityMinor: 500, uom: 'kg' }],
        });
        // two batches, 14 cakes where the recipe expects 20 — a 30 % shortfall, beyond the 5 % the recipe allows
        await post('/v1/production/runs/run-1', { recipeId: 'coffee-cake', batches: 2, actualOutputMinor: 14, outputBatchId: 'CAKE-1', locationId: store }, MGR);
      },
    });
  }, 240_000);
  afterAll(async () => { await shop?.stop(); });

  it('the manager reads the plan and traces the cake batch back and forward — and nothing is written', async () => {
    const m = await shop.open(MGR, '/production/');
    await m.page.waitForSelector('#planner:not([hidden])');
    await says(m.page, '#plan-h', /^Plan production$/);
    await m.page.fill('#plan-location', shop.store);
    // U3 · OB-699 (and U2b · G14): the day is the shop's own dd/mm/yyyy on the shared date field, sent to head office as ISO
    await m.page.fill('#plan-day', '11/04/2026');
    await m.page.dispatchEvent('#plan-day', 'blur');
    await m.page.click('#plan-go');
    await says(m.page, '#plan-status', /^Plan for 2026-04-11 /);
    // a day that is not on the calendar is refused beside the field, in words, and nothing is asked of head office
    await m.page.fill('#plan-day', '31/02/2026');
    await m.page.dispatchEvent('#plan-day', 'blur');
    await says(m.page, '#plan-day-msg', /not a real date/);
    await m.page.fill('#plan-day', '');
    await m.page.dispatchEvent('#plan-day', 'blur');
    await m.page.click('#plan-go');
    await says(m.page, '#plan-rows li[data-recipe="coffee-cake"]', /No sales to go by yet — decide yourself.*Batches: 0/);

    await m.page.fill('#trace-batch', 'CAKE-1');
    await m.page.click('#trace-inputs');
    await says(m.page, '#trace-rows', /FLOUR — FLOUR-B7 — 3(\.0+)? kg \(earliest expiry first\)/);
    await m.page.fill('#trace-batch', 'FLOUR-B7');
    await m.page.click('#trace-forward');
    await says(m.page, '#trace-rows li[data-output-batch="CAKE-1"]', /FLOUR-B7 went into CAKE-1 \(CAKE\).*sales: 0/);
    await m.page.fill('#trace-batch', 'NO-SUCH');
    await m.page.click('#trace-inputs');
    await says(m.page, '#trace-status', /^Head office refused: No production run made batch NO-SUCH\.$/);
    await m.page.click('#lang');
    await says(m.page, '#plan-h', /^உற்பத்தித் திட்டம்$/);
    expect(m.writes).toEqual([]);
    expect(m.errors).toEqual([]);
    await m.close();
  });

  it('a person who may only look at production sees the plan and a batch\'s inputs, but no forward trace', async () => {
    const v = await shop.open(VIEWER, '/production/');
    await v.page.waitForSelector('#tracer:not([hidden])');
    expect(await v.page.isVisible('#trace-forward')).toBe(false);
    expect(v.errors).toEqual([]);
    await v.close();
  });

  it('the accountant reviews the run\'s cost on Production costs: the shortfall is an exception with its money', async () => {
    const held = (await shop.call('GET', '/v1/production/costs', ACC)).body as { runs: { outputBatchId: string; inputCostMinor: number | null }[] };
    expect(held.runs.find((r) => r.outputBatchId === 'CAKE-1')?.inputCostMinor).toBe(3 * 4_000 + 1 * 5_000);
    const a = await shop.open(ACC, '/production-costs');
    await says(a.page, '#cards', /Yield exceptions\s*1/);
    const row = '#cost-rows tr[data-batch="CAKE-1"]';
    await says(a.page, row, /Exception/);
    await says(a.page, row, /₹170\.00/);
    await says(a.page, row, /₹12\.14 per piece/);
    await says(a.page, row, /70\.00% — below the recipe · 6 ea less than the recipe expects.*\(worth ₹/);
    expect(await a.page.getAttribute(row, 'data-tone')).toBe('error');
    await a.page.click('#lang');
    await says(a.page, '#page-h', /^உற்பத்திச் செலவு$/);
    await says(a.page, row, /விதிவிலக்கு/);
    expect(a.writes).toEqual([]);
    expect(a.errors).toEqual([]);
    await a.close();
    expect((await shop.call('GET', '/v1/production/runs', ACC)).status).toBe(403);
  });
});
