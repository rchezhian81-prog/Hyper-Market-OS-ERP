import { describe, it, expect } from 'vitest';
import {
  AccessControl,
  AccessDeniedError,
  isPermission,
  type Role,
  type RoleAssignment,
} from '../../packages/rbac/src/index';

// RBAC is default-deny (P-04): a user may do ONLY what an assigned role explicitly
// grants, within scope. These tests pin the deny-by-default behaviour and the
// branch-scope rules (M02-FR-02).

const cashier: Role = {
  id: 'role-cashier',
  name: 'Cashier',
  permissions: ['pos.sale.create', 'pos.sale.suspend'],
};
const manager: Role = {
  id: 'role-manager',
  name: 'Manager',
  permissions: ['pos.sale.void', 'price.change.approve'],
};

describe('permission codes', () => {
  it('validates well-formed codes and rejects the rest', () => {
    expect(isPermission('pos.sale.create')).toBe(true);
    expect(isPermission('price.change.approve')).toBe(true);
    expect(isPermission('pos')).toBe(false); // needs at least two segments
    expect(isPermission('Pos.Sale')).toBe(false); // upper-case
    expect(isPermission('')).toBe(false);
  });
});

describe('default-deny access control', () => {
  it('denies a user with no assignments', () => {
    const ac = new AccessControl([cashier], []);
    expect(ac.can({ userId: 'u1', permission: 'pos.sale.create', branchId: 'branch-1' })).toBe(
      false,
    );
  });

  it('grants only what an assigned role holds, and denies the rest', () => {
    const assignments: RoleAssignment[] = [
      { userId: 'u1', roleId: 'role-cashier', branchScope: ['branch-1'] },
    ];
    const ac = new AccessControl([cashier, manager], assignments);
    expect(ac.can({ userId: 'u1', permission: 'pos.sale.create', branchId: 'branch-1' })).toBe(
      true,
    );
    // has the role but not this permission
    expect(ac.can({ userId: 'u1', permission: 'pos.sale.void', branchId: 'branch-1' })).toBe(
      false,
    );
  });

  it('honours branch scope', () => {
    const ac = new AccessControl(
      [cashier],
      [{ userId: 'u1', roleId: 'role-cashier', branchScope: ['branch-1'] }],
    );
    expect(ac.can({ userId: 'u1', permission: 'pos.sale.create', branchId: 'branch-2' })).toBe(
      false,
    );
    // a branch-scoped grant does not authorise a company-wide action
    expect(ac.can({ userId: 'u1', permission: 'pos.sale.create', branchId: null })).toBe(false);
  });

  it('an "all"-scope grant covers every branch and company-wide actions', () => {
    const ac = new AccessControl(
      [manager],
      [{ userId: 'owner', roleId: 'role-manager', branchScope: 'all' }],
    );
    expect(ac.can({ userId: 'owner', permission: 'price.change.approve', branchId: 'branch-9' })).toBe(
      true,
    );
    expect(ac.can({ userId: 'owner', permission: 'price.change.approve', branchId: null })).toBe(
      true,
    );
  });

  it('unions permissions across multiple assigned roles and ignores unknown roles', () => {
    const ac = new AccessControl(
      [cashier, manager],
      [
        { userId: 'u2', roleId: 'role-cashier', branchScope: ['branch-1'] },
        { userId: 'u2', roleId: 'role-manager', branchScope: ['branch-1'] },
        { userId: 'u2', roleId: 'role-ghost', branchScope: 'all' },
      ],
    );
    expect(ac.can({ userId: 'u2', permission: 'pos.sale.create', branchId: 'branch-1' })).toBe(true);
    expect(ac.can({ userId: 'u2', permission: 'pos.sale.void', branchId: 'branch-1' })).toBe(true);
    // the unknown role grants nothing extra
    expect(ac.can({ userId: 'u2', permission: 'admin.everything', branchId: 'branch-1' })).toBe(
      false,
    );
  });

  it('assertCan throws AccessDeniedError only when denied', () => {
    const ac = new AccessControl(
      [cashier],
      [{ userId: 'u1', roleId: 'role-cashier', branchScope: ['branch-1'] }],
    );
    expect(() =>
      ac.assertCan({ userId: 'u1', permission: 'pos.sale.create', branchId: 'branch-1' }),
    ).not.toThrow();
    expect(() =>
      ac.assertCan({ userId: 'u1', permission: 'pos.sale.void', branchId: 'branch-1' }),
    ).toThrow(AccessDeniedError);
  });
});
