// OB-841 B and OB-842 A (owner, 18 Nov 2026, in writing): which approvals the remote door refuses to decide.
import { describe, expect, it } from 'vitest';
import { REMOTE_DECIDE_REFUSED_KINDS } from '../../edge/store-edge/src/remote-door';
import { APPROVAL_KINDS } from '../../services/identity/src/approval-requests';

describe('OB-841 B / OB-842 A — what is decided only in the shop', () => {
  it('5A: access, roles and devices stay in the shop', () => {
    for (const k of ['access_change', 'role_permission_change', 'emergency_access', 'store_computer_replaced']) expect(REMOTE_DECIDE_REFUSED_KINDS).toContain(k);
  });
  it('OB-841 B: closing the shop or a branch, approval rules, high-impact settings and switches, a supplier\'s bank account', () => {
    for (const k of ['tenant_closure', 'branch_transition', 'approval_rule_change', 'config_change', 'flag_change', 'supplier_bank_change']) expect(REMOTE_DECIDE_REFUSED_KINDS).toContain(k);
  });
  it('OB-842 A: price and catalogue approvals may be decided from outside, as may payments and write-offs', () => {
    for (const k of ['price_change', 'price_list_entry', 'catalogue_change', 'supplier_payment', 'stock_write_off']) expect(REMOTE_DECIDE_REFUSED_KINDS).not.toContain(k);
  });
  it('every kind kept in the shop is a real approval kind (no typo leaves one decidable from outside)', () => {
    const known = new Set([...Object.keys(APPROVAL_KINDS), 'security_reviewer']);
    for (const k of REMOTE_DECIDE_REFUSED_KINDS) expect(known.has(k), k).toBe(true);
  });
});
