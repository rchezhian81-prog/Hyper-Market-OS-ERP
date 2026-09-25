// Organization invitation & membership for external customers (M02 / M22 / M20).
//
// A B2B customer is not one person — it is a business with several people who each need their own
// login into the same account (their buyer, their accountant, their store manager). No shared
// login (hard rule #4, A-17), so each person joins by INVITATION: an authorised member invites a
// contact, that person proves the invitation with a one-time token, and on acceptance they are
// bound — as themselves, from their signed identity claims — to the org with a role.
//
// The rules this engine will not break:
//   • the invite TOKEN is a capability, so only its hash is stored (never the token itself — the
//     same rule as a password-reset link, hard rule #4). The plaintext is returned once, to be
//     delivered, and never again;
//   • an invitation is single-use, time-boxed and revocable: pending → accepted / expired / revoked,
//     and a spent, expired or revoked invite cannot be accepted;
//   • membership is TENANT- and ORG-scoped: an invite issued by one tenant cannot be accepted into
//     another (OB-01), and acceptance binds the SUBJECT from trusted claims, never a caller-supplied
//     name.
//
// Delivery of the invite (email/SMS) is a provider-neutral concern handled by the same kind of
// gated sender the OTP flow uses; this engine produces the token and the record, not the email.
//
// Pure and deterministic: the clock and the token are injected; only hashing touches `node:crypto`.

import { createHash } from 'node:crypto';

/** A role a person holds WITHIN a customer org — distinct from staff RBAC roles. */
export type OrgRole = 'org_admin' | 'org_member' | 'org_viewer';

export type InviteState = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface OrgInvite {
  readonly inviteId: string;
  readonly tenantId: string;
  readonly orgId: string;
  /** The email or phone the invite was addressed to (for display + an optional match on accept). */
  readonly invitedContact: string;
  readonly role: OrgRole;
  /** `sha256(inviteId:token)` — the token itself is never stored (it is a capability, hard rule #4). */
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly state: InviteState;
  readonly createdBy: string;
  readonly createdAt: string;
  /** Set when accepted — names the subject who accepted, so the binding is auditable. */
  readonly acceptedBy?: string;
  readonly acceptedAt?: string;
  /** Set when revoked. */
  readonly revokedBy?: string;
  readonly revokedAt?: string;
}

export type MembershipState = 'active' | 'removed';

export interface OrgMembership {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly orgId: string;
  /** The provider's stable subject id — from signed claims, never a header. */
  readonly subject: string;
  readonly role: OrgRole;
  readonly joinedAt: string;
  readonly state: MembershipState;
  /** The invite this membership was created from, so its provenance is traceable. */
  readonly viaInvite: string;
  readonly removedBy?: string;
  readonly removedAt?: string;
}

const hashToken = (inviteId: string, token: string): string =>
  createHash('sha256').update(`${inviteId}:${token}`).digest('hex');

export interface IssuedInvite {
  readonly invite: OrgInvite;
  /** The plaintext token to deliver. Transient — never store it, never log it. */
  readonly token: string;
}

/** Create a pending invitation and return it with the transient token to deliver. */
export function inviteToOrg(input: {
  readonly inviteId: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly invitedContact: string;
  readonly role: OrgRole;
  readonly token: string;
  readonly createdBy: string;
  readonly now: string;
  readonly ttlSeconds?: number;
}): IssuedInvite {
  const ttl = input.ttlSeconds ?? 7 * 24 * 3600; // seven days
  return {
    token: input.token,
    invite: {
      inviteId: input.inviteId,
      tenantId: input.tenantId,
      orgId: input.orgId,
      invitedContact: input.invitedContact,
      role: input.role,
      tokenHash: hashToken(input.inviteId, input.token),
      expiresAt: new Date(Date.parse(input.now) + ttl * 1000).toISOString(),
      state: 'pending',
      createdBy: input.createdBy,
      createdAt: input.now,
    },
  };
}

