import { describe, it, expect } from 'vitest';
import { grantDeciderRefusal, ROLE_GRANT_DECISION_ROUTE_PERMISSION } from '../../services/identity/src/index';
import { OWNER_ASKED_GRANT_RULE, ROLE_ADJUSTMENT_POLICY, ROLE_CATALOGUE } from '../../services/api/src/roles';
import { PRIVILEGE_AUTHORITY } from '../../edge/store-edge/src/office-privilege';

/**
 * **OB-804 A (owner, 16 Nov 2026, in writing) · D-052 · §28: who may decide a role grant request.** The owner's authority
 * (`identity.role.grant`) decides any request but their own (the grant engine refuses the requester); a store manager decides
 * ONLY a role the owner asked for — never another person's ask, never the owner's own role, the IT administrator's, the
 * chartered accountant's or any role ADR-0034 locks.
 */

const perms = (roleId: string): readonly string[] => ROLE_CATALOGUE.find((r) => r.id === roleId)!.permissions;
const judge = (decider: string, asker: string, roleId: string) => grantDeciderRefusal({
  deciderPermissions: perms(decider), deciderRoles: [decider], askerRoles: [asker], roleId, requestedBy: `u-${asker}`, rule: OWNER_ASKED_GRANT_RULE,
});

describe('OB-804 A: a store manager approves a role the owner asked for, and nothing else', () => {
  it('the owner decides any ask; a store manager decides the owner\'s ask of an ordinary role', () => {
    expect(judge('owner', 'store_manager', 'receiver_qc')).toBeUndefined();
    expect(judge('store_manager', 'owner', 'receiver_qc')).toBeUndefined();
    expect(judge('store_manager', 'owner', 'cashier')).toBeUndefined();
  });

  it('a store manager never decides another person\'s ask', () => {
    expect(judge('store_manager', 'store_manager', 'receiver_qc')?.code).toBe('only_the_owners_ask_is_yours');
    expect(judge('store_manager', 'accountant', 'cashier')?.code).toBe('only_the_owners_ask_is_yours');
  });

  it('a store manager never approves the owner\'s role, the IT administrator\'s, the CA\'s or a locked role — even when the owner asks', () => {
    for (const roleId of ['owner', 'platform_admin', 'chartered_accountant', ...Object.keys(ROLE_ADJUSTMENT_POLICY.lockedRoles)]) {
      expect(judge('store_manager', 'owner', roleId)?.code, roleId).toBe('role_not_approved_by_a_store_manager');
    }
  });

  it('nobody else decides a role: not a cashier, not an accountant, and nothing without the rule wired', () => {
    expect(judge('cashier', 'owner', 'receiver_qc')?.code).toBe('not_yours_to_decide');
    expect(judge('accountant', 'owner', 'receiver_qc')?.code).toBe('not_yours_to_decide');
    expect(grantDeciderRefusal({ deciderPermissions: perms('store_manager'), deciderRoles: ['store_manager'], askerRoles: ['owner'], roleId: 'receiver_qc', requestedBy: 'u-owner', rule: undefined })?.code).toBe('not_yours_to_decide');
  });

  it('the owner and the store manager both act under the decision routes\' word; the store PC asks the same of the PIN', () => {
    expect(ROLE_GRANT_DECISION_ROUTE_PERMISSION).toBe('identity.role.request');
    expect(perms('owner')).toContain(ROLE_GRANT_DECISION_ROUTE_PERMISSION);
    expect(perms('store_manager')).toContain(ROLE_GRANT_DECISION_ROUTE_PERMISSION);
    expect(PRIVILEGE_AUTHORITY.role_grant_approval).toBe(ROLE_GRANT_DECISION_ROUTE_PERMISSION);
    expect(PRIVILEGE_AUTHORITY.role_grant_rejection).toBe(ROLE_GRANT_DECISION_ROUTE_PERMISSION);
    // The store manager still does not hold the owner's authority itself (OB-741: the owner's reserved powers are unchanged).
    expect(perms('store_manager')).not.toContain('identity.role.grant');
  });
});
