import { describe, it, expect } from 'vitest';
import {
  bindCustomerPrincipal,
  evaluateStepUp,
  inviteToOrg,
  acceptInvite,
  type IdentityClaims,
  type OrgMembership,
  type StepUpPolicy,
} from '../../packages/identity/src/index';

/**
 * Binding a verified identity to a customer principal, and step-up for sensitive actions (Item 1
 * slice 1d). The principal is resolved strictly within the request's tenant (OB-01), carrying the
 * org memberships the subject actually holds; a sensitive action then needs BOTH a second factor
 * and a fresh login.
 */

const NOW_MS = Date.parse('2026-09-25T10:00:00.000Z');

const claims = (over: Partial<IdentityClaims> = {}): IdentityClaims => ({
  subject: 'cust-99',
  tenantId: 't-sre',
  ...over,
});

/** Build a real active membership by accepting a real invite (so the shape is never hand-faked). */
const memberOf = (orgId: string, subject: string, role: Parameters<typeof inviteToOrg>[0]['role'] = 'org_member'): OrgMembership => {
  const { invite } = inviteToOrg({
    inviteId: `inv-${orgId}-${subject}`,
    tenantId: 't-sre',
    orgId,
    invitedContact: `${subject}@x.test`,
    role,
    token: `tok-${orgId}-${subject}`,
    createdBy: 'owner-1',
    now: '2026-09-01T00:00:00.000Z',
  });
  return acceptInvite({
    invite,
    presentedToken: `tok-${orgId}-${subject}`,
    subject,
    tenantId: 't-sre',
    membershipId: `mem-${orgId}-${subject}`,
    now: '2026-09-02T00:00:00.000Z',
  }).membership!;
};

describe('bindCustomerPrincipal (M02 / M20 / M22, OB-01)', () => {
  it('binds the subject to the tenant with the orgs they are an active member of', () => {
    const memberships = [
      memberOf('org-acme', 'cust-99', 'org_admin'),
      memberOf('org-beta', 'cust-99', 'org_viewer'),
      memberOf('org-acme', 'someone-else'), // another person — must not appear
    ];
    const result = bindCustomerPrincipal({
      claims: claims({ email: 'c@acme.test', amr: ['otp'], authTime: Math.floor(NOW_MS / 1000) }),
      requestTenantId: 't-sre',
      memberships,
    });
    expect(result.outcome).toBe('bound');
    expect(result.principal?.subject).toBe('cust-99');
    expect(result.principal?.email).toBe('c@acme.test');
    expect(result.principal?.authTimeMs).toBe(Math.floor(NOW_MS / 1000) * 1000);
    expect([...(result.principal?.orgs ?? [])].sort((a, b) => a.orgId.localeCompare(b.orgId))).toEqual([
      { orgId: 'org-acme', role: 'org_admin' },
      { orgId: 'org-beta', role: 'org_viewer' },
    ]);
  });

  it('refuses to bind a token whose tenant is not the tenant being acted in (OB-01)', () => {
    const result = bindCustomerPrincipal({
      claims: claims({ tenantId: 't-sre' }),
      requestTenantId: 't-rival',
      memberships: [memberOf('org-acme', 'cust-99')],
    });
    expect(result.outcome).toBe('tenant_mismatch');
    expect(result.principal).toBeUndefined();
  });

  it('binds a customer with no org memberships (a personal retail account)', () => {
    const result = bindCustomerPrincipal({ claims: claims(), requestTenantId: 't-sre', memberships: [] });
    expect(result.outcome).toBe('bound');
    expect(result.principal?.orgs).toEqual([]);
    expect(result.principal?.amr).toEqual([]);
  });
});

describe('evaluateStepUp (MFA / re-auth for sensitive actions)', () => {
  const policy: StepUpPolicy = {
    secondFactorActions: ['change_bank_details', 'bulk_export', 'delete_account'],
    secondFactorAmr: ['otp', 'mfa'],
    maxAuthAgeSeconds: 300,
  };

  it('allows an ordinary action on a single factor', () => {
    const d = evaluateStepUp({ action: 'view_orders', amr: ['pwd'], authTimeMs: NOW_MS - 10_000, nowMs: NOW_MS, policy });
    expect(d.outcome).toBe('allowed');
  });

  it('requires a second factor for a sensitive action done on a single factor', () => {
    const d = evaluateStepUp({ action: 'change_bank_details', amr: ['pwd'], authTimeMs: NOW_MS - 10_000, nowMs: NOW_MS, policy });
    expect(d.outcome).toBe('needs_second_factor');
  });

  it('allows a sensitive action with a second factor and a fresh login', () => {
    const d = evaluateStepUp({ action: 'change_bank_details', amr: ['pwd', 'otp'], authTimeMs: NOW_MS - 60_000, nowMs: NOW_MS, policy });
    expect(d.outcome).toBe('allowed');
  });

  it('requires re-auth for a sensitive action when the login is stale, even with a second factor', () => {
    const d = evaluateStepUp({ action: 'bulk_export', amr: ['mfa'], authTimeMs: NOW_MS - 600_000, nowMs: NOW_MS, policy });
    expect(d.outcome).toBe('needs_reauth');
  });

  it('requires re-auth when the authentication time is unknown', () => {
    const d = evaluateStepUp({ action: 'delete_account', amr: ['otp'], nowMs: NOW_MS, policy });
    expect(d.outcome).toBe('needs_reauth');
  });

  it('reports the missing second factor before staleness (the harder requirement first)', () => {
    // Single factor AND stale — the caller is told to get a second factor (which also refreshes).
    const d = evaluateStepUp({ action: 'delete_account', amr: ['pwd'], authTimeMs: NOW_MS - 999_000, nowMs: NOW_MS, policy });
    expect(d.outcome).toBe('needs_second_factor');
  });
});
