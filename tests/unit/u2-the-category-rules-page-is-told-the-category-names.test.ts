import { describe, it, expect } from 'vitest';
import { emptyPack, known, notKnown, type StorePack } from '../../edge/store-edge/src/store-pack';
import { categoryPolicyPayload } from '../../edge/store-edge/src/screen-data';

/**
 * **U2 (UI/UX gap audit G16): the Category rules page is told each category's NAME, never left to show a bare id.**
 *
 * The audit's Tamil sweep found the raw id "dairy" printed beside the rules. The page reads `categoryNames` from its
 * payload when the store computer gives them; the store computer now builds them from the pack's categories, the same
 * register the Today page already names its categories from. With no categories register, no names — the page then
 * shows the id itself (never blank, never invented).
 */
const input = (pack: StorePack) => ({ pack, sales: [], tradingDay: '2026-11-02', now: new Date('2026-11-02T06:00:00Z') }) as unknown as Parameters<typeof categoryPolicyPayload>[0];

describe('the Category rules payload carries the category names', () => {
  const policy = known({ userId: 'u-mgr', permissions: ['catalogue.pack.read'] });

  it('names every category from the pack, by id', () => {
    const pack: StorePack = {
      ...emptyPack('never pulled'),
      categoryPolicyPolicy: policy,
      categoryPolicyCategories: known([{ categoryId: 'dairy', name: 'Dairy', history: [] }]),
      categories: known([{ categoryId: 'dairy', name: 'Dairy', parentId: null }, { categoryId: 'grocery', name: 'Grocery', parentId: null }]),
    } as StorePack;
    expect(categoryPolicyPayload(input(pack))?.['categoryNames']).toEqual({ dairy: 'Dairy', grocery: 'Grocery' });
  });

  it('gives no names when the pack holds no categories register — the page shows the id, not a guess', () => {
    const pack: StorePack = { ...emptyPack('never pulled'), categoryPolicyPolicy: policy, categories: notKnown('not pulled') } as StorePack;
    expect(categoryPolicyPayload(input(pack))).not.toBeNull();
    expect(categoryPolicyPayload(input(pack))?.['categoryNames']).toBeUndefined();
  });
});
