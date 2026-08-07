import { describe, it, expect } from 'vitest';
import { AccessControl, AccessDeniedError, type Role, type RoleAssignment } from '../../packages/rbac/src/rbac';

// SEC-02, SEC-03 — zero-trust identities, least privilege, default deny.
//
// **A test that proves a manager CAN approve proves nothing about whether a cashier cannot.**
// That is the whole shape of an access-control bug: the allow path is exercised constantly, by
// every feature test and by every person using the product, and it is correct. The deny path is
// exercised by an attacker, once, in production.
//
// So this file sweeps the **complement**. Every user × every permission × every branch, with the
// granted set computed independently from the role table — and every combination outside it must
// be refused. 5 users × 12 permissions × 4 scopes is 240 decisions, and a rule that leaks does
// not leak on the one combination somebody thought to write a test for.

const PERMISSIONS = [
  'sale.commit', 'sale.void', 'price.change', 'refund.issue', 'purchase.approve',
  'stock.adjust', 'user.manage', 'report.view', 'cash.declare', 'day.close',
  'audit.read', 'tenant.configure',
] as const;

const BRANCHES = ['br-main', 'br-annex', 'br-warehouse'] as const;
/** `null` is a company-wide action — deliberately in the sweep, because it is its own scope. */
const SCOPES: readonly (string | null)[] = [...BRANCHES, null];

const ROLES: readonly Role[] = [
  { id: 'r-cashier', name: 'Cashier', permissions: ['sale.commit', 'cash.declare'] },
  { id: 'r-supervisor', name: 'Supervisor', permissions: ['sale.commit', 'sale.void', 'cash.declare', 'day.close'] },
  { id: 'r-manager', name: 'Manager', permissions: ['sale.void', 'price.change', 'refund.issue', 'stock.adjust', 'report.view', 'day.close'] },
  { id: 'r-buyer', name: 'Buyer', permissions: ['purchase.approve', 'report.view'] },
  { id: 'r-admin', name: 'Administrator', permissions: ['user.manage', 'audit.read', 'tenant.configure'] },
];

const ASSIGNMENTS: readonly RoleAssignment[] = [
  { userId: 'u-cashier', roleId: 'r-cashier', branchScope: ['br-main'] },
  { userId: 'u-supervisor', roleId: 'r-supervisor', branchScope: ['br-main', 'br-annex'] },
  { userId: 'u-manager', roleId: 'r-manager', branchScope: 'all' },
  { userId: 'u-buyer', roleId: 'r-buyer', branchScope: ['br-warehouse'] },
  { userId: 'u-admin', roleId: 'r-admin', branchScope: 'all' },
];

const USERS = ASSIGNMENTS.map((a) => a.userId);
const ac = new AccessControl(ROLES, ASSIGNMENTS);

/**
 * What SHOULD be allowed, computed from the tables independently of the implementation.
 *
 * Deliberately not by calling `ac.can` — an oracle that asks the thing under test is a tautology,
 * and a sweep built on one is 240 assertions that the code agrees with itself.
 */
function shouldAllow(userId: string, permission: string, branchId: string | null): boolean {
  for (const a of ASSIGNMENTS) {
    if (a.userId !== userId) continue;
    const role = ROLES.find((r) => r.id === a.roleId);
    if (role === undefined || !role.permissions.includes(permission)) continue;
    if (a.branchScope === 'all') return true;
    if (branchId === null) continue; // a company-wide action needs an "all"-scope grant
    if (a.branchScope.includes(branchId)) return true;
  }
  return false;
}

describe('the full deny matrix, not a handful of allows', () => {
  it('agrees with the role tables on all 240 combinations', () => {
    const wrong: string[] = [];
    let allowed = 0;
    let denied = 0;

    for (const userId of USERS) {
      for (const permission of PERMISSIONS) {
        for (const branchId of SCOPES) {
          const expected = shouldAllow(userId, permission, branchId);
          const actual = ac.can({ userId, permission, branchId });
          if (actual !== expected) {
            wrong.push(`${userId} / ${permission} / ${branchId ?? 'company-wide'}: expected ${expected}, got ${actual}`);
          }
          if (expected) allowed += 1; else denied += 1;
        }
      }
    }

    expect(wrong).toEqual([]);
    expect(allowed + denied).toBe(USERS.length * PERMISSIONS.length * SCOPES.length);
    // The denials are the point. If this number ever collapses, the sweep has stopped sweeping.
    expect(denied).toBeGreaterThan(allowed * 3);
  });

  it('denies a cashier every single privileged permission, in every branch', () => {
    const privileged = ['price.change', 'refund.issue', 'user.manage', 'tenant.configure', 'audit.read', 'purchase.approve'];
    for (const permission of privileged) {
      for (const branchId of SCOPES) {
        expect(ac.can({ userId: 'u-cashier', permission, branchId }), `${permission} @ ${branchId}`).toBe(false);
      }
    }
  });

  it('denies an unknown user everything — absence is not a grant', () => {
    for (const permission of PERMISSIONS) {
      for (const branchId of SCOPES) {
        expect(ac.can({ userId: 'u-nobody', permission, branchId })).toBe(false);
      }
    }
  });
});

