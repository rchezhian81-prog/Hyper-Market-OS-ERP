import { describe, it, expect } from 'vitest';
import { canOpen, navigationFor } from '../../apps/web-erp/src/navigation';
import { AccessControl } from '../../packages/rbac/src/index';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **OB-509 (owner, 28 Oct 2026): the accountant reaches "Deliveries waiting for their bill" from the menu.** The section sits
 * on the Supplier bills page; the accountant holds the right to match a bill to a delivery (`purchase.invoice.match`) but not
 * the right to enter bills, so the menu item is gated on the match right. Every role that may enter bills may also match
 * them, so nobody loses the item. Real role catalogue, so a change to the roles shows here.
 */

const access = new AccessControl(ROLE_CATALOGUE, [
  { userId: 'u-acct', roleId: 'accountant', branchScope: 'all' },
  { userId: 'u-mgr', roleId: 'store_manager', branchScope: ['b1'] },
  { userId: 'u-cash', roleId: 'cashier', branchScope: ['b1'] },
]);
const ids = (userId: string): string[] => navigationFor(access, { userId, branchId: 'b1' }).flatMap((g) => g.items.map((i) => i.id));

describe('OB-509 — who reaches the bill match from the menu', () => {
  it('the accountant and the store manager see Supplier bills; a cashier does not', () => {
    expect(ids('u-acct')).toContain('supplier-bills');
    expect(canOpen(access, { userId: 'u-acct', branchId: 'b1' }, '/supplier-bills')).toBe(true);
    expect(ids('u-mgr')).toContain('supplier-bills');
    expect(ids('u-cash')).not.toContain('supplier-bills');
  });

  it('every role that may enter bills may also match them, so gating on the match right takes the item from nobody', () => {
    for (const role of ROLE_CATALOGUE) {
      if (role.permissions.includes('purchase.invoice.capture')) expect(role.permissions, role.id).toContain('purchase.invoice.match');
    }
  });
});
