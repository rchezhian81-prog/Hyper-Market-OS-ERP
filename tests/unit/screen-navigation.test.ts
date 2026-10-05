import { describe, it, expect } from 'vitest';
import {
  asSignedInPerson, assignmentsFrom, boxServedItems, branchOf, navigationPayload, peopleFrom, permissionsOf, personOf, rolesFrom, viewerOf,
} from '../../edge/store-edge/src/screen-navigation';
import { known, notKnown, type StorePack } from '../../edge/store-edge/src/store-pack';
import type { NavItem } from '../../apps/web-erp/src/navigation';

/**
 * **The menu the store computer draws is worked out from the role register, per viewer, default-deny (Stage G slice
 * 5b · §27 role surfaces · P-07 · P-04 · P-08).** No named viewer → nothing and the reason. No register → nothing and
 * the reason. A malformed register row grants nothing. And the box only ever offers the screens it serves.
 */

const CATALOGUE: readonly NavItem[] = [
  { id: 'today', label: 'Today', labelTa: 'இன்று', path: '/manager/', requires: 'erp.dashboard.view', group: 'Today' },
  { id: 'counts', label: 'Stock counts', labelTa: 'சரக்கு எண்ணிக்கை', path: '/counts/', requires: 'count.view', group: 'Inventory' },
  { id: 'people', label: 'Users & roles', labelTa: 'பயனர்களும் பங்குகளும்', path: '/admin/?tab=people', requires: 'admin.users.manage', group: 'Administration' },
  { id: 'payroll', label: 'Payroll', labelTa: 'ஊதியப் பட்டியல்', path: '/payroll', requires: 'erp.dashboard.view', group: 'People', served: 'unserved' },
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
const packWith = (over: Partial<Pick<StorePack, 'roles' | 'roleAssignments' | 'policies' | 'people'>> = {}): StorePack => {
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
    expect(out).toEqual({ userId: null, branchId: 'b1', person: null, branch: { name: 'Main' }, why: 'no_user', groups: [] });
  });

  it('no role register on this box → no sections, reason no_roles', () => {
    const out = navigationPayload({ screen: 'counts', pack: packWith({ policies: POLICIES }), payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(out).toEqual({ userId: 'u-mgr', branchId: 'b1', person: null, branch: { name: 'Main' }, why: 'no_roles', groups: [] });
  });

  it('a named user with no grants → an empty list, and no reason (there is nothing wrong, they may open nothing)', () => {
    const out = navigationPayload({ screen: 'counts', pack: FULL, payload: { userId: 'u-stranger' }, screenOf, catalogue: CATALOGUE });
    expect(out).toEqual({ userId: 'u-stranger', branchId: 'b1', person: null, branch: { name: 'Main' }, why: null, groups: [] });
  });
});

