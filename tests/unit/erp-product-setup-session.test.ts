import { describe, it, expect } from 'vitest';
import {
  createProductSetupSession, categoryFromInput, componentsFromInput, packLevelsFromInput, substitutesFromInput, setupOutcomeWords, describeMerge,
  PRODUCT_SETUP_COPY, PRODUCT_SETUP_COPY_KEYS, type ProductSetupHttp, type MergeRow,
} from '../../apps/web-erp/src/product-setup-session';
import type { HttpAnswer } from '../../apps/web-erp/src/finance-close-session';

// G-1 (M03-FR-01 · M03-FR-02 · M03-FR-04): the Product setup tab on Products and prices — a thin client over head office's
// own routes. Each action is offered only to the permission its route checks; a manager's category goes through the owner's
// approval of exactly that definition; the proposer of a merge is never sent to approve it; every refusal is head office's
// own words and an unreachable head office is never a success (P-08). Synthetic data only.

const OWNER = ['catalogue.pack.read', 'catalogue.pack.publish', 'catalogue.category.propose', 'catalogue.category.approve', 'catalogue.merge.propose', 'catalogue.merge.approve'];
const MANAGER = ['catalogue.pack.read', 'catalogue.merge.propose', 'catalogue.category.propose'];
const CASHIER = ['catalogue.pack.read'];

function fakeHttp(answer: HttpAnswer | ((method: string, path: string) => HttpAnswer)): ProductSetupHttp & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const pick = (m: string, p: string): HttpAnswer => (typeof answer === 'function' ? answer(m, p) : answer);
  return {
    calls,
    get: async (path) => { calls.push({ method: 'GET', path }); return pick('GET', path); },
    post: async (path, body) => { calls.push({ method: 'POST', path, body }); return pick('POST', path); },
  };
}
const OK = { status: 201, body: {} };
const CAT = { categoryId: ' hair ', name: ' Hair care ', parentId: ' home ', regulated: ['packed', 'food', 'packed'], attributes: 'size, Size, text\n\n' };
const merge = (by: string): MergeRow => ({ request: { mergeId: 'merge-1', keepProductId: 'a', supersedeProductId: 'b', requestedBy: by, reason: 'same item' }, status: 'pending' });

