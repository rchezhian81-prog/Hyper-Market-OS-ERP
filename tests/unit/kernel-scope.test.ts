import { describe, it, expect } from 'vitest';
import { ApiError, assertBranchInScope, branchInScope, narrowScope, scopeOf, withinScope } from '../../services/kernel/src/index';

/** The kernel's scope helpers (Wave 2b-ii · PA-01 / EA-03): narrow to what is held, refuse what is not, by name. */
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { if (e instanceof ApiError) return e.body.code; throw e; } return 'no-error'; };

describe('scope helpers', () => {
  it('a context with no scope (a handler run outside the pipeline) holds nothing — fail closed', () => {
    expect(scopeOf({})).toEqual([]);
    expect(branchInScope({}, 'br-1')).toBe(false);
    expect(code(() => assertBranchInScope({}, 'br-1'))).toBe('outside_your_branch_scope');
    expect(code(() => narrowScope({}, ['br-1']))).toBe('scope_not_held');
    expect(narrowScope({})).toEqual([]);
  });

  it('narrows what is held to what was asked for; refuses a branch not held, and "all" unless all is held', () => {
    const held = { scope: ['br-1', 'br-2'] as const };
    expect(narrowScope(held)).toEqual(['br-1', 'br-2']);
    expect(narrowScope(held, ['br-2'])).toEqual(['br-2']);
    expect(code(() => narrowScope(held, ['br-2', 'br-3']))).toBe('scope_not_held');
    expect(code(() => narrowScope(held, 'all'))).toBe('scope_not_held');
    const all = { scope: 'all' as const };
    expect(narrowScope(all)).toBe('all');
    expect(narrowScope(all, 'all')).toBe('all');
    expect(narrowScope(all, ['br-9'])).toEqual(['br-9']);
  });

  it('withinScope keeps the rows of the branches held', () => {
    const rows = [{ branchId: 'br-1', x: 1 }, { branchId: 'br-2', x: 2 }];
    expect(withinScope(['br-2'], rows)).toEqual([{ branchId: 'br-2', x: 2 }]);
    expect(withinScope('all', rows)).toEqual(rows);
    expect(withinScope([], rows)).toEqual([]);
  });
});