/** Effective state now — a `pending` invite past its expiry reads as expired without a sweep. */
export function inviteStateAt(invite: OrgInvite, now: string): InviteState {
  if (invite.state === 'pending' && Date.parse(now) > Date.parse(invite.expiresAt)) return 'expired';
  return invite.state;
}

export type AcceptOutcome =
  | 'accepted'
  | 'wrong_token'
  | 'expired'
  | 'revoked'
  | 'already_accepted'
  | 'tenant_mismatch';

export interface AcceptResult {
  readonly outcome: AcceptOutcome;
  readonly accepted: boolean;
  readonly invite: OrgInvite;
  /** The membership created on success. */
  readonly membership?: OrgMembership;
}

/**
 * Accept an invitation, binding the authenticated subject to the org.
 *
 * The subject and tenant come from the caller's VERIFIED claims (slice 1a), not from anything typed
 * in. Refusals are ordered so nothing leaks: a wrong tenant, a revoked/spent/expired invite is
 * refused before the token is compared, and the token is compared by hash.
 */
export function acceptInvite(input: {
  readonly invite: OrgInvite;
  readonly presentedToken: string;
  readonly subject: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly now: string;
}): AcceptResult {
  const { invite } = input;
  const refuse = (outcome: AcceptOutcome): AcceptResult => ({ outcome, accepted: false, invite });

  if (input.tenantId !== invite.tenantId) return refuse('tenant_mismatch');
  if (invite.state === 'accepted') return refuse('already_accepted');
  if (invite.state === 'revoked') return refuse('revoked');
  if (inviteStateAt(invite, input.now) === 'expired') return refuse('expired');
  if (hashToken(invite.inviteId, input.presentedToken) !== invite.tokenHash) return refuse('wrong_token');

  const acceptedInvite: OrgInvite = {
    ...invite,
    state: 'accepted',
    acceptedBy: input.subject,
    acceptedAt: input.now,
  };
  return {
    outcome: 'accepted',
    accepted: true,
    invite: acceptedInvite,
    membership: {
      membershipId: input.membershipId,
      tenantId: invite.tenantId,
      orgId: invite.orgId,
      subject: input.subject,
      role: invite.role,
      joinedAt: input.now,
      state: 'active',
      viaInvite: invite.inviteId,
    },
  };
}

/** Revoke a pending invitation. A spent or already-revoked invite is returned unchanged. */
export function revokeInvite(input: { invite: OrgInvite; revokedBy: string; now: string }): OrgInvite {
  if (input.invite.state !== 'pending') return input.invite;
  return { ...input.invite, state: 'revoked', revokedBy: input.revokedBy, revokedAt: input.now };
}

/** Remove a member from an org (append-only style: the record is marked, not deleted). */
export function removeMember(input: { membership: OrgMembership; removedBy: string; now: string }): OrgMembership {
  if (input.membership.state === 'removed') return input.membership;
  return { ...input.membership, state: 'removed', removedBy: input.removedBy, removedAt: input.now };
}

/** The active memberships of one org, within one tenant (OB-01). */
export function activeMemberships(
  memberships: readonly OrgMembership[],
  tenantId: string,
  orgId: string,
): readonly OrgMembership[] {
  return memberships.filter(
    (m) => m.state === 'active' && m.tenantId === tenantId && m.orgId === orgId,
  );
}

/**
 * The role a subject holds in an org, or undefined if they are not an active member.
 *
 * Tenant-scoped: a membership in another tenant never answers here, so a subject who shares an id
 * across tenants (they should not, but defence in depth) cannot borrow a role across the boundary.
 */
export function roleOf(
  memberships: readonly OrgMembership[],
  tenantId: string,
  orgId: string,
  subject: string,
): OrgRole | undefined {
  return activeMemberships(memberships, tenantId, orgId).find((m) => m.subject === subject)?.role;
}
