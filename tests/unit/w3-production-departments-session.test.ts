import { describe, it, expect } from 'vitest';
import { createProductionRecipesSession, PRODUCTION_RECIPES_COPY } from '../../apps/web-erp/src/production-recipes-session';

/**
 * W3 (M11-FR-04): the Recipes page switches a production department on. Before this, the page told a new shop "switch one on
 * first" and no screen could. The session reads the departments head office says the shop runs, and sends exactly the
 * switch-on route; only the store manager's permission may send it; head office's refusal (a department the plan does not
 * include) is passed on in its own words.
 */

function fakeHeadOffice(answer: (path: string) => { status: number; body: unknown }) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetch = (async (path: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, path, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const a = answer(path);
    return { ok: a.status < 300, status: a.status, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}
const MANAGER = { userId: 'u-mgr', permissions: ['production.read', 'production.recipe.manage'] };

describe('the Recipes page switches a production department on (M11-FR-04)', () => {
  it('every new word has a Tamil twin', () => {
    for (const k of ['deptH', 'deptLead', 'deptIsOn', 'deptIsOff', 'switchOn', 'switchedOn', 'switching', 'needDepartmentId']) {
      expect(PRODUCTION_RECIPES_COPY.ta).toHaveProperty(k);
      expect(PRODUCTION_RECIPES_COPY.en).toHaveProperty(k);
    }
  });

  it('reads the departments the shop runs and every one the product supports', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: { operated: [{ departmentId: 'cafe', label: 'Cafe' }], available: ['cafe', 'bakery', 'deli', 'meat_fish', 'kitchen'] } }));
    const s = createProductionRecipesSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(await s.departments()).toEqual({ result: 'ok', value: { on: ['cafe'], available: ['cafe', 'bakery', 'deli', 'meat_fish', 'kitchen'] } });
    expect(ho.sent).toEqual([{ method: 'GET', path: '/v1/production/departments', body: undefined }]);
  });

  it('switching on sends exactly the department route with an empty body', async () => {
    const ho = fakeHeadOffice(() => ({ status: 201, body: { departmentId: 'kitchen', department: { label: 'Central kitchen' } } }));
    const s = createProductionRecipesSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(await s.switchOn('kitchen')).toEqual({ result: 'ok', value: { departmentId: 'kitchen' } });
    expect(ho.sent).toEqual([{ method: 'POST', path: '/v1/production/departments/kitchen', body: {} }]);
  });

  it('head office refusing a department the plan does not include is passed on in its words', async () => {
    const ho = fakeHeadOffice(() => ({ status: 403, body: { error: { code: 'feature_not_entitled', whatHappened: 'Your plan does not include dept.bakery.' } } }));
    const s = createProductionRecipesSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(await s.switchOn('bakery')).toEqual({ result: 'refused', status: 403, code: 'feature_not_entitled', whatHappened: 'Your plan does not include dept.bakery.' });
  });

  it('a reader may see the departments but not switch one on; a bad id and nobody send nothing', async () => {
    const ho = fakeHeadOffice(() => ({ status: 200, body: { operated: [], available: ['cafe'] } }));
    const reader = createProductionRecipesSession({ viewer: { userId: 'u-x', permissions: ['production.read'] }, fetch: ho.fetch });
    expect((await reader.departments()).result).toBe('ok');
    expect(await reader.switchOn('cafe')).toEqual({ result: 'invalid', why: 'cannotManage' });
    const mgr = createProductionRecipesSession({ viewer: MANAGER, fetch: ho.fetch });
    expect(await mgr.switchOn('../cafe')).toEqual({ result: 'invalid', why: 'needDepartmentId' });
    expect(await createProductionRecipesSession({ viewer: undefined, fetch: ho.fetch }).switchOn('cafe')).toEqual({ result: 'invalid', why: 'nobody' });
    expect(ho.sent.filter((x) => x.method === 'POST')).toHaveLength(0);
  });
});
