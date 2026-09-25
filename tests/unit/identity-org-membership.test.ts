import { describe, it, expect } from 'vitest';
import {
  inviteToOrg,
  acceptInvite,
  revokeInvite,
  removeMember,
  activeMemberships,
  roleOf,
  inviteStateAt,
  type OrgInvite,
} from '../../packages/identity/src/index';

/**
 * Organization invitation & membership (M02 / M22 / M20, Item 1 slice 1c). A B2B customer's people
 * each get their own login by INVITATION — no shared logins (hard rule #4). The invite token is a
 * capability (stored only as a hash), single-use, time-boxed, revocable, and acceptance binds the
 * SUBJECT from trusted claims to the org, tenant- and org-scoped (OB-01).
 */

const NOW = '2026-09-25T10:00:00.000Z';
const later = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const invite = (over: Partial<Parameters<typeof inviteToOrg>[0]> = {}) =>
  inviteToOrg({
    inviteId: 'inv-1',
    tenantId: 't-sre',
    orgId: 'org-acme',
    invitedContact: 'buyer@acme.test',
    role: 'org_member',
    token: 'invite-token-abc',
    createdBy: 'owner-1',
    now: NOW,
    ...over,
  });

const accept = (record: OrgInvite, over: Partial<Parameters<typeof acceptInvite>[0]> = {}) =>
  acceptInvite({
    invite: record,
    presentedToken: 'invite-token-abc',
    subject: 'cust-99',
    tenantId: 't-sre',
    membershipId: 'mem-1',
    now: later(3600),
    ...over,
  });

describe('org invitation & membership (M02 / M22 / M20)', () => {
  it('an invite stores only a hash of the token, never the token itself (hard rule #4)', () => {
    const { invite: rec, token } = invite();
    expect(token).toBe('invite-token-abc');
    expect(JSON.stringify(rec)).not.toContain('invite-token-abc');
    expect(rec.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.state).toBe('pending');
  });

  it('accepting with the right token binds the subject to the org and consumes the invite', () => {
    const { invite: rec } = invite();
    const result = accept(rec);
    expect(result.outcome).toBe('accepted');
    expect(result.invite.state).toBe('accepted');
    expect(result.invite.acceptedBy).toBe('cust-99');
    expect(result.membership).toMatchObject({
      tenantId: 't-sre',
      orgId: 'org-acme',
      subject: 'cust-99',
      role: 'org_member',
      state: 'active',
      viaInvite: 'inv-1',
    });
  });

  it('a wrong token is refused and creates no membership', () => {
    const { invite: rec } = invite();
    const result = accept(rec, { presentedToken: 'not-the-token' });
    expect(result.outcome).toBe('wrong_token');
    expect(result.accepted).toBe(false);
    expect(result.membership).toBeUndefined();
  });

  it('an invite cannot be accepted twice (single-use)', () => {
    const { invite: rec } = invite();
    const first = accept(rec);
    const second = accept(first.invite, { subject: 'cust-other', membershipId: 'mem-2' });
    expect(second.outcome).toBe('already_accepted');
    expect(second.membership).toBeUndefined();
  });

  it('an expired invite is refused, even with the right token', () => {
    const { invite: rec } = invite({ ttlSeconds: 60 });
    const result = accept(rec, { now: later(61) });
    expect(result.outcome).toBe('expired');
    expect(inviteStateAt(rec, later(61))).toBe('expired');
  });

  it('a revoked invite cannot be accepted', () => {
    const { invite: rec } = invite();
    const revoked = revokeInvite({ invite: rec, revokedBy: 'owner-1', now: later(10) });
    expect(revoked.state).toBe('revoked');
    const result = accept(revoked);
    expect(result.outcome).toBe('revoked');
  });

  it('an invite from one tenant cannot be accepted into another (OB-01)', () => {
    const { invite: rec } = invite();
    const result = accept(rec, { tenantId: 't-rival' });
    expect(result.outcome).toBe('tenant_mismatch');
    expect(result.membership).toBeUndefined();
  });

  it('revoking a non-pending invite is a no-op (never resurrects an accepted one)', () => {
    const { invite: rec } = invite();
    const accepted = accept(rec).invite;
    const revoked = revokeInvite({ invite: accepted, revokedBy: 'owner-1', now: later(20) });
    expect(revoked.state).toBe('accepted'); // unchanged
  });

  it('roleOf returns the role for an active member, and nothing across tenant/org/removal', () => {
    const { invite: rec } = invite({ role: 'org_admin' });
    const membership = accept(rec).membership!;
    const memberships = [membership];
    expect(roleOf(memberships, 't-sre', 'org-acme', 'cust-99')).toBe('org_admin');
    expect(roleOf(memberships, 't-rival', 'org-acme', 'cust-99')).toBeUndefined(); // cross-tenant
    expect(roleOf(memberships, 't-sre', 'org-other', 'cust-99')).toBeUndefined(); // cross-org
    expect(roleOf(memberships, 't-sre', 'org-acme', 'someone-else')).toBeUndefined();

    const removed = removeMember({ membership, removedBy: 'owner-1', now: later(7200) });
    expect(removed.state).toBe('removed');
    expect(roleOf([removed], 't-sre', 'org-acme', 'cust-99')).toBeUndefined();
  });

  it('activeMemberships lists only active members of the given org within the tenant', () => {
    const a = accept(invite({ inviteId: 'i-a' }).invite, { subject: 's-a', membershipId: 'm-a' }).membership!;
    const b = accept(invite({ inviteId: 'i-b', orgId: 'org-acme' }).invite, { subject: 's-b', membershipId: 'm-b' }).membership!;
    const other = accept(invite({ inviteId: 'i-c', orgId: 'org-other' }).invite, { subject: 's-c', membershipId: 'm-c' }).membership!;
    const removed = removeMember({
      membership: accept(invite({ inviteId: 'i-d' }).invite, { subject: 's-d', membershipId: 'm-d' }).membership!,
      removedBy: 'owner-1',
      now: later(9000),
    });
    const list = activeMemberships([a, b, other, removed], 't-sre', 'org-acme');
    expect(list.map((m) => m.subject).sort()).toEqual(['s-a', 's-b']);
  });
});
