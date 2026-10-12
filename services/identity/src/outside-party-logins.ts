// API-01 · OB-76 "A" (owner, 12 Oct 2026, in writing, "Staff invite + 2nd approves") — logins for OUTSIDE PARTIES:
// a business customer's portal login (`b2b_customer`, M22-FR-04), an app customer's login (`customer`, M20), a supplier's
// portal login (`supplier`, M24-FR-01) (§28 · §35 · M02-FR-01 · M02-FR-04 · SEC-03 · hard rules #4 #6).
//
// Before: no governed path could give these three roles. The grant engine (`grantRole`) refuses a grant whose role holds a
// permission the APPROVER does not hold (`escalates_beyond_the_approver`), and no staff role holds `b2b.portal.self`,
// `storefront.order.read` or `supplier.portal.self` — rightly: those are an outside party's reads of its OWN rows.
//
// The owner's decision, built here as a NAMED, NARROW exception — for exactly these three roles, each bound to a party
// record — and nothing else:
//   • a member of staff who may MANAGE that party (`b2b.account.manage` for a business customer's account,
//     `customer.identity.manage` for a customer's record, `supplier.portal.manage` for a supplier's portal partner)
//     INVITES a named person's login, bound to that party's record (it must exist);
//   • a DIFFERENT person who also may manage that party APPROVES — the inviter cannot, the login itself cannot;
//   • both names stay on the record (the invite, the approval and the `RoleGranted` the access resolver folds);
//   • the role granted reads ONLY that party's own rows: the business customer's login is bound to its account (the
//     B2B portal's binding), the supplier's to its partner (the portal partner's logins), and an app customer's login IS
//     the customer's record (the storefront scopes every order read to the signed-in subject) — never another party's;
//   • a login that already holds any role (a member of staff, another party's login) is refused: one person, one party;
//   • the escalation rule is UNCHANGED for every staff role and for the generic grant route — this flow cannot give any
//     role but these three;
//   • REVOKE takes the role away (`RoleRevoked`, the ledger every reader folds), cuts the login's sessions on the next
//     request (the token revocation list), and ends its sign-in at the identity server when one is connected;
//   • the SIGN-IN itself is given the way `POST /v1/identity/people` gives one (`giveSignIn`): asked for on the ledger
//     before the identity server is touched, a one-time password made here and shown ONCE (never stored), second factor
//     required, a recent second-factor sign-in needed to ask.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { DirectoryUnavailableError, type IdentityDirectory } from './identity-directory';
import { giveSignIn, type PeopleDeps } from './people';
import type { TokenRevocation } from './revocation';
import { isGenericName, SIGN_IN_NAME, PRODUCT_ID, tidyPersonName, readablePersonName } from '../../../packages/identity/src/sign-in-names';

/** The three outside-party roles this flow may give — and no other (the named exception). */
export const OUTSIDE_PARTY_ROLES = ['b2b_customer', 'customer', 'supplier'] as const;
export type OutsidePartyRole = (typeof OUTSIDE_PARTY_ROLES)[number];

/** Each kind: the path segment, the permission that manages that party (to invite, approve, revoke), and its words. */
export const OUTSIDE_PARTY_KINDS: Readonly<Record<OutsidePartyRole, { readonly segment: string; readonly permission: string; readonly party: string }>> = {
  b2b_customer: { segment: 'b2b-accounts', permission: 'b2b.account.manage', party: 'business customer account' },
  customer: { segment: 'customers', permission: 'customer.identity.manage', party: 'customer record' },
  supplier: { segment: 'suppliers', permission: 'supplier.portal.manage', party: 'supplier portal partner' },
};

/** The code every refusal of the "an outside party's login holds only its own role" rule carries (round 14, verifier G5). */
export const OUTSIDE_LOGIN_REFUSAL_CODE = 'outside_party_login_holds_only_its_role';

