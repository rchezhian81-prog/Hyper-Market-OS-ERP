import { describe, it, expect } from 'vitest';
import {
  assignmentsFrom, boxServedItems, navigationPayload, rolesFrom, viewerOf,
} from '../../edge/store-edge/src/screen-navigation';
import { known, notKnown, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { NavItem } from '../../apps/web-erp/src/navigation';

/**
 * **The menu the store computer draws is worked out from the role register, per viewer, default-deny (Stage G slice
 * 5b · §27 role surfaces · P-07 · P-04 · P-08).** No named viewer → nothing and the reason. No register → nothing and
 * the reason. A malformed register row grants nothing. And the box only ever offers the screens it serves.
 */

const CATALOGUE: readonly NavItem[] = [
  { id: 'today', label: 'Today', labelTa: 'இன்று', path: '/manager/', requires: 'erp.dashboard.view', group: 'Overview' },
  { id: 'counts', label: 'Stock counts', labelTa: 'சரக்கு எண்ணிக்கை', path: '/counts/', requires: 'count.view', group: 'Inventory' },
  { id: 'people', label: 'Users & roles', labelTa: 'பயனர்களும் பங்குகளும்', path: '/admin/?tab=people', requires: 'admin.users.manage', group: 'Administration' },
  { id: 'payroll', label: 'Payroll', labelTa: 'ஊதியப் பட்டியல்', path: '/payroll', requires: 'erp.dashboard.view', group: 'Payroll', served: 'unserved' },
  { id: 'settings', label: 'Settings', labelTa: 'அமைப்புகள்', path: '/admin/settings', requires: 'erp.dashboard.view', group: 'Administration', served: 'unbuilt' },
];

const ROLES = [
  { id: 'manager', name: 'Store manager', permissions: ['erp.dashboard.view', 'count.view'] },
  { id: 'admin', name: 'Administrator', permissions: ['admin.users.manage'] },
];
const ASSIGNMENTS = [
  { userId: 'u-mgr', roleId: 'manager', branchScope: ['b1'] },
  { userId: 'u-admin', roleId: 'admin', branchScope: 'all' },
];

/** Only the three registers the menu reads; every other section stays unknown, as on a box that pulled nothing else. */
const packWith = (over: Partial<Pick<StorePack, 'roles' | 'roleAssignments' | 'policies'>> = {}): StorePack => {
  const base = new Proxy({} as Record<string, unknown>, { get: (_t, key) => (key in over ? over[key as keyof typeof over] : notKnown('not pulled')) });
  return base as unknown as StorePack;
};
const POLICIES = known({ storeId: 'store-1', branchId: 'b1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 1, handoverToleranceMinor: 1, privacySlaDays: 30, warehouseId: 'wh-1' }) as StorePack['policies'];
const FULL = packWith({ roles: known(ROLES), roleAssignments: known(ASSIGNMENTS), policies: POLICIES });

const screenOf = (path: string) => (path.startsWith('/manager/') ? 'manager' : path.startsWith('/counts') ? 'counts' : path.startsWith('/admin/') ? 'admin' : null) as never;

describe('the register is read defensively — a half-row grants nothing', () => {
  it('keeps whole role rows and drops malformed ones', () => {
    expect(rolesFrom([...ROLES, { id: 'x' }, 'junk', { id: 'y', name: 'Y', permissions: [1] }, null])).toEqual(ROLES);
  });
  it('keeps whole assignment rows and drops malformed ones', () => {
    expect(assignmentsFrom([...ASSIGNMENTS, { userId: 'u', roleId: 'r', branchScope: 'everywhere' }, { userId: 'u' }, 7])).toEqual(ASSIGNMENTS);
  });
});

describe('who is looking is what the screen\'s own payload says', () => {
  it('reads the top-level userId, or the supervisor\'s on the oversight screen, else nobody', () => {
    expect(viewerOf({ userId: 'u-1' })).toBe('u-1');
    expect(viewerOf({ supervisor: { userId: 'u-sup' } })).toBe('u-sup');
    expect(viewerOf({ storeId: 'store-1' })).toBeNull();
    expect(viewerOf(null)).toBeNull();
    expect(viewerOf({ userId: 42 })).toBeNull();
  });
});

describe('the menu is default-deny and says why when it is empty', () => {
  it('nobody named → no sections, reason no_user — even with a full register', () => {
    const out = navigationPayload({ screen: 'counts', pack: FULL, payload: { storeId: 'store-1' }, screenOf, catalogue: CATALOGUE });
    expect(out).toEqual({ userId: null, branchId: 'b1', why: 'no_user', groups: [] });
  });

  it('no role register on this box → no sections, reason no_roles', () => {
    const out = navigationPayload({ screen: 'counts', pack: packWith({ policies: POLICIES }), payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(out).toEqual({ userId: 'u-mgr', branchId: 'b1', why: 'no_roles', groups: [] });
  });

  it('a named user with no grants → an empty list, and no reason (there is nothing wrong, they may open nothing)', () => {
    const out = navigationPayload({ screen: 'counts', pack: FULL, payload: { userId: 'u-stranger' }, screenOf, catalogue: CATALOGUE });
    expect(out).toEqual({ userId: 'u-stranger', branchId: 'b1', why: null, groups: [] });
  });
});

describe('the menu offers exactly what the person may open on this box', () => {
  it('the manager sees Today and Stock counts, in both languages, with the served screen marked current', () => {
    const out = navigationPayload({ screen: 'counts', pack: FULL, payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(out.why).toBeNull();
    expect(out.groups).toEqual([
      { group: { en: 'Overview', ta: 'கண்ணோட்டம்' }, items: [{ id: 'today', label: { en: 'Today', ta: 'இன்று' }, path: '/manager/', current: false }] },
      { group: { en: 'Inventory', ta: 'சரக்கு' }, items: [{ id: 'counts', label: { en: 'Stock counts', ta: 'சரக்கு எண்ணிக்கை' }, path: '/counts/', current: true }] },
    ]);
  });

  it('the admin, with company-wide scope, sees only their own section — never the manager\'s', () => {
    const out = navigationPayload({ screen: 'admin', pack: FULL, payload: { userId: 'u-admin' }, screenOf, catalogue: CATALOGUE });
    expect(out.groups.map((g) => g.group.en)).toEqual(['Administration']);
    expect(out.groups[0]!.items.map((i) => [i.id, i.current])).toEqual([['people', true]]);
  });

  it('branch scope holds: the manager in another branch sees nothing', () => {
    const elsewhere = packWith({ roles: known(ROLES), roleAssignments: known(ASSIGNMENTS), policies: known({ ...(POLICIES as { value: object }).value, branchId: 'b2' }) as StorePack['policies'] });
    const out = navigationPayload({ screen: 'counts', pack: elsewhere, payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(out.groups).toEqual([]);
    expect(out.branchId).toBe('b2');
  });

  it('never offers an unserved or unbuilt item — the manager holds the permission for both, and sees neither', () => {
    const out = navigationPayload({ screen: 'counts', pack: FULL, payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    const ids = out.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).not.toContain('payroll');
    expect(ids).not.toContain('settings');
    expect(boxServedItems(CATALOGUE).map((i) => i.id)).toEqual(['today', 'counts', 'people']);
  });

  it('a malformed register row is dropped, not fatal: the good rows still grant', () => {
    const scrappy = packWith({ roles: known([...ROLES, { id: 'broken' }]), roleAssignments: known([...ASSIGNMENTS, 'junk']), policies: POLICIES });
    const out = navigationPayload({ screen: 'counts', pack: scrappy, payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(out.groups.length).toBe(2);
  });
});