describe('the menu offers exactly what the person may open on this box', () => {
  it('the manager sees Today and Stock counts, in both languages, with the served screen marked current', () => {
    const out = navigationPayload({ screen: 'counts', pack: FULL, payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(out.why).toBeNull();
    expect(out.groups).toEqual([
      { group: { en: 'Today', ta: 'இன்று' }, items: [{ id: 'today', label: { en: 'Today', ta: 'இன்று' }, path: '/manager/', current: false }] },
      { group: { en: 'Inventory & backstore', ta: 'சரக்கும் பின்கடையும்' }, items: [{ id: 'counts', label: { en: 'Stock counts', ta: 'சரக்கு எண்ணிக்கை' }, path: '/counts/', current: true }] },
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

describe('the rail names the person and the branch, and the screen can run as the person who signed in (OB-16, 5 Oct 2026)', () => {
  const PEOPLE = known([{ userId: 'u-mgr', displayName: '  Meena Raghavan ', roleId: 'manager' }, { userId: 'u-admin', displayName: 'Arun' }]);

  it('peopleFrom keeps only whole rows: an id and a name; the role is optional', () => {
    expect(peopleFrom([{ userId: 'u', displayName: 'A', roleId: 'r' }, { userId: 'u2', displayName: 'B' }, { userId: 'u3', displayName: '  ' }, { displayName: 'C' }, 'x', null, { userId: 'u4', displayName: 'D', roleId: 7 }]))
      .toEqual([{ userId: 'u', displayName: 'A', roleId: 'r' }, { userId: 'u2', displayName: 'B', roleId: null }, { userId: 'u4', displayName: 'D', roleId: null }]);
  });

  it('personOf: the name from the people section, the role\'s NAME from the role catalogue (the row\'s role, else the assignment\'s); unknown → null, never an invented name', () => {
    const pack = packWith({ roles: known(ROLES), roleAssignments: known(ASSIGNMENTS), policies: POLICIES, people: PEOPLE });
    expect(personOf('u-mgr', pack)).toEqual({ name: 'Meena Raghavan', role: 'Store manager' });
    expect(personOf('u-admin', pack)).toEqual({ name: 'Arun', role: 'Administrator' }); // no roleId on the row → the assignment's role
    expect(personOf('u-stranger', pack)).toBeNull();
    expect(personOf(null, pack)).toBeNull();
    expect(personOf('u-mgr', packWith({ roles: known(ROLES), roleAssignments: known(ASSIGNMENTS), policies: POLICIES }))).toBeNull(); // no people section
    expect(personOf('u-mgr', packWith({ people: PEOPLE }))).toEqual({ name: 'Meena Raghavan', role: null }); // people but no role catalogue
  });

  it('branchOf: the branch\'s name from the policies, or null', () => {
    expect(branchOf(packWith({ policies: POLICIES }))).toEqual({ name: 'Main' });
    expect(branchOf(packWith())).toBeNull();
    expect(branchOf(packWith({ policies: known({ ...(POLICIES as { value: object }).value, branchName: '  ' }) as StorePack['policies'] }))).toBeNull();
  });

  it('the payload carries them: person and branch on every return path', () => {
    const pack = packWith({ roles: known(ROLES), roleAssignments: known(ASSIGNMENTS), policies: POLICIES, people: PEOPLE });
    const full = navigationPayload({ screen: 'counts', pack, payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(full.person).toEqual({ name: 'Meena Raghavan', role: 'Store manager' });
    expect(full.branch).toEqual({ name: 'Main' });
    const noRoles = navigationPayload({ screen: 'counts', pack: packWith({ policies: POLICIES, people: PEOPLE }), payload: { userId: 'u-mgr' }, screenOf, catalogue: CATALOGUE });
    expect(noRoles).toEqual({ userId: 'u-mgr', branchId: 'b1', person: { name: 'Meena Raghavan', role: null }, branch: { name: 'Main' }, why: 'no_roles', groups: [] });
  });

  it('permissionsOf: the union of the roles held on this branch (or everywhere); null without a register; nothing for a stranger', () => {
    expect(permissionsOf('u-mgr', FULL)).toEqual(['count.view', 'erp.dashboard.view']);
    expect(permissionsOf('u-admin', FULL)).toEqual(['admin.users.manage']); // scope 'all'
    expect(permissionsOf('u-stranger', FULL)).toEqual([]);
    expect(permissionsOf('u-mgr', packWith({ roles: known(ROLES) }))).toBeNull();
    // the manager's scope is b1 only: on b2 they hold nothing
    const b2 = packWith({ roles: known(ROLES), roleAssignments: known(ASSIGNMENTS), policies: known({ ...(POLICIES as { value: object }).value, branchId: 'b2' }) as StorePack['policies'] });
    expect(permissionsOf('u-mgr', b2)).toEqual([]);
    expect(permissionsOf('u-admin', b2)).toEqual(['admin.users.manage']);
  });

  it('asSignedInPerson re-addresses the payload to the signed-in person: id and permissions at the top and in a child that carries both; a child naming a person WITHOUT permissions is left alone; null stays null', () => {
    const payload = {
      userId: 'u-mgr', permissions: ['count.view', 'erp.dashboard.view'], approvals: [{ id: 'a1' }],
      indents: { userId: 'u-mgr', permissions: ['count.view'], open: 3 },
      supervisor: { userId: 'u-sup', authorityLimit: { minor: 500, currency: 'INR' } },
    };
    expect(asSignedInPerson(payload, 'u-admin', FULL)).toEqual({
      userId: 'u-admin', permissions: ['admin.users.manage'], approvals: [{ id: 'a1' }],
      indents: { userId: 'u-admin', permissions: ['admin.users.manage'], open: 3 },
      supervisor: { userId: 'u-sup', authorityLimit: { minor: 500, currency: 'INR' } },
    });
    expect(asSignedInPerson({ userId: 'u-mgr', asAt: 'x' }, 'u-admin', FULL)).toEqual({ userId: 'u-admin', asAt: 'x' }); // no permissions key → none invented
    expect(asSignedInPerson({ userId: 'u-mgr', permissions: ['count.view'] }, 'u-admin', packWith())).toEqual({ userId: 'u-admin', permissions: [] }); // no register → nothing
    expect(asSignedInPerson(null, 'u-admin', FULL)).toBeNull();
    expect(payload.userId).toBe('u-mgr'); // the input was not mutated
  });
});
