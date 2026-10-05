import { describe, it, expect } from 'vitest';
import { AccessControl } from '../../packages/rbac/src/rbac';

/** Where may this person exercise a permission — the server's answer from the grants (Wave 2b-ii · PA-01 / EA-03). */
const ROLES = [
  { id: 'mgr', name: 'Manager', permissions: ['report.read', 'roster.manage'] },
  { id: 'owner', name: 'Owner', permissions: ['report.read', 'roster.manage', 'everything'] },
  { id: 'clerk', name: 'Clerk', permissions: ['report.read'] },
];

describe('AccessControl.branchScopeOf', () => {
  it('is the union of the branches of the grants that carry the permission, sorted; [] when none', () => {
    const ac = new AccessControl(ROLES, [
      { userId: 'u', roleId: 'mgr', branchScope: ['br-2', 'br-1'] },
      { userId: 'u', roleId: 'clerk', branchScope: ['br-3'] },
    ]);
    expect(ac.branchScopeOf('u', 'report.read')).toEqual(['br-1', 'br-2', 'br-3']);
    expect(ac.branchScopeOf('u', 'roster.manage')).toEqual(['br-1', 'br-2']); // the clerk grant does not carry it
    expect(ac.branchScopeOf('u', 'everything')).toEqual([]);
    expect(ac.branchScopeOf('nobody', 'report.read')).toEqual([]);
  });

  it("is 'all' as soon as any grant carrying the permission is company-wide", () => {
    const ac = new AccessControl(ROLES, [
      { userId: 'u', roleId: 'mgr', branchScope: ['br-1'] },
      { userId: 'u', roleId: 'owner', branchScope: 'all' },
    ]);
    expect(ac.branchScopeOf('u', 'report.read')).toBe('all');
  });

  it('a role the catalogue does not know grants no scope', () => {
    const ac = new AccessControl(ROLES, [{ userId: 'u', roleId: 'ghost', branchScope: 'all' }]);
    expect(ac.branchScopeOf('u', 'report.read')).toEqual([]);
  });
});