/**
 * Round 14 (verifier G5): grant-time rule for every route that ADDS a role other than this flow — the generic grant
 * request and approval, an emergency grant, a joiner/mover change. `roleId` is the role being added; `outsideOf` is the
 * outside-party role the user holds NOW or has an open (invited or approved) invite for, from head office's own records
 * (never the request). undefined = acceptable; otherwise the plain-English reason.
 *   • an outside-party role is given only through this flow (two people, bound to its party) — never through those routes;
 *   • nothing is ever added to an outside party's login: one person, one party, never a member of staff's authority.
 */
export function outsidePartyGrantRefusal(roleId: string, outsideOf: string | undefined): string | undefined {
  if ((OUTSIDE_PARTY_ROLES as readonly string[]).includes(roleId)) {
    return `The ${roleId} role is an outside party's own login. It is given only through the outside-login invite a second person approves, bound to that party's record (OB-76) — never through this route.`;
  }
  if (outsideOf !== undefined) {
    return `This login belongs to an outside party (${outsideOf}). Nothing is added to an outside party's login — its password must never carry a member of staff's authority (OB-76). A member of staff gets their own login.`;
  }
  return undefined;
}

/** The B2B portal grants an invite for a business customer's login carries (the B2B portal's own list). */
export const B2B_LOGIN_GRANTS = ['place_order', 'view_invoices', 'view_statement', 'make_payment'] as const;

export type OutsideLoginState = 'invited' | 'approved' | 'rejected' | 'revoked';

export interface OutsideLoginInvite {
  readonly inviteId: string;
  readonly role: OutsidePartyRole;
  readonly partyId: string;
  readonly userId: string;
  readonly displayName: string;
  /** Business customer only: what the login may use on the B2B portal. */
  readonly grants?: readonly string[];
  readonly invitedBy: string;
  readonly invitedAt: string;
  readonly reason: string | null;
}

/** An invite with what became of it — both names kept. */
export interface OutsideLoginRecord extends OutsideLoginInvite {
  readonly state: OutsideLoginState;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly rejectedBy?: string;
  readonly rejectedAt?: string;
  readonly rejectReason?: string;
  readonly revokedBy?: string;
  readonly revokedAt?: string;
  readonly revokeReason?: string;
}

export type OutsideLoginEvent =
  | { readonly type: 'OutsideLoginInvited'; readonly invite: OutsideLoginInvite }
  | { readonly type: 'OutsideLoginApproved'; readonly inviteId: string; readonly approvedBy: string; readonly at: string }
  | { readonly type: 'OutsideLoginRejected'; readonly inviteId: string; readonly rejectedBy: string; readonly reason: string; readonly at: string }
  | { readonly type: 'OutsideLoginRevoked'; readonly inviteId: string; readonly revokedBy: string; readonly reason: string; readonly at: string };

/** Fold the events, in append order, into one record per invite. */
export function foldOutsideLogins(events: readonly OutsideLoginEvent[]): readonly OutsideLoginRecord[] {
  const byId = new Map<string, OutsideLoginRecord>();
  for (const e of events) {
    if (e.type === 'OutsideLoginInvited') {
      if (!byId.has(e.invite.inviteId)) byId.set(e.invite.inviteId, { ...e.invite, state: 'invited' });
      continue;
    }
    const r = byId.get(e.inviteId);
    if (r === undefined) continue;
    if (e.type === 'OutsideLoginApproved' && r.state === 'invited') byId.set(r.inviteId, { ...r, state: 'approved', approvedBy: e.approvedBy, approvedAt: e.at });
    else if (e.type === 'OutsideLoginRejected' && r.state === 'invited') byId.set(r.inviteId, { ...r, state: 'rejected', rejectedBy: e.rejectedBy, rejectedAt: e.at, rejectReason: e.reason });
    else if (e.type === 'OutsideLoginRevoked' && r.state === 'approved') byId.set(r.inviteId, { ...r, state: 'revoked', revokedBy: e.revokedBy, revokedAt: e.at, revokeReason: e.reason });
  }
  return [...byId.values()];
}

