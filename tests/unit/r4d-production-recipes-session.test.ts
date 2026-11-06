import { describe, it, expect } from 'vitest';
import { createProductionRecipesSession, basisPointsOf, PRODUCTION_RECIPES_COPY } from '../../apps/web-erp/src/production-recipes-session';

/**
 * Round 4d (M11-FR-01 · Screen D): the Recipes session — what is typed in each product's own unit is sent as the unit's
 * smallest step, never rounded (OB-31); the cheap mistakes are refused before anything is sent; and it sends exactly what
 * head office's recipe route reads.
 */

function fakeHeadOffice(answer: () => unknown = () => ({ version: 1, changed: true })) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => answer() } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const MANAGER = { userId: 'u-mgr', permissions: ['production.read', 'production.recipe.manage'] };
const IDLI = { recipeId: 'idli-batter', departmentId: 'kitchen', outputProductId: 'IDLI-BATTER-1KG', outputQty: '10', outputUom: 'ea', shelfLifeHours: '24', expectedYield: '95', tolerance: '2.5', inputs: [{ productId: 'RICE-IDLI', qty: '6.5', uom: 'kg' }, { productId: 'URAD', qty: '1.25', uom: 'kg' }, { productId: '', qty: '', uom: 'kg' }] };

describe('the Recipes session', () => {
  it('every word has a Tamil twin', () => { expect(Object.keys(PRODUCTION_RECIPES_COPY.ta).sort()).toEqual(Object.keys(PRODUCTION_RECIPES_COPY.en).sort()); });

  it('a percentage is basis points; blank is not given', () => {
    expect(basisPointsOf('92.5')).toBe(9250); expect(basisPointsOf('')).toBeNull(); expect(basisPointsOf('lots')).toBeUndefined();
  });

  it('sends kg as grams and pieces as pieces, never rounded; a blank ingredient line is left out', async () => {
    const ho = fakeHeadOffice(() => ({ version: 2, changed: true }));
    const s = createProductionRecipesSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(await s.save(IDLI)).toEqual({ result: 'ok', value: { recipeId: 'idli-batter', version: 2, changed: true } });
    expect(ho.sent[0]).toEqual({ method: 'POST', path: '/v1/production/recipes/idli-batter', body: {
      departmentId: 'kitchen', outputProductId: 'IDLI-BATTER-1KG', outputQuantityMinor: 10, outputUom: 'ea',
      inputs: [{ productId: 'RICE-IDLI', quantityMinor: 6500, uom: 'kg' }, { productId: 'URAD', quantityMinor: 1250, uom: 'kg' }], shelfLifeHours: 24, expectedYieldBp: 9500, yieldToleranceBp: 250,
    } });
  });

  it('refuses before sending: a bad code, half a piece, a fourth decimal of a kg, no ingredient, no shelf life', async () => {
    const ho = fakeHeadOffice();
    const s = createProductionRecipesSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(await s.save({ ...IDLI, recipeId: 'idli batter!' })).toEqual({ result: 'invalid', why: 'needCode' });
    expect(await s.save({ ...IDLI, outputQty: '2.5' })).toEqual({ result: 'invalid', why: 'badQty' });
    expect(await s.save({ ...IDLI, inputs: [{ productId: 'RICE', qty: '1.2345', uom: 'kg' }] })).toEqual({ result: 'invalid', why: 'badQty' });
    expect(await s.save({ ...IDLI, inputs: [{ productId: '', qty: '', uom: 'kg' }] })).toEqual({ result: 'invalid', why: 'needIngredient' });
    expect(await s.save({ ...IDLI, shelfLifeHours: '0' })).toEqual({ result: 'invalid', why: 'badHours' });
    expect(ho.sent).toHaveLength(0);
  });

  it('a reader may read but not save; nobody may do neither', async () => {
    const ho = fakeHeadOffice(() => ({ recipes: [{ recipeId: 'r', departmentId: 'cafe', outputProductId: 'P', outputQuantityMinor: 4, outputUom: 'ea', inputs: [], shelfLifeHours: 8, version: 3 }], enabledDepartments: ['cafe'] }));
    const reader = createProductionRecipesSession({ viewer: { userId: 'u-x', permissions: ['production.read'] }, fetch: ho.fetch });
    const out = await reader.read();
    expect(out.result === 'ok' && out.value.recipes[0]!.version).toBe(3);
    expect(await reader.save(IDLI)).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await createProductionRecipesSession({ viewer: undefined, fetch: ho.fetch }).read()).toEqual({ result: 'invalid', why: 'nobody' });
  });
});
