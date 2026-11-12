import { describe, it, expect } from 'vitest';
import { AccessControl } from '../../packages/rbac/src/index';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';
import { ERP_NAVIGATION, navigationFor, canOpen } from '../../apps/web-erp/src/navigation';

/**
 * **OB-702 (owner, 7 Nov 2026, decision 5 of the UI/UX gap audit = A · P-07): the cashier is not offered Cash over / short.**
 * The audit (lane 3, G15): a cashier could open the page on `till.shift.read` and read every till's over/short and who
 * counted it, with no sign-off right — the simplest interface for the role would not offer it. The page's menu word is now
 * the reviewer's (`till.overshort.review`), which the cashier never holds; the store manager and the owner keep it; the
 * store computer refuses the direct link to anyone without that word (its gate reads the same `requires`).
 */
const access = new AccessControl(ROLE_CATALOGUE, [
  { userId: 'u-cash', roleId: 'cashier', branchScope: ['br-1'] },
  { userId: 'u-mgr', roleId: 'store_manager', branchScope: ['br-1'] },
  { userId: 'u-owner', roleId: 'owner', branchScope: 'all' },
  { userId: 'u-acct', roleId: 'accountant', branchScope: 'all' },
]);
const ids = (userId: string): string[] => navigationFor(access, { userId, branchId: 'br-1' }).flatMap((g) => g.items.map((i) => i.id));

describe('OB-702: Cash over / short is the reviewer\'s page', () => {
  it('the menu item asks for the reviewer\'s word, which the cashier does not hold', () => {
    const item = ERP_NAVIGATION.find((i) => i.id === 'cash-office')!;
    expect(item.requires).toBe('till.overshort.review');
    const cashier = ROLE_CATALOGUE.find((r) => r.id === 'cashier')!;
    expect(cashier.permissions).not.toContain('till.overshort.review');
  });
  it('the cashier\'s menu has no Cash over / short and the direct link is refused; the manager and the owner keep it', () => {
    expect(ids('u-cash')).not.toContain('cash-office');
    expect(canOpen(access, { userId: 'u-cash', branchId: 'br-1' }, '/cash-office')).toBe(false);
    expect(ids('u-mgr')).toContain('cash-office');
    expect(canOpen(access, { userId: 'u-mgr', branchId: 'br-1' }, '/cash-office')).toBe(true);
    expect(ids('u-owner')).toContain('cash-office');
    // The accountant never held the till words; nothing changes for that role.
    expect(ids('u-acct')).not.toContain('cash-office');
  });
  it('the cashier keeps the till, the tasks and the Loyalty desk (OB-560)', () => {
    const cashier = ids('u-cash');
    for (const id of ['till', 'my-tasks', 'loyalty-desk']) expect(cashier).toContain(id);
  });
});