export interface OutsidePartyLoginDeps {
  readonly now: () => string;
  readonly invites: (tenantId: string) => Promise<readonly OutsideLoginRecord[]> | readonly OutsideLoginRecord[];
  /** Round 14 (G6): 'login_taken' when another invite for the same login won the per-login guard at the same moment. */
  readonly recordInvite: (tenantId: string, invite: OutsideLoginInvite) => Promise<void | 'login_taken'> | void | 'login_taken';
  /**
   * ONE batch: the approval AND the `RoleGranted` (assignment + who asked + who approved) the access resolver folds. Round
   * 14 (G6): under a per-login guard — 'login_taken' when another approval bound the same login at the same moment.
   */
  readonly recordApproval: (tenantId: string, invite: OutsideLoginInvite, approvedBy: string, at: string) => Promise<void | 'login_taken'> | void | 'login_taken';
  readonly recordRejection: (tenantId: string, inviteId: string, rejectedBy: string, reason: string, at: string) => Promise<void> | void;
  /**
   * ONE batch: the revocation, the `RoleRevoked` that takes the role away on the ledger every reader folds, AND (round 14,
   * verifier G4) the append-only UNBINDING of the login from its party where the party's own reads look.
   */
  readonly recordRevocation: (tenantId: string, invite: OutsideLoginInvite, revokedBy: string, reason: string, at: string) => Promise<void> | void;
  /** The roles a user holds NOW (grants minus revocations). */
  readonly rolesHeldBy: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  /** Does the party record exist (a B2B account with a credit limit set, a customer record, a configured portal partner)? */
  readonly partyExists: (tenantId: string, role: OutsidePartyRole, partyId: string) => Promise<boolean> | boolean;
  /**
   * Bind the login to its party's record where the party's own reads look (the B2B binding, the partner's logins). Round 14
   * (verifier G4): keyed per INVITE, so re-binding a login to a party it was bound to before is a fresh record, never a
   * collapse onto the old one. Idempotent per invite.
   */
  readonly bind: (tenantId: string, invite: OutsideLoginInvite, by: string, at: string) => Promise<void> | void;
  /** The token revocation list the authenticator consults — a revoked login's open sessions end on the next request. */
  readonly revocations?: { readonly revoke: (tenantId: string, revocation: TokenRevocation) => Promise<void> | void };
  /** The login's sign-in at the identity server, ended on revoke (when one is connected). */
  readonly signIns?: { readonly end: (tenantId: string, userId: string, endedBy: string, at: string) => Promise<'ended' | 'none' | 'not_connected'> };
  /** The people ledger and the identity server — the sign-in is given the way `POST /v1/identity/people` gives one. */
  readonly people: Pick<PeopleDeps, 'now' | 'people' | 'recordPerson' | 'generatePassword'>;
  readonly directory?: IdentityDirectory;
  readonly directoryTenantId?: string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const PARTY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const notSaved = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
const origin = (ctx: RequestContext) => ({ tenantId: ctx.tenantId, branchId: ctx.branchId ?? null });

/** Round 14 (G6): the refusal when the per-login guard was won by another invite or approval at the same moment. */
const loginTaken = (userId: string) => notSaved(409, 'login_claimed_at_the_same_moment', `Another invite or approval for login ${userId} was recorded at the same moment. One login is bound to one party, so this one was not recorded.`, 'Read the logins list: the other one stands. Revoke or reject it first if this one is the one wanted. Nothing was changed.');

/** What a list and a decision show: the record, never a password. */
const present = (r: OutsideLoginRecord) => r;

export function outsidePartyLoginRoutes(deps: OutsidePartyLoginDeps): readonly Route[] {
  const directoryFor = (tenantId: string): IdentityDirectory | undefined =>
    deps.directoryTenantId !== undefined && deps.directoryTenantId !== tenantId ? undefined : deps.directory;
  const inviteOf = async (tenantId: string, role: OutsidePartyRole, inviteId: string): Promise<OutsideLoginRecord> => {
    const r = (await deps.invites(tenantId)).find((x) => x.inviteId === inviteId);
    // Another kind's invite is not this route's business: the same 404, so a manager of one kind learns nothing of another.
    if (r === undefined || r.role !== role) throw notSaved(404, 'outside_login_invite_unknown', `No ${OUTSIDE_PARTY_KINDS[role].party} login invite "${inviteId}" is held.`, 'Check the invite reference. Nothing was changed.');
    return r;
  };

  return OUTSIDE_PARTY_ROLES.flatMap((role): Route[] => {
    const kind = OUTSIDE_PARTY_KINDS[role];
    const base = `/v1/identity/outside-logins/${kind.segment}`;
    return [
      {
        // Who holds (or was invited to hold) a login for this kind of party, with both names and the state.
        api: 'API-01', method: 'GET', path: base,
        permission: kind.permission,
        handler: async (ctx) => ({
          status: 200,
          body: { role, logins: (await deps.invites(ctx.tenantId)).filter((r) => r.role === role).map(present), signInsConnected: directoryFor(ctx.tenantId) !== undefined },
        }),
      },
      {
        // INVITE: a member of staff who manages this party asks for a named person's login, bound to the party's record.
        // Body: { userId, displayName, grants? (business customer only), reason? }.
        api: 'API-01', method: 'POST', path: `${base}/:partyId/invites/:inviteId`,
        permission: kind.permission, idempotent: true,
        handler: async (ctx) => {
          const partyId = (ctx.params['partyId'] ?? '').trim();
          const inviteId = (ctx.params['inviteId'] ?? '').trim();
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          const userId = isStr(b['userId']) ? b['userId'].trim() : role === 'customer' ? partyId : '';
          const displayName = isStr(b['displayName']) ? tidyPersonName(b['displayName']) : '';
          const grants = role === 'b2b_customer' ? b['grants'] : undefined;
          const grantsOk = role !== 'b2b_customer' || (Array.isArray(grants) && grants.length > 0 && grants.every((g) => (B2B_LOGIN_GRANTS as readonly unknown[]).includes(g)));
          if (!PARTY_ID.test(partyId) || !PARTY_ID.test(inviteId) || !PRODUCT_ID.test(userId) || !readablePersonName(displayName) || !grantsOk
            || (b['reason'] !== undefined && b['reason'] !== null && typeof b['reason'] !== 'string')) {
            throw notSaved(400, 'not_readable_as_an_outside_login', `An invite for a ${kind.party} login needs the party and an invite reference in the path and { userId (the login's id: 3–64 of a–z, 0–9, . _ -), displayName (the person's full name)${role === 'b2b_customer' ? `, grants: [one or more of ${B2B_LOGIN_GRANTS.join(' | ')}]` : ''}, reason? }.`, 'Send the login\'s id and the person\'s full name. Nothing was saved.');
          }
          if (isGenericName(userId) || isGenericName(displayName)) {
            throw notSaved(422, 'shared_or_generic_sign_in', `"${isGenericName(displayName) ? displayName : userId}" names a job, a place or a shared account, not a person. Every login belongs to one named person (M02-FR-01) — a business's or supplier's staff each get their own.`, 'Use the person\'s own name. Nothing was saved.');
          }
          if (role === 'customer' && userId !== partyId) {
            throw notSaved(422, 'customer_login_is_the_customer_record', `An app customer's login IS their customer record — the storefront scopes every order to the signed-in customer — so the login for customer record ${partyId} must be ${partyId}, not ${userId}.`, 'Invite the login as the customer record\'s own id. Nothing was saved.');
          }
          if (userId === ctx.userId) throw notSaved(422, 'inviting_yourself', 'Nobody invites a login for themselves.', 'Ask a colleague. Nothing was saved.');
          const all = await deps.invites(ctx.tenantId);
          const same = all.find((r) => r.inviteId === inviteId);
          if (same !== undefined) {
            if (same.role === role && same.partyId === partyId && same.userId === userId && same.displayName === displayName) return { status: 200, body: { invite: present(same), alreadyInvited: true } };
            throw notSaved(409, 'invite_reference_already_used', `Invite ${inviteId} is already held for a different login or party.`, 'Use a new invite reference. Nothing was saved.');
          }
          if (all.some((r) => r.userId === userId && (r.state === 'invited' || r.state === 'approved'))) {
            throw notSaved(409, 'login_already_invited', `${userId} already has an open invite or an approved login. One login is bound to one party.`, 'Read the logins list; revoke the old one first if the person moved. Nothing was saved.');
          }
          if ((await deps.rolesHeldBy(ctx.tenantId, userId)).length > 0) {
            throw notSaved(422, 'login_already_holds_a_role', `${userId} already holds a role here. An outside party's login is its own — never a member of staff's, never another party's.`, 'Invite a new login id for this person. Nothing was saved.');
          }
          if (!(await deps.partyExists(ctx.tenantId, role, partyId))) {
            throw notSaved(422, 'party_record_unknown', `No ${kind.party} "${partyId}" is held here, so there is nothing to bind a login to.`, `Set up the ${kind.party} first. Nothing was saved.`);
          }
          const at = deps.now();
          const invite: OutsideLoginInvite = {
            inviteId, role, partyId, userId, displayName, ...(role === 'b2b_customer' ? { grants: [...new Set(grants as string[])].sort() } : {}),
            invitedBy: ctx.userId, invitedAt: at, reason: isStr(b['reason']) ? b['reason'].trim() : null,
          };
          // Round 14 (verifier G6): the invite claims the LOGIN under a per-login guard — of two invites for one login sent
          // at the same moment exactly one is recorded; the other is a visible 409, never a second party.
          if ((await deps.recordInvite(ctx.tenantId, invite)) === 'login_taken') throw loginTaken(userId);
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'outside_login.invite', objectType: 'user', objectId: userId, at, origin: origin(ctx),
            before: null, after: { role, partyId, inviteId, ...(invite.grants === undefined ? {} : { grants: invite.grants.join(',') }) }, correlationId: inviteId,
          });
          return { status: 201, body: { invite: { ...invite, state: 'invited' }, alreadyInvited: false } };
        },
      },
      {
        // APPROVE: a DIFFERENT person who also manages this party. The role is granted and the login bound to the party, the
        // inviter and the approver both on the record. The escalation rule is not asked here — this is the owner's named
        // exception for an outside party's own-rows role — and nothing else can be granted through it.
        api: 'API-01', method: 'POST', path: `${base}/invites/:inviteId/approve`,
        permission: kind.permission, idempotent: true,
        handler: async (ctx) => {
          const inviteId = (ctx.params['inviteId'] ?? '').trim();
          const r = await inviteOf(ctx.tenantId, role, inviteId);
          if (r.state === 'approved') {
            // A re-sent approval finishes a binding a lost reply may have left half-done (each write collapses on its key).
            await deps.bind(ctx.tenantId, r, r.approvedBy ?? ctx.userId, r.approvedAt ?? deps.now());
            return { status: 200, body: { login: present(r), alreadyApproved: true } };
          }
          if (r.state !== 'invited') throw notSaved(409, `invite_${r.state}`, `Invite ${inviteId} was ${r.state} and cannot be approved.`, 'Invite again if the login is still wanted. Nothing was changed.');
          if (r.invitedBy === ctx.userId) {
            throw notSaved(422, 'approved_by_the_inviter', `${ctx.userId} invited this login and cannot also approve it — two names on one action performed by one person is a self-approval with an extra step (§28).`, 'Ask a colleague who also manages this party to approve it. Nothing was changed.');
          }
          if (r.userId === ctx.userId) throw notSaved(422, 'granting_to_yourself', 'Nobody approves their own login.', 'Ask a colleague. Nothing was changed.');
          if (!(await deps.partyExists(ctx.tenantId, role, r.partyId))) {
            throw notSaved(422, 'party_record_unknown', `The ${kind.party} "${r.partyId}" is no longer held here.`, 'Nothing was changed.');
          }
          if ((await deps.rolesHeldBy(ctx.tenantId, r.userId)).length > 0) {
            throw notSaved(422, 'login_already_holds_a_role', `${r.userId} has come to hold a role since the invite. An outside party's login is its own.`, 'Reject this invite and invite a new login id. Nothing was changed.');
          }
          const at = deps.now();
          // Round 14 (verifier G6): the approval claims the LOGIN under the same per-login guard — two approvals binding one
          // login to two parties at once: exactly one wins, the other is a visible 409 and binds nothing.
          if ((await deps.recordApproval(ctx.tenantId, r, ctx.userId, at)) === 'login_taken') throw loginTaken(r.userId);
          // Then the binding — its read resolves the login's CURRENT party from the approved invite (round 14, G4), so a grant
          // whose binding write was cut off still reads its own party only; a re-sent approval finishes the binding.
          await deps.bind(ctx.tenantId, r, ctx.userId, at);
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'outside_login.approve', objectType: 'user', objectId: r.userId, at, origin: origin(ctx),
            before: { state: 'invited', invitedBy: r.invitedBy }, after: { state: 'approved', role, partyId: r.partyId, invitedBy: r.invitedBy, approvedBy: ctx.userId },
            correlationId: inviteId,
          });
          return { status: 200, body: { login: { ...r, state: 'approved', approvedBy: ctx.userId, approvedAt: at }, alreadyApproved: false } };
        },
      },
      {
        // REJECT a pending invite, with the reason. Nothing is granted.
        api: 'API-01', method: 'POST', path: `${base}/invites/:inviteId/reject`,
        permission: kind.permission, idempotent: true,
        handler: async (ctx) => {
          const inviteId = (ctx.params['inviteId'] ?? '').trim();
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          if (!isStr(b['reason'])) throw notSaved(400, 'rejection_needs_a_reason', 'Rejecting an invite needs { reason }.', 'Send the reason. Nothing was changed.');
          const r = await inviteOf(ctx.tenantId, role, inviteId);
          if (r.state === 'rejected') return { status: 200, body: { login: present(r), alreadyRejected: true } };
          if (r.state !== 'invited') throw notSaved(409, `invite_${r.state}`, `Invite ${inviteId} was ${r.state}; only a pending invite can be rejected.`, r.state === 'approved' ? 'Revoke the login instead. Nothing was changed.' : 'Nothing was changed.');
          const at = deps.now();
          await deps.recordRejection(ctx.tenantId, inviteId, ctx.userId, b['reason'].trim(), at);
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'outside_login.reject', objectType: 'user', objectId: r.userId, at, origin: origin(ctx),
            before: { state: 'invited', invitedBy: r.invitedBy }, after: { state: 'rejected' }, reason: b['reason'].trim(), correlationId: inviteId,
          });
          return { status: 200, body: { login: { ...r, state: 'rejected', rejectedBy: ctx.userId, rejectedAt: at, rejectReason: b['reason'].trim() }, alreadyRejected: false } };
        },
      },
      {
        // REVOKE an approved login, with the reason: its sign-in ended at the identity server (when connected), the role
        // taken away on the ledger, and its open sessions cut on the next request.
        api: 'API-01', method: 'POST', path: `${base}/invites/:inviteId/revoke`,
        permission: kind.permission, idempotent: true,
        handler: async (ctx) => {
          const inviteId = (ctx.params['inviteId'] ?? '').trim();
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          if (!isStr(b['reason'])) throw notSaved(400, 'revocation_needs_a_reason', 'Revoking a login needs { reason }.', 'Send the reason. Nothing was changed.');
          const r = await inviteOf(ctx.tenantId, role, inviteId);
          if (r.state === 'revoked') return { status: 200, body: { login: present(r), alreadyRevoked: true } };
          if (r.state !== 'approved') throw notSaved(409, `invite_${r.state}`, `Invite ${inviteId} is ${r.state}; only an approved login can be revoked.`, r.state === 'invited' ? 'Reject the pending invite instead. Nothing was changed.' : 'Nothing was changed.');
          const at = deps.now();
          if (deps.signIns !== undefined) {
            try { await deps.signIns.end(ctx.tenantId, r.userId, ctx.userId, at); } catch (e) {
              if (e instanceof DirectoryUnavailableError) throw notSaved(503, 'identity_server_unavailable', `${e.message}. The login's sign-in could not be switched off, so nothing was changed.`, 'Try again when the identity server answers.');
              throw e;
            }
          }
          await deps.recordRevocation(ctx.tenantId, r, ctx.userId, b['reason'].trim(), at);
          await deps.revocations?.revoke(ctx.tenantId, {
            id: `rev-outside-${inviteId}`, tenantId: ctx.tenantId, userId: r.userId, issuedBefore: Math.floor(Date.parse(at) / 1000),
            reason: 'admin_revoked', revokedBy: ctx.userId, revokedAt: at,
          });
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'outside_login.revoke', objectType: 'user', objectId: r.userId, at, origin: origin(ctx),
            before: { state: 'approved', role, partyId: r.partyId }, after: { state: 'revoked' }, reason: b['reason'].trim(), correlationId: inviteId,
          });
          return { status: 200, body: { login: { ...r, state: 'revoked', revokedBy: ctx.userId, revokedAt: at, revokeReason: b['reason'].trim() }, alreadyRevoked: false } };
        },
      },
      {
        // The SIGN-IN for an approved login, given the way `POST /v1/identity/people` gives one: the one-time password is
        // shown ONCE to the person asking (a recent second-factor sign-in needed), to hand to the party; kept nowhere.
        api: 'API-01', method: 'POST', path: `${base}/invites/:inviteId/sign-in`,
        permission: kind.permission, idempotent: true,
        reauth: { withinSeconds: 300, amr: ['mfa'] },
        shownOnce: ['oneTimePassword'],
        handler: async (ctx) => {
          const inviteId = (ctx.params['inviteId'] ?? '').trim();
          const b = (ctx.body ?? {}) as Record<string, unknown>;
          if (b['password'] !== undefined || b['oneTimePassword'] !== undefined) {
            throw notSaved(400, 'password_is_never_sent', 'A password was sent. Head office makes the one-time password itself and shows it once; nobody types one in.', 'Send the sign-in name only. Nothing was saved.');
          }
          const username = isStr(b['signInName']) ? b['signInName'].trim().toLowerCase() : '';
          if (!SIGN_IN_NAME.test(username)) throw notSaved(400, 'not_readable_as_a_sign_in', 'A sign-in needs { signInName (3–40 of a–z, 0–9, . _ -) }.', 'Send the person\'s own sign-in name. Nothing was saved.');
          if (isGenericName(username)) throw notSaved(422, 'shared_or_generic_sign_in', `"${username}" names a job, a place or a shared account, not a person (M02-FR-01).`, 'Use the person\'s own name. Nothing was saved.');
          const r = await inviteOf(ctx.tenantId, role, inviteId);
          if (r.state !== 'approved') throw notSaved(409, `invite_${r.state}`, `Invite ${inviteId} is ${r.state}; a sign-in is given only to an approved login.`, r.state === 'invited' ? 'Have a second person approve it first. Nothing was saved.' : 'Nothing was saved.');
          if (r.userId === ctx.userId) throw notSaved(422, 'signing_in_yourself', 'Nobody gives themselves a sign-in.', 'Ask a colleague. Nothing was saved.');
          return giveSignIn({ ...deps.people, ...(deps.recordAudit === undefined ? {} : { recordAudit: deps.recordAudit }) }, directoryFor(ctx.tenantId), ctx, { userId: r.userId, username, displayName: r.displayName }, {
            // The login may hold its own outside-party role and nothing else — never a member of staff's authority.
            holdsAuthority: async (tenantId, id) => (await deps.rolesHeldBy(tenantId, id)).some((x) => x !== role),
            holderRefusal: { code: 'login_holds_more_than_its_party_role', whatHappened: `${r.userId} holds more than the ${role} role, so a one-time password made here could be used with a member of staff's authority.`, nextSafeAction: 'The administrator gives this sign-in at the identity server, in the person\'s presence. Nothing was saved.' },
            auditAction: 'outside_login.sign_in.issue',
            auditAfter: { role, partyId: r.partyId, inviteId },
          });
        },
      },
    ];
  });
}
