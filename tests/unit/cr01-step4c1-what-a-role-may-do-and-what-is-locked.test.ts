import { describe, it, expect } from 'vitest';
import {
  applyRoleAdjustments, ownerReservedPermissions, roleAdjustmentRefusal, roleDifferences,
  ROLE_ADJUST_PERMISSION, type RolePermissionAdjustment, type AdjustmentChange,
} from '../../services/identity/src/role-adjustments';
import { APPROVAL_KINDS } from '../../services/identity/src/approval-requests';
import { MACHINE_ROLE_IDS } from '../../services/identity/src/separation-of-duties';
import { MACHINE_ONLY_ROLES } from '../../services/identity/src/machine-identities';
import { OUTSIDE_PARTY_ROLES } from '../../services/identity/src/outside-party-logins';
import {
  ROLE_CATALOGUE, ROLE_ADJUSTMENT_POLICY, OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID, FLOOR_DEVICE_GATEWAY_ROLE_ID,
  INTERNAL_COMMITTEE_ROLE_ID, SECURITY_REVIEWER_ROLE_ID, PLATFORM_ADMIN_ROLE_ID,
} from '../../services/api/src/roles';

/**
 * **CR-01 step 4c-1 · ADR-0034 · OB-730 "A" · OB-740 "B" · OB-741 "A": what a role may do is changed as recorded
 * adjustments to the built-in roles, and head office refuses the never-from-a-screen list.** The rules alone, against the
 * product's real 24 roles and 469 permissions.
 */

const judge = (roleId: string, permission: string, change: AdjustmentChange, current = ROLE_CATALOGUE) =>
  roleAdjustmentRefusal({ builtIn: ROLE_CATALOGUE, current, policy: ROLE_ADJUSTMENT_POLICY, roleId, permission, change });
const holders = (p: string) => ROLE_CATALOGUE.filter((r) => r.permissions.includes(p)).map((r) => r.id);
const perms = (roleId: string, roles = ROLE_CATALOGUE) => roles.find((r) => r.id === roleId)!.permissions;
const adj = (roleId: string, permission: string, change: AdjustmentChange, n = 1): RolePermissionAdjustment => ({
  requestId: `r${n}`, roleId, permission, change, reason: 'synthetic', requestedBy: 'u-mgr', approvedBy: 'u-owner', approvalId: `a${n}`, at: `2026-11-15T0${n}:00:00Z`,
});

describe('CR-01 step 4c-1: the adjusted roles are the built-in roles with the recorded changes applied in order', () => {
  it('adds, removes and undoes — the built-in list itself is never changed (hard rule 2)', () => {
    expect(perms('cashier')).not.toContain('pos.return.approve');
    const once = applyRoleAdjustments(ROLE_CATALOGUE, [adj('cashier', 'pos.return.approve', 'add')]);
    expect(perms('cashier', once)).toContain('pos.return.approve');
    expect(roleDifferences(ROLE_CATALOGUE, once)['cashier']).toEqual({ added: ['pos.return.approve'], removed: [] });
    // Undo is the opposite change, recorded after it: the role is exactly the built-in role again.
    const undone = applyRoleAdjustments(ROLE_CATALOGUE, [adj('cashier', 'pos.return.approve', 'add'), adj('cashier', 'pos.return.approve', 'remove', 2)]);
    expect([...perms('cashier', undone)].sort()).toEqual([...perms('cashier')].sort());
    expect(roleDifferences(ROLE_CATALOGUE, undone)['cashier']).toEqual({ added: [], removed: [] });
    // The built-in list is untouched, and no change at all hands the built-in list back as it is.
    expect(perms('cashier')).not.toContain('pos.return.approve');
    expect(applyRoleAdjustments(ROLE_CATALOGUE, [])).toBe(ROLE_CATALOGUE);
    // A recorded change naming a role that is not built in invents nothing.
    expect(applyRoleAdjustments(ROLE_CATALOGUE, [adj('made_up', 'pos.return.approve', 'add')]).map((r) => r.id)).toEqual(ROLE_CATALOGUE.map((r) => r.id));
  });

  it('a permission taken off a role is gone from it', () => {
    const p = perms('cashier')[0]!;
    const after = applyRoleAdjustments(ROLE_CATALOGUE, [adj('cashier', p, 'remove')]);
    expect(perms('cashier', after)).not.toContain(p);
    expect(roleDifferences(ROLE_CATALOGUE, after)['cashier']!.removed).toEqual([p]);
  });
});