describe('the escalation attempts an attacker actually makes', () => {
  it('grants nothing through a role that does not exist', () => {
    // The realistic version: a role is deleted, the assignment row survives. The dangerous
    // reading of that row is "unconstrained"; the correct one is "grants nothing".
    const orphaned = new AccessControl(ROLES, [
      { userId: 'u-ghost', roleId: 'r-deleted', branchScope: 'all' },
    ]);
    for (const permission of PERMISSIONS) {
      expect(orphaned.can({ userId: 'u-ghost', permission, branchId: null })).toBe(false);
    }
  });

  it('treats an EMPTY branch scope as no branches, never as all of them', () => {
    // `[]` and `'all'` are one keystroke apart in a config file, and the failure is silent.
    const empty = new AccessControl(ROLES, [{ userId: 'u-empty', roleId: 'r-manager', branchScope: [] }]);
    for (const branchId of SCOPES) {
      expect(empty.can({ userId: 'u-empty', permission: 'price.change', branchId })).toBe(false);
    }
  });

  it('does NOT let a branch-scoped grant reach a company-wide action', () => {
    // The supervisor may close the day in two named branches. "Close the day everywhere" is a
    // different act, and inferring it from a branch grant is how one shop's supervisor closes
    // the group.
    expect(ac.can({ userId: 'u-supervisor', permission: 'day.close', branchId: 'br-main' })).toBe(true);
    expect(ac.can({ userId: 'u-supervisor', permission: 'day.close', branchId: null })).toBe(false);
  });

  it('does not leak a permission across branches within one user', () => {
    // The buyer approves purchases in the warehouse. That must not become the shop floor.
    expect(ac.can({ userId: 'u-buyer', permission: 'purchase.approve', branchId: 'br-warehouse' })).toBe(true);
    for (const branchId of ['br-main', 'br-annex']) {
      expect(ac.can({ userId: 'u-buyer', permission: 'purchase.approve', branchId })).toBe(false);
    }
  });

  it('is case-sensitive and exact — no near-miss ever grants', () => {
    for (const near of ['Sale.Commit', 'sale.Commit', 'SALE.COMMIT', 'sale.commit ', ' sale.commit', 'sale.commit.extra', 'sale']) {
      expect(ac.can({ userId: 'u-cashier', permission: near, branchId: 'br-main' }), near).toBe(false);
    }
  });

  it('does not treat a permission as a prefix of a wider one', () => {
    // If `sale.void` ever satisfied a check for `sale`, or `price.change` for `price.change.bulk`,
    // the whole permission naming scheme becomes a hierarchy nobody designed.
    expect(ac.can({ userId: 'u-manager', permission: 'price', branchId: null })).toBe(false);
    expect(ac.can({ userId: 'u-manager', permission: 'price.change.bulk', branchId: null })).toBe(false);
  });

  it('does not let a branch name that merely CONTAINS a granted one pass', () => {
    for (const branchId of ['br-main-2', 'br-mai', 'BR-MAIN', 'br-main ']) {
      expect(ac.can({ userId: 'u-cashier', permission: 'sale.commit', branchId }), branchId).toBe(false);
    }
  });

  it('cannot be widened by adding assignments after construction', () => {
    // The tables are copied at construction. A caller holding the array it passed in must not be
    // able to grant themselves anything by pushing to it afterwards.
    const mutable: RoleAssignment[] = [{ userId: 'u-x', roleId: 'r-cashier', branchScope: ['br-main'] }];
    const control = new AccessControl(ROLES, mutable);
    mutable.push({ userId: 'u-x', roleId: 'r-admin', branchScope: 'all' });
    expect(control.can({ userId: 'u-x', permission: 'user.manage', branchId: null })).toBe(false);
  });

  it('cannot be widened by mutating a role\'s permission list afterwards', () => {
    // `readonly Permission[]` stops this in TypeScript and stops nothing at a JSON boundary,
    // which is where role configuration actually arrives from. The permission list is copied at
    // construction for the same reason the assignments are.
    const roles: Role[] = [{ id: 'r-t', name: 'T', permissions: ['report.view'] }];
    const control = new AccessControl(roles, [{ userId: 'u-t', roleId: 'r-t', branchScope: 'all' }]);
    try {
      (roles[0]!.permissions as string[]).push('user.manage');
    } catch { /* a frozen source array is fine too — the point is the control is unmoved */ }
    expect(control.can({ userId: 'u-t', permission: 'user.manage', branchId: null })).toBe(false);
    expect(control.can({ userId: 'u-t', permission: 'report.view', branchId: null })).toBe(true);
  });
});

describe('assertCan refuses loudly, and says who lacked what', () => {
  it('throws a named error a log can be searched for', () => {
    expect(() => ac.assertCan({ userId: 'u-cashier', permission: 'refund.issue', branchId: 'br-main' }))
      .toThrow(AccessDeniedError);
  });

  it('names the user, the permission and the place — a denial nobody can diagnose gets bypassed', () => {
    try {
      ac.assertCan({ userId: 'u-cashier', permission: 'refund.issue', branchId: 'br-main' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('u-cashier');
      expect(message).toContain('refund.issue');
      expect(message).toContain('br-main');
    }
  });

  it('says "company-wide" rather than "null" for an unscoped action', () => {
    try {
      ac.assertCan({ userId: 'u-cashier', permission: 'tenant.configure', branchId: null });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('company-wide');
    }
  });

  it('does not throw where the sweep says it is allowed', () => {
    expect(() => ac.assertCan({ userId: 'u-manager', permission: 'price.change', branchId: 'br-annex' })).not.toThrow();
  });
});
