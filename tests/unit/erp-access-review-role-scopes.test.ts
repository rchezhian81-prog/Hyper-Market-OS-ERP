import { describe, it, expect } from 'vitest';
import { whereWords, ACCESS_REVIEW_COPY } from '../../apps/web-erp/src/access-review-session';

// FG-4 · M02-FR-02: the Access review page says a supplier / category / location limit beside the branch and departments,
// only where one is set — in English and Tamil.

describe('access review — supplier, category and location limits (M02-FR-02)', () => {
  it('says each limit that is set, and nothing for one that is not', () => {
    const base = { roleId: 'store_manager', roleName: 'Store manager', branchScope: 'all' as const, departmentScope: 'all' as const };
    expect(whereWords('en', { ...base, supplierScope: ['sup-1'], categoryScope: ['grocery-cat'], locationScope: 'all' })).toBe('all branches · all departments · suppliers: sup-1 · categories: grocery-cat');
    expect(whereWords('en', { ...base, locationScope: ['wh-1'] })).toBe('all branches · all departments · places: wh-1');
    expect(whereWords('en', base)).toBe('all branches · all departments');
    expect(whereWords('ta', { ...base, locationScope: ['wh-1'] })).toBe('எல்லாக் கிளைகளும் · எல்லாத் துறைகளும் · இடங்கள்: wh-1');
    expect(Object.keys(ACCESS_REVIEW_COPY.ta).sort()).toEqual(Object.keys(ACCESS_REVIEW_COPY.en).sort());
  });
});
