import { describe, it, expect } from 'vitest';
import { foldRoleScopes, roleScopeOf, withinTreeScope, type RoleScopeRecord } from '../../services/identity/src/department-scope';

// FG-4 · M02-FR-02 / §28: a person's supplier / category / location reach, from their live grants. A grant holding the
// permission and not limited reaches everything; limited grants are unioned; the latest record per (person, role,
// dimension) stands; a tree scope reaches what lies under it.

const rec = (over: Partial<RoleScopeRecord>): RoleScopeRecord => ({ userId: 'u', roleId: 'store_manager', dimension: 'suppliers', values: ['S1'], reason: 'r', requestedBy: 'm', approvedBy: 'o', approvalId: 'a', at: '2026-10-26T00:00:00Z', ...over });
const perms: Record<string, string[]> = { store_manager: ['purchase.order.propose', 'inventory.movement.append'], cashier: ['pos.sale'], buyer2: ['purchase.order.propose'] };
const of = (records: RoleScopeRecord[], grants: { userId: string; roleId: string }[], permission = 'purchase.order.propose', dimension: 'suppliers' | 'locations' = 'suppliers') =>
  roleScopeOf({ scopes: foldRoleScopes(records), grants, rolePermissions: (r) => perms[r], userId: 'u', permission, dimension });

describe('role scopes (M02-FR-02 · §28)', () => {
  it('an unlimited grant holding the permission reaches everything; a limited one only its own', () => {
    expect(of([], [{ userId: 'u', roleId: 'store_manager' }])).toBe('all');
    expect(of([rec({})], [{ userId: 'u', roleId: 'store_manager' }])).toEqual(['S1']);
    // A second role that also buys and is NOT limited widens it back to all — the reach is the grants' union.
    expect(of([rec({})], [{ userId: 'u', roleId: 'store_manager' }, { userId: 'u', roleId: 'buyer2' }])).toBe('all');
    expect(of([rec({}), rec({ roleId: 'buyer2', values: ['S2'] })], [{ userId: 'u', roleId: 'store_manager' }, { userId: 'u', roleId: 'buyer2' }])).toEqual(['S1', 'S2']);
    // A role without the permission does not count; nobody else's grant counts.
    expect(of([rec({})], [{ userId: 'u', roleId: 'store_manager' }, { userId: 'u', roleId: 'cashier' }, { userId: 'v', roleId: 'buyer2' }])).toEqual(['S1']);
    expect(of([], [{ userId: 'u', roleId: 'cashier' }])).toEqual([]);
  });

  it('the latest record per person, role and dimension stands; a lifted limit is all; dimensions are separate', () => {
    expect(of([rec({}), rec({ values: 'all' })], [{ userId: 'u', roleId: 'store_manager' }])).toBe('all');
    expect(of([rec({ values: 'all' }), rec({ values: ['S9'] })], [{ userId: 'u', roleId: 'store_manager' }])).toEqual(['S9']);
    expect(of([rec({})], [{ userId: 'u', roleId: 'store_manager' }], 'inventory.movement.append', 'locations')).toBe('all');
  });

  it('a tree scope reaches the place itself and what lies under it, never above or beside it', () => {
    const parent: Record<string, string | null> = { bin: 'wh-1', 'wh-1': 'store-1', 'wh-2': 'store-1', 'store-1': 'C1', C1: null };
    const up = (id: string) => parent[id] ?? null;
    expect(withinTreeScope(['wh-1'], 'wh-1', up)).toBe(true);
    expect(withinTreeScope(['wh-1'], 'bin', up)).toBe(true);
    expect(withinTreeScope(['wh-1'], 'wh-2', up)).toBe(false);
    expect(withinTreeScope(['wh-1'], 'store-1', up)).toBe(false);
    expect(withinTreeScope(['wh-1'], null, up)).toBe(false);
    expect(withinTreeScope('all', null, up)).toBe(true);
    const loop = (id: string) => (id === 'a' ? 'b' : 'a');
    expect(withinTreeScope(['z'], 'a', loop)).toBe(false); // a cycle ends, never hangs
  });
});