describe('CR-01 step 4c-1: what can be changed from a screen, and what never can (ADR-0034 decision 4)', () => {
  it('allows an ordinary change: a cashier may be given what a store manager holds, and lose it again', () => {
    expect(judge('cashier', 'pos.return.approve', 'add')).toBeUndefined();
    const given = applyRoleAdjustments(ROLE_CATALOGUE, [adj('cashier', 'pos.return.approve', 'add')]);
    expect(judge('cashier', 'pos.return.approve', 'remove', given)).toBeUndefined();
    expect(judge('cashier', perms('cashier')[0]!, 'remove')).toBeUndefined();
  });

  it('refuses what is not a role, not the product\'s permission, or no change at all', () => {
    expect(judge('made_up', 'pos.return.approve', 'add')).toMatchObject({ status: 404, code: 'not_a_role' });
    expect(judge('cashier', 'pos.teleport', 'add')).toMatchObject({ status: 422, code: 'not_a_permission_of_the_product' });
    expect(judge('cashier', perms('cashier')[0]!, 'add')).toMatchObject({ status: 409, code: 'role_already_holds_it' });
    expect(judge('cashier', 'pos.return.approve', 'remove')).toMatchObject({ status: 409, code: 'role_does_not_hold_it' });
  });

  it('a. never a machine\'s role, nor a machine\'s relay permission into a person\'s role', () => {
    for (const id of new Set([...MACHINE_ROLE_IDS, ...MACHINE_ONLY_ROLES, FLOOR_DEVICE_GATEWAY_ROLE_ID])) {
      const p = perms(id)[0]!;
      expect(judge(id, p, 'remove'), id).toMatchObject({ code: 'not_changeable_from_a_screen', reason: 'machine_role' });
    }
    // The store computer's relay hops that only it (and the owner) hold.
    const relayOnly = perms('store_computer').filter((p) => holders(p).every((h) => h === 'store_computer' || h === OWNER_ROLE_ID));
    expect(relayOnly.length).toBeGreaterThan(10);
    for (const p of relayOnly) expect(judge(STORE_MANAGER_ROLE_ID, p, 'add'), p).toMatchObject({ reason: expect.stringMatching(/machine_role|controls_roles_approvals_or_ai/) });
    expect(judge('cashier', 'identity.grants.sync', 'add')).toMatchObject({ reason: 'machine_role' });
  });

  it('b. never an outside party\'s role (customer, supplier, business customer, concessionaire)', () => {
    for (const id of OUTSIDE_PARTY_ROLES) expect(judge(id, perms(id)[0]!, 'remove'), id).toMatchObject({ reason: 'outside_party_role' });
  });

  it('c. never the POSH Internal Committee — its role, nor its permissions into anybody else\'s role', () => {
    expect(judge(INTERNAL_COMMITTEE_ROLE_ID, 'posh.complaint.read', 'remove')).toMatchObject({ reason: 'posh_committee' });
    expect(judge(STORE_MANAGER_ROLE_ID, 'posh.complaint.read', 'add')).toMatchObject({ reason: 'posh_committee' });
    expect(judge(OWNER_ROLE_ID, 'posh.complaint.read', 'add')).toMatchObject({ reason: 'posh_committee' });
  });

  it('d. never the security reviewer ("nothing else", OB-406)', () => {
    expect(judge(SECURITY_REVIEWER_ROLE_ID, 'pos.return.approve', 'add')).toMatchObject({ reason: 'security_reviewer' });
  });

  it('e. IT and business kept apart — no IT-only permission into a business role, no business permission into IT', () => {
    const itOnly = [...new Set(ROLE_CATALOGUE.flatMap((r) => r.permissions))]
      .filter((p) => holders(p).filter((h) => h !== OWNER_ROLE_ID).length > 0 && holders(p).filter((h) => h !== OWNER_ROLE_ID).every((h) => h === PLATFORM_ADMIN_ROLE_ID));
    expect(itOnly.length).toBeGreaterThan(0);
    for (const p of itOnly) expect(judge('accountant', p, 'add'), p).toMatchObject({ reason: 'it_and_business_kept_apart' });
    expect(judge(PLATFORM_ADMIN_ROLE_ID, 'pos.return.approve', 'add')).toMatchObject({ reason: 'it_and_business_kept_apart' });
  });

  it('f. never who controls roles, approvals or AI — even for the owner\'s own role (hard rule 5)', () => {
    for (const p of ['identity.role.grant', 'identity.role.request', ROLE_ADJUST_PERMISSION, 'identity.ca.grant.request', 'approvals.rules.approve', 'ai.agent.enable', 'ai.killswitch.set', 'ai.budget.set', 'ai.model.approve']) {
      expect(judge(STORE_MANAGER_ROLE_ID, p, holders(p).includes(STORE_MANAGER_ROLE_ID) ? 'remove' : 'add'), p).toMatchObject({ reason: 'controls_roles_approvals_or_ai' });
    }
  });

  it('g. OB-741 "A": the owner\'s reserved powers never go to another role, and the owner\'s own role is never reduced', () => {
    const reserved = ownerReservedPermissions(ROLE_CATALOGUE, OWNER_ROLE_ID);
    expect(reserved.size).toBe(105);
    expect(reserved.has('price.change.approve')).toBe(true);
    expect(reserved.has(ROLE_ADJUST_PERMISSION)).toBe(false); // the store manager holds it too (OB-740 "B")
    for (const p of reserved) {
      const r = judge(STORE_MANAGER_ROLE_ID, p, 'add');
      expect(r, p).toBeDefined();
      expect(r!.code, p).toBe('not_changeable_from_a_screen');
    }
    expect(judge(STORE_MANAGER_ROLE_ID, 'price.change.approve', 'add')).toMatchObject({ reason: 'owner_reserved' });
    for (const p of perms(OWNER_ROLE_ID)) expect(judge(OWNER_ROLE_ID, p, 'remove'), p).toMatchObject({ reason: 'owner_role_never_reduced' });
    // Worked out from the BUILT-IN roles: a change the shop made never shrinks or grows the reserved list.
    const changed = applyRoleAdjustments(ROLE_CATALOGUE, [adj('cashier', 'pos.return.approve', 'add')]);
    expect(judge(STORE_MANAGER_ROLE_ID, 'price.change.approve', 'add', changed)).toMatchObject({ reason: 'owner_reserved' });
  });

  it('every locked role is a real role, and every machine and outside party in the product is locked', () => {
    const ids = new Set(ROLE_CATALOGUE.map((r) => r.id));
    for (const id of Object.keys(ROLE_ADJUSTMENT_POLICY.lockedRoles)) expect(ids.has(id), id).toBe(true);
    for (const id of [...MACHINE_ROLE_IDS, ...MACHINE_ONLY_ROLES, ...OUTSIDE_PARTY_ROLES, INTERNAL_COMMITTEE_ROLE_ID, SECURITY_REVIEWER_ROLE_ID]) {
      expect(ROLE_ADJUSTMENT_POLICY.lockedRoles[id], id).toBeDefined();
    }
    // Every role a person can change is a staff role, never the owner's reduced, and holds no locked area.
    const open = ROLE_CATALOGUE.filter((r) => ROLE_ADJUSTMENT_POLICY.lockedRoles[r.id] === undefined).map((r) => r.id).sort();
    expect(open).toEqual(['accountant', 'cashier', 'chartered_accountant', 'delivery_driver', 'owner', 'picker', 'platform_admin', 'purchase_approver', 'purchase_user', 'receiver_qc', 'store_manager', 'warehouse_user']);
  });
});

describe('CR-01 step 4c-1: the two people (OB-740 "B")', () => {
  it('a store manager asks and the owner approves; when the owner asks, a store manager approves', () => {
    expect(APPROVAL_KINDS['role_permission_change']).toMatchObject({
      makerPermission: ROLE_ADJUST_PERMISSION, checkerPermission: 'identity.role.grant',
      whenTheOwnerAsks: { checkerPermission: ROLE_ADJUST_PERMISSION, checkerRole: STORE_MANAGER_ROLE_ID },
    });
    expect(holders(ROLE_ADJUST_PERMISSION).sort()).toEqual([OWNER_ROLE_ID, STORE_MANAGER_ROLE_ID]);
    expect(holders('identity.role.grant')).toEqual([OWNER_ROLE_ID]);
  });
});