describe('the Product setup tab (G-1 · M03-FR-01/02/04)', () => {
  it('every word has a Tamil twin, and none is left in English', () => {
    for (const k of PRODUCT_SETUP_COPY_KEYS) {
      expect(PRODUCT_SETUP_COPY.ta[k].trim(), k).not.toBe('');
      expect(PRODUCT_SETUP_COPY.ta[k], k).not.toBe(PRODUCT_SETUP_COPY.en[k]);
    }
    expect(Object.keys(PRODUCT_SETUP_COPY.ta).sort()).toEqual([...PRODUCT_SETUP_COPY_KEYS].sort());
  });

  it('reads what the person typed exactly as head office will (so an approval matches what is saved)', () => {
    expect(categoryFromInput(CAT)).toEqual({ categoryId: 'hair', name: 'Hair care', parentId: 'home', regulated: ['food', 'packed'], attributes: [{ key: 'size', label: 'Size', type: 'text' }] });
    expect(categoryFromInput({ ...CAT, parentId: ' ', regulated: [], attributes: '' })).toEqual({ categoryId: 'hair', name: 'Hair care', parentId: null });
    expect(categoryFromInput({ ...CAT, name: '' })).toBeUndefined();
    expect(categoryFromInput({ ...CAT, attributes: 'size, Size, colour' })).toBeUndefined();
    expect(componentsFromInput('tea 2\n mug 1 ')).toEqual([{ productId: 'tea', quantityMinor: 2 }, { productId: 'mug', quantityMinor: 1 }]);
    expect(componentsFromInput('tea two')).toBeUndefined();
    // The pack count goes as typed — a decimal too: exactness is head office's to judge, and its refusal is shown.
    expect(packLevelsFromInput('each 1\ninner pack 6\ncase 2.5')).toEqual([{ level: 'each', containsMinor: 1 }, { level: 'inner pack', containsMinor: 6 }, { level: 'case', containsMinor: 2.5 }]);
    expect(packLevelsFromInput('case')).toBeUndefined();
    expect(substitutesFromInput('b, c\n d \n')).toEqual(['b', 'c', 'd']);
    expect(substitutesFromInput('  ')).toEqual([]);
  });

  it('the owner saves a category directly; the body is the definition, the code in the path', async () => {
    const http = fakeHttp({ status: 201, body: { category: {}, changed: true } });
    const s = createProductSetupSession({ userId: 'u-owner', permissions: OWNER }, http);
    expect((await s.defineCategory(CAT)).kind).toBe('done');
    expect(http.calls).toEqual([{ method: 'POST', path: '/v1/catalogue/categories/hair', body: { name: 'Hair care', parentId: 'home', regulated: ['food', 'packed'], attributes: [{ key: 'size', label: 'Size', type: 'text' }] } }]);
  });

  it('a manager cannot save a category without the owner\'s approval; asks for exactly it; saves it with that approval', async () => {
    const http = fakeHttp((m, p) => (m === 'GET' && p === '/v1/approvals/requests'
      ? { status: 200, body: { mine: [
        { requestId: 'areq-1', kind: 'category_define', subjectRef: 'hair', status: 'approved', details: { categoryId: 'hair', name: 'Hair care', parentId: null } },
        { requestId: 'areq-2', kind: 'price_change', subjectRef: 'p1', status: 'approved', details: {} },
      ] } }
      : OK));
    const s = createProductSetupSession({ userId: 'u-mgr', permissions: MANAGER }, http);
    expect(await s.defineCategory(CAT)).toEqual({ kind: 'invalid', detail: 'approval' });
    expect(await s.askCategory(CAT, ' ')).toEqual({ kind: 'invalid', detail: 'reason' });
    expect(http.calls).toEqual([]);
    expect((await s.askCategory(CAT, 'new hair aisle')).kind).toBe('done');
    expect(http.calls[0]).toEqual({ method: 'POST', path: '/v1/approvals/requests', body: {
      kind: 'category_define', subjectRef: 'hair', valueMinor: null, reason: 'new hair aisle', summary: 'Add or change the product category hair (Hair care)',
      details: { categoryId: 'hair', name: 'Hair care', parentId: 'home', regulated: ['food', 'packed'], attributes: [{ key: 'size', label: 'Size', type: 'text' }] },
    } });
    const asked = await s.askedCategories();
    expect(asked.kind === 'done' ? asked.body.map((a) => a.requestId) : asked).toEqual(['areq-1']);
    if (asked.kind !== 'done') throw new Error('unread');
    expect(await s.saveApprovedCategory({ ...asked.body[0]!, status: 'waiting' })).toEqual({ kind: 'invalid', detail: 'approval' });
    await s.saveApprovedCategory(asked.body[0]!);
    expect(http.calls.at(-1)).toEqual({ method: 'POST', path: '/v1/catalogue/categories/hair', body: { name: 'Hair care', parentId: null, approvalId: 'areq-1' } });
  });

  it('bundles, pack sizes and substitutes are the product role\'s; a cashier reads and is sent nowhere to write', async () => {
    const http = fakeHttp(OK);
    const owner = createProductSetupSession({ permissions: OWNER }, http);
    await owner.defineBundle('gift-box', 'tea 2\nmug 1', 'Diwali box');
    await owner.definePack('rice', 'each', 'each 1\ncase 24');
    await owner.setSubstitutes('dal', 'dal-b\ndal-c', 'same dal');
    await owner.setSubstitutes('dal', '', 'no longer');
    expect(await owner.defineBundle('gift-box', 'tea 2', '')).toEqual({ kind: 'invalid', detail: 'reason' });
    expect(http.calls).toEqual([
      { method: 'POST', path: '/v1/catalogue/bundles/gift-box', body: { components: [{ productId: 'tea', quantityMinor: 2 }, { productId: 'mug', quantityMinor: 1 }], reason: 'Diwali box' } },
      { method: 'POST', path: '/v1/catalogue/products/rice/pack', body: { baseUom: 'each', levels: [{ level: 'each', containsMinor: 1 }, { level: 'case', containsMinor: 24 }] } },
      { method: 'POST', path: '/v1/catalogue/products/dal/substitutes', body: { substitutes: ['dal-b', 'dal-c'], reason: 'same dal' } },
      { method: 'POST', path: '/v1/catalogue/products/dal/substitutes', body: { substitutes: [], reason: 'no longer' } },
    ]);
    const cashierHttp = fakeHttp({ status: 200, body: {} });
    const cashier = createProductSetupSession({ permissions: CASHIER }, cashierHttp);
    expect(cashier.may).toEqual({ read: true, publish: false, categoryPropose: false, categoryApprove: false, mergePropose: false, mergeApprove: false });
    expect((await cashier.defineBundle('gift-box', 'tea 2', 'x')).kind).toBe('not_allowed');
    expect((await cashier.definePack('rice', 'each', 'each 1')).kind).toBe('not_allowed');
    expect((await cashier.setSubstitutes('dal', 'x', 'y')).kind).toBe('not_allowed');
    expect((await cashier.defineCategory(CAT)).kind).toBe('not_allowed');
    expect((await cashier.proposeMerge({ keepProductId: 'a', supersedeProductId: 'b', reason: 'r' })).kind).toBe('not_allowed');
    await cashier.variantReport(' hair ');
    await cashier.variantReport('');
    await cashier.pack('rice');
    expect(cashierHttp.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/catalogue/reports/variants?categoryId=hair', 'GET /v1/catalogue/reports/variants', 'GET /v1/catalogue/products/rice/pack']);
  });

  it('a merge is proposed under a fresh id; the proposer is never sent to approve it, but a different person is', async () => {
    const http = fakeHttp(OK);
    const owner = createProductSetupSession({ userId: 'u-owner', permissions: OWNER }, http, () => 'abc');
    expect(await owner.proposeMerge({ keepProductId: 'a', supersedeProductId: 'b', reason: ' ' })).toEqual({ kind: 'invalid', detail: 'reason' });
    await owner.proposeMerge({ keepProductId: ' a ', supersedeProductId: 'b', reason: 'same item' });
    expect(http.calls).toEqual([{ method: 'POST', path: '/v1/catalogue/merges/merge-abc', body: { keepProductId: 'a', supersedeProductId: 'b', reason: 'same item' } }]);
    expect(await owner.decideMerge(merge('u-owner'), 'approved')).toEqual({ kind: 'invalid', detail: 'own' });
    expect(http.calls).toHaveLength(1);
    await owner.decideMerge(merge('u-mgr'), 'approved');
    expect(http.calls.at(-1)).toEqual({ method: 'POST', path: '/v1/catalogue/merges/merge-1/decision', body: { decision: 'approved' } });
    const manager = createProductSetupSession({ userId: 'u-mgr', permissions: MANAGER }, http);
    expect((await manager.decideMerge(merge('u-owner'), 'approved')).kind).toBe('not_allowed');
    expect(describeMerge('en', merge('u-mgr'))).toBe('Keep a, merge b into it — proposed by u-mgr: same item · waiting for a second person');
  });

  it('a refusal is head office\'s own words; unreachable says nothing was saved — never a success', async () => {
    const refused = createProductSetupSession({ permissions: OWNER }, fakeHttp({ status: 422, body: { error: { code: 'pack_hierarchy_is_not_exact', whatHappened: 'This pack cannot be defined: a case holds 2.5.', nextSafeAction: 'Nothing was saved.' } } }));
    const out = await refused.definePack('rice', 'each', 'each 1\ncase 2.5');
    expect(setupOutcomeWords('en', out, 'packSaved')).toEqual({ ok: false, text: 'Head office refused: This pack cannot be defined: a case holds 2.5. Nothing was saved.' });
    const offline = createProductSetupSession({ permissions: OWNER }, fakeHttp({ status: 0, body: null }));
    expect(setupOutcomeWords('en', await offline.setSubstitutes('dal', 'x', 'y'), 'subSaved')).toEqual({ ok: false, text: 'Head office cannot be reached — nothing was saved. Try again when the connection is back.' });
    expect(setupOutcomeWords('ta', await offline.setSubstitutes('dal', 'x', 'y'), 'subSaved').text).toMatch(/^தலைமை அலுவலகத்தை அடைய முடியவில்லை/);
    expect(setupOutcomeWords('en', { kind: 'done', status: 201, body: {} }, 'bunSaved')).toEqual({ ok: true, text: 'Saved at head office as a new version.' });
  });
});
