import { describe, it, expect } from 'vitest';
import { AccessControl } from '../../packages/rbac/src/rbac';
import {
  DAILY_GROUP, DAILY_WORK, ERP_NAVIGATION, NAV_GROUP_LABELS, NAV_ITEM_ORDER, NAV_SEARCH_WORDS, navigationFor, permissionsOpening,
} from '../../apps/web-erp/src/navigation';
import { ROLE_CATALOGUE } from '../../services/api/src/roles';

/**
 * **W1 (owner, 1 Nov 2026: "things are hard to find — a long confusing menu, unclear names, too many clicks"; P-07).**
 *
 * The menu is regrouped into task workspaces a store person recognises, each role's daily jobs come first, and plain
 * words find a screen. None of that may change WHO may open WHAT: this file holds the regrouped menu to the product's
 * real roles (services/api/src/roles.ts) and proves, for each, that it offers exactly the screens the role's permissions
 * open — each once — with or without the daily group, in the workspaces' fixed order.
 */

const TAMIL = /[஀-௿]/;
const menuOf = (roleId: string, withRole = true) => {
  const access = new AccessControl(ROLE_CATALOGUE as never, [{ userId: 'u', roleId, branchScope: 'all' }]);
  return navigationFor(access, { userId: 'u', branchId: 'S1', ...(withRole ? { roleIds: [roleId] } : {}) });
};
const permitted = (roleId: string): string[] => {
  const held = new Set(ROLE_CATALOGUE.find((r) => r.id === roleId)!.permissions as readonly string[]);
  return ERP_NAVIGATION.filter((i) => permissionsOpening(i).some((p) => held.has(p))).map((i) => i.id);
};
const PEOPLE_ROLES = ROLE_CATALOGUE.filter((r) => r.permissions.length > 0).map((r) => r.id);

describe('the regrouped menu never changes who may open what (P-04)', () => {
  it.each(PEOPLE_ROLES)('%s: exactly the screens its permissions open, each once, with or without the daily group', (roleId) => {
    const want = permitted(roleId).sort();
    for (const withRole of [true, false]) {
      const ids = menuOf(roleId, withRole).flatMap((g) => g.items.map((i) => i.id));
      expect(new Set(ids).size, `${roleId}: a screen offered twice`).toBe(ids.length);
      expect([...ids].sort()).toEqual(want);
    }
  });

  it('the daily group is first, and only for a role that has daily jobs; the workspaces follow in the fixed order', () => {
    const order = Object.keys(NAV_GROUP_LABELS);
    for (const roleId of PEOPLE_ROLES) {
      const groups = menuOf(roleId).map((g) => g.group);
      const rest = groups[0] === DAILY_GROUP ? groups.slice(1) : groups;
      expect(rest).not.toContain(DAILY_GROUP);
      expect(rest.map((g) => order.indexOf(g))).toEqual([...rest.map((g) => order.indexOf(g))].sort((a, b) => a - b));
      if (DAILY_WORK[roleId] === undefined) expect(groups[0]).not.toBe(DAILY_GROUP);
    }
  });
});

describe('each role the owner named sees its daily jobs first (W1)', () => {
  const daily = (roleId: string) => { const g = menuOf(roleId)[0]!; expect(g.group).toBe(DAILY_GROUP); return g.items.map((i) => i.label); };

  it('the store manager: Today, Approvals, the cash over / short, goods received, stock, expiry, store tasks', () => {
    expect(daily('store_manager')).toEqual(['Today', 'Approvals', 'Cash over / short', 'Goods receipt review', 'Stock health', 'Expiry & recalls', 'Store tasks']);
  });
  it('the owner: Today, Approvals, the morning brief, the company report, his alerts, month-end', () => {
    expect(daily('owner')).toEqual(['Today', 'Approvals', 'Morning brief', 'Company report', 'Owner alerts and schedules', 'Month-end']);
  });
  it('the accountant: the day book, month-end, supplier bills, GST returns, input tax credit, approvals', () => {
    expect(daily('accountant')).toEqual(['Day book', 'Month-end', 'Supplier bills', 'GST returns', 'Input tax credit (GSTR-2B)', 'Approvals']);
  });
  it('the cashier: the till first, then their tasks, approvals, payslip and help — and nothing of the office they cannot open', () => {
    expect(daily('cashier')).toEqual(['Till', 'My tasks', 'Approvals', 'My payslip', 'Help and procedures']);
    const all = menuOf('cashier').flatMap((g) => g.items.map((i) => i.id));
    for (const no of ['finance-close', 'day-book', 'users', 'payroll', 'customers', 'reporting']) expect(all).not.toContain(no);
  });
  it('the cashier\'s whole menu is short enough to stand open (no more than 24 screens)', () => {
    expect(menuOf('cashier').reduce((n, g) => n + g.items.length, 0)).toBeLessThanOrEqual(24);
  });
});

describe('the layout tables name only real screens, in both languages', () => {
  const ids = new Set(ERP_NAVIGATION.map((i) => i.id));
  it('every daily job, ordered screen and search word names a catalogue item; ordered screens are in their own workspace', () => {
    for (const [role, jobs] of Object.entries(DAILY_WORK)) {
      expect(ROLE_CATALOGUE.map((r) => r.id), `${role} is not a product role`).toContain(role);
      for (const id of jobs) expect(ids, `${role} daily job ${id}`).toContain(id);
    }
    for (const [group, lead] of Object.entries(NAV_ITEM_ORDER)) {
      for (const id of lead) expect(ERP_NAVIGATION.find((i) => i.id === id)?.group, `${id} is ordered under ${group}`).toBe(group);
    }
    for (const [id, words] of Object.entries(NAV_SEARCH_WORDS)) {
      expect(ids, `search words for ${id}`).toContain(id);
      expect(words.en.trim()).not.toBe('');
      expect(words.ta, `${id} has no Tamil search word`).toMatch(TAMIL);
    }
  });

  it('every workspace has a plain heading in both languages, and none holds more than 16 screens', () => {
    for (const { en, ta } of Object.values(NAV_GROUP_LABELS)) { expect(en.trim()).not.toBe(''); expect(ta).toMatch(TAMIL); }
    const sizes = new Map<string, number>();
    for (const i of ERP_NAVIGATION) sizes.set(i.group, (sizes.get(i.group) ?? 0) + 1);
    for (const [g, n] of sizes) expect(n, `${g} holds ${n} screens`).toBeLessThanOrEqual(16);
  });

  it('screen ids, paths and permissions are unchanged by the regrouping — the store computer\'s routes still answer', () => {
    // A few the store computer and the tests depend on, pinned as they were before W1.
    const pick = (id: string) => { const i = ERP_NAVIGATION.find((x) => x.id === id)!; return [i.path, i.requires]; };
    expect(pick('dashboard')).toEqual(['/manager/', 'till.dayclose.read']);
    expect(pick('approval-requests')).toEqual(['/approvals', 'identity.self.read']);
    expect(pick('cash-office')).toEqual(['/cash-office', 'till.overshort.review']); // OB-702 (owner, 7 Nov 2026): the reviewer's word, so the cashier is not offered it; the path is unchanged
    expect(pick('finance-close')).toEqual(['/finance-close', 'finance.period.read']);
    expect(pick('customers')).toEqual(['/customers', 'customer.segment.read']);
    expect(pick('reporting')).toEqual(['/reporting/', 'reporting.report.read']);
  });
});
