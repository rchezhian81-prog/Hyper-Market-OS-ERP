// API-01 Identity / Admin — orgs, branches, users, roles, approvals, config, number series.
//
// **This service never stores a credential**, and that is not an omission — it is M02-FR-01's
// deliberate partial. Passwords, passkeys and MFA enrolment belong to the deployment identity
// provider; holding them here would put credentials in this codebase, which hard rule #4 forbids.
// What this service does is resolve a token that the IdP issued into *scope*: which tenant, which
// branches, which role. A test reads the module's exports to prove there is nowhere to put a
// password.
//
// The other rule with teeth: **a role assignment is maker-checker** (§28, SEC-03). Granting
// yourself a permission is the shortest path to every other control in the product, so the one
// thing this service will not do is let one person widen their own authority.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound, requireActorIsCaller, secondPersonIsASeparateAct } from '../../kernel/src/index';
import type { Permission, Role, RoleAssignment } from '../../../packages/rbac/src/rbac';
import { formatNumber, type NumberFormat } from '../../../packages/numbering/src/numbering';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { REVOCATION_REASONS, type TokenRevocation, type RevocationReason } from './revocation';
import { firstUnknownStore, storeComputerGrantRefusal, unknownStoreWords } from '../../platform/src/store-computer-identity';
import { machineIdentityGrantRefusal, MACHINE_IDENTITY_REFUSAL_CODE } from './machine-identities';
import { outsidePartyGrantRefusal, OUTSIDE_LOGIN_REFUSAL_CODE } from './outside-party-logins';
import { dutiesGrantRefusal, SEPARATION_OF_DUTIES_REFUSAL_CODE } from './separation-of-duties';

/**
 * Document number formats per type (M01-FR-02) — configuration, not tenant data: what an invoice
 * number LOOKS like is the product's rule; the gap-free series behind it is per tenant. Kept here in
 * the identity/admin service, which owns "orgs, config, number series".
 */
export const NUMBER_FORMATS: Readonly<Record<string, NumberFormat>> = {
  receipt: { prefix: 'RCP', padTo: 6 },
  invoice: { prefix: 'INV', padTo: 6 },
  po: { prefix: 'PO', padTo: 6 },
  grn: { prefix: 'GRN', padTo: 6 },
  statement: { prefix: 'STMT', padTo: 6 },
  // SP-7c (M23-FR-02): a debit note ISSUED to a supplier carries a number from the tenant's own series.
  debit_note: { prefix: 'DN', padTo: 6 },
};

// Resolving a token into scope. It verifies and never issues — see the file for why.
export * from './token';

export interface GrantRequest {
  readonly grantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly requestedAt: string;
}

/** A role asked for by one signed-in person, awaiting another (Wave 2b · audit PA-03). */
export interface PendingGrantRequest {
  readonly grantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: readonly string[] | 'all';
  /** The caller who asked — never a name from the body. */
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly reason: string;
}

export interface GrantRejection {
  readonly grantId: string;
  readonly rejectedBy: string;
  readonly reason: string;
  readonly at: string;
}

export type GrantRequestState = 'pending' | 'granted' | 'rejected';

/** A request with what became of it, folded from the ledger. */
export interface GrantRequestRecord extends PendingGrantRequest {
  readonly state: GrantRequestState;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

export type GrantRefusal =
  | 'granting_to_yourself'
  | 'approved_by_the_requester'
  | 'not_approved'
  | 'unknown_role'
  | 'escalates_beyond_the_approver'
  | 'store_computer_grant_must_name_one_store';

export interface GrantResult {
  readonly ok: boolean;
  readonly assignment?: RoleAssignment;
  readonly refusedBecause?: GrantRefusal;
  readonly detail: string;
}

/**
 * Grant a role, or refuse.
 *
 * The last refusal is the one people forget: an approver cannot approve a grant that hands out a
 * permission **they do not themselves hold**. Otherwise a supervisor who may approve access
 * changes can create an administrator, which makes every other limit on that supervisor
 * decorative.
 */
export function grantRole(input: {
  readonly request: GrantRequest;
  readonly roles: readonly Role[];
  readonly approverPermissions: readonly Permission[];
}): GrantResult {
  const { request } = input;
  const role = input.roles.find((r) => r.id === request.roleId);

  if (role === undefined) {
    return { ok: false, refusedBecause: 'unknown_role', detail: `no role ${request.roleId}` };
  }
  if (request.requestedBy === request.userId) {
    return {
      ok: false, refusedBecause: 'granting_to_yourself',
      detail: `${request.requestedBy} is requesting a role for themselves. Widening your own authority is the shortest path to every other control in this product`,
    };
  }
  if (request.approvedBy === undefined) {
    return { ok: false, refusedBecause: 'not_approved', detail: 'a role grant needs a second person (§28)' };
  }
  if (request.approvedBy === request.requestedBy) {
    return {
      ok: false, refusedBecause: 'approved_by_the_requester',
      detail: `${request.requestedBy} both requested and approved this. Two names on one action performed by one person is a self-approval with an extra step`,
    };
  }

  // OB-54: a store computer's grant names its one store — never the whole tenant, never several stores.
  const unbound = storeComputerGrantRefusal(request.roleId, request.branchScope);
  if (unbound !== undefined) return { ok: false, refusedBecause: 'store_computer_grant_must_name_one_store', detail: unbound };

  const beyond = role.permissions.filter((p) => !input.approverPermissions.includes(p));
  if (beyond.length > 0) {
    return {
      ok: false, refusedBecause: 'escalates_beyond_the_approver',
      detail: `${request.approvedBy} cannot grant ${beyond.join(', ')} because they do not hold it. Otherwise somebody who may approve access changes can create an administrator, and every other limit on them is decorative`,
    };
  }

  return {
    ok: true,
    assignment: { userId: request.userId, roleId: request.roleId, branchScope: request.branchScope },
    detail: `${request.userId} granted ${role.name} by ${request.requestedBy}, approved by ${request.approvedBy}`,
  };
}

export interface IdentityDeps {
  /**
   * Round 18 (verifier r17 C-2 c): the stores head office has registered (org tree branches, stores with settings). When
   * wired, a grant's branch scope must name only these — never a ghost store (422 `unknown_store`).
   */
  readonly registeredStores?: (tenantId: string) => Promise<ReadonlySet<string>>;
  readonly roles: (tenantId: string) => Promise<readonly Role[]> | readonly Role[];
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly Permission[]> | readonly Permission[];
  readonly recordGrant: (tenantId: string, a: RoleAssignment, g: GrantRequest) => Promise<void> | void;
  /** Every grant request the tenant has seen, with its state (Wave 2b · PA-03). */
  readonly grantRequests: (tenantId: string) => Promise<readonly GrantRequestRecord[]> | readonly GrantRequestRecord[];
  readonly recordGrantRequest: (tenantId: string, request: PendingGrantRequest) => Promise<void> | void;
  readonly recordGrantRejection: (tenantId: string, rejection: GrantRejection) => Promise<void> | void;
  /**
   * PA-12 round 10: the roles a user holds NOW, from the ledger — so a machine-only role (`backup_job`) is never mixed
   * with a person's roles. Optional on a bare stub (then the rule cannot be judged and is not claimed).
   */
  readonly rolesHeldBy?: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  /** PA-12 r12: whether this user is a PERSON — given a sign-in at the identity server (/v1/identity/people). */
  readonly isPerson?: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  /**
   * Round 14 (verifier G5): the outside-party role (OB-76) this user holds now or has an open invite for — undefined for
   * anyone else. Nothing is added to an outside party's login, and an outside-party role is never given here.
   */
  readonly outsideLoginOf?: (tenantId: string, userId: string) => Promise<string | undefined> | string | undefined;
  /**
   * Seal this privilege change into the tamper-evident domain audit trail (M34-FR-01), attributed to the
   * acting user. Optional — the running system provides it; a bare deps stub may omit it. The actor is
   * ALWAYS the caller (`ctx.userId`), never client-supplied; a role grant is exactly the "who was given
   * access, by whom, approved by whom" record an auditor comes looking for (§28, hard rule #5).
   */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly branches: (tenantId: string) => Promise<readonly { id: string; name: string }[]> | readonly { id: string; name: string }[];
  /** Allocate the next gap-free sequence number for a tenant's document type (M01-FR-02). */
  readonly allocateNumber: (tenantId: string, docType: string) => Promise<number>;
  /**
   * Token revocation (GAP-SEC-05 · SEC-11): record a revocation so the authenticator refuses the token(s) from
   * now on, and list what has been revoked. Optional — a bare deps stub may omit it, and the two routes then
   * refuse honestly (503) rather than pretend a revocation took effect.
   */
  readonly revocations?: {
    readonly revoke: (tenantId: string, revocation: TokenRevocation) => Promise<void> | void;
    readonly list: (tenantId: string) => Promise<readonly TokenRevocation[]> | readonly TokenRevocation[];
  };
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const noRevocationStore = () => apiError(503, {
  code: 'revocation_store_unavailable',
  whatHappened: 'This deployment has no revocation store wired, so a token cannot be revoked here.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Wire the identity ledger (production always does). Nothing was revoked.',
});

export function identityRoutes(deps: IdentityDeps): readonly Route[] {
  return [
    {
      api: 'API-01', method: 'GET', path: '/v1/identity/me',
      permission: 'identity.self.read',
      handler: async (ctx) => ({
        status: 200,
        body: {
          tenantId: ctx.tenantId, userId: ctx.userId, branchId: ctx.branchId,
          permissions: await deps.permissionsOf(ctx.tenantId, ctx.userId),
          // No credential of any kind is returned, because none is held.
        },
      }),
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/identity/roles',
      permission: 'identity.role.read',
      handler: async (ctx) => ({ status: 200, body: { roles: await deps.roles(ctx.tenantId) } }),
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/org/branches',
      permission: 'org.branch.read',
      handler: async (ctx) => ({ status: 200, body: { branches: await deps.branches(ctx.tenantId) } }),
    },
    {
      // THE MAKER's act (Wave 2b · audit PA-03 · §28): ask for a role for somebody else. Who asks is the caller — a
      // body that names a different requester, or names an approver at all, is refused by name: the second person
      // acts under their OWN sign-in through …/approve. Nothing is granted here; the request waits. Sensitive
      // (SEC-03): a recent MFA re-authentication is required at the boundary (GAP-SEC-06).
      api: 'API-01', method: 'POST', path: '/v1/identity/grants',
      permission: 'identity.role.request', idempotent: true,
      reauth: { withinSeconds: 300, amr: ['mfa'] },
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['approvedBy'] !== undefined) throw secondPersonIsASeparateAct('approvedBy', 'POST /v1/identity/grants/:grantId/approve');
        requireActorIsCaller(ctx, b, 'requestedBy');
        const scope = b['branchScope'] === 'all'
          ? ('all' as const)
          : Array.isArray(b['branchScope']) && (b['branchScope'] as unknown[]).every((x) => typeof x === 'string') ? (b['branchScope'] as string[]) : undefined;
        if (!isStr(b['grantId']) || !isStr(b['userId']) || !isStr(b['roleId']) || scope === undefined || (b['reason'] !== undefined && typeof b['reason'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_grant_request',
            whatHappened: 'A grant request needs { grantId, userId, roleId, branchScope ("all" or branch ids), reason? }. Who asks is taken from your sign-in.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send who should hold which role, where. Nothing was requested.',
          });
        }
        const grantId = b['grantId'] as string; const userId = b['userId'] as string; const roleId = b['roleId'] as string;
        const roles = await deps.roles(ctx.tenantId);
        if (!roles.some((r) => r.id === roleId)) {
          throw apiError(422, { code: 'unknown_role', whatHappened: `There is no role "${roleId}" in this product's catalogue.`, wasItSaved: 'not_saved', nextSafeAction: 'Name a role from GET /v1/identity/roles. Nothing was requested.' });
        }
        // OB-54: refused at the REQUEST, before anybody is asked to approve it.
        const unbound = storeComputerGrantRefusal(roleId, scope);
        if (unbound !== undefined) {
          throw apiError(422, { code: 'store_computer_grant_must_name_one_store', whatHappened: unbound, wasItSaved: 'not_saved', nextSafeAction: 'Request the store computer role for this box\'s own store only: branchScope ["<its store>"]. Nothing was requested.' });
        }
        // Round 18 (verifier r17 C-2 c): a scope names only stores head office knows — a pasted or mistyped store is never
        // granted (it would book a box's till cash at a ghost store, and count as a store for OB-82).
        if (scope !== 'all' && deps.registeredStores !== undefined) {
          const ghost = firstUnknownStore(scope, await deps.registeredStores(ctx.tenantId));
          if (ghost !== undefined) throw apiError(422, unknownStoreWords(ghost, 'The grant\'s branchScope'));
        }
        // PA-12 round 10: a machine identity (backup_job) is never also a person — refused at the REQUEST.
        if (deps.rolesHeldBy !== undefined) {
          const held = await deps.rolesHeldBy(ctx.tenantId, userId);
          const mixed = machineIdentityGrantRefusal(roleId, held, (await deps.isPerson?.(ctx.tenantId, userId)) ?? false);
          if (mixed !== undefined) {
            throw apiError(422, { code: MACHINE_IDENTITY_REFUSAL_CODE, whatHappened: mixed, wasItSaved: 'not_saved', nextSafeAction: 'Give the machine its own sign-in holding only its role, and the person their own. Nothing was requested.' });
          }
          // OB-95 (owner, 13 Oct 2026): never the IT/platform role and a business role on one person — refused at the REQUEST.
          const both = dutiesGrantRefusal(roleId, held, roles);
          if (both !== undefined) {
            throw apiError(422, { code: SEPARATION_OF_DUTIES_REFUSAL_CODE, whatHappened: both, wasItSaved: 'not_saved', nextSafeAction: 'Give the IT work and the business work to two different people, each with their own sign-in. Nothing was requested.' });
          }
        }
        // Round 14 (verifier G5): nothing is added to an outside party's login, and an outside-party role is never given here.
        const outside = outsidePartyGrantRefusal(roleId, await deps.outsideLoginOf?.(ctx.tenantId, userId));
        if (outside !== undefined) throw apiError(422, { code: OUTSIDE_LOGIN_REFUSAL_CODE, whatHappened: outside, wasItSaved: 'not_saved', nextSafeAction: 'Give a member of staff their own login; an outside party\'s login is invited through the outside-login screen. Nothing was requested.' });
        if (userId === ctx.userId) {
          throw apiError(422, {
            code: 'granting_to_yourself',
            whatHappened: `${ctx.userId} is requesting a role for themselves. Widening your own authority is the shortest path to every other control in this product.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have somebody else request it. Nothing was requested.',
          });
        }
        const existing = (await deps.grantRequests(ctx.tenantId)).find((g) => g.grantId === grantId);
        if (existing !== undefined) {
          return { status: 202, body: { grantId, state: existing.state, requestedBy: existing.requestedBy, alreadyRequested: true } };
        }
        const request: PendingGrantRequest = {
          grantId, userId, roleId, branchScope: scope, requestedBy: ctx.userId, requestedAt: deps.now(),
          reason: typeof b['reason'] === 'string' ? b['reason'] : '',
        };
        await deps.recordGrantRequest(ctx.tenantId, request);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'role.grant.request', objectType: 'user', objectId: userId,
          at: request.requestedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: { roleId, branchScope: scope === 'all' ? 'all' : scope.join(','), reason: request.reason },
          correlationId: grantId,
        });
        return { status: 202, body: { grantId, state: 'pending', requestedBy: ctx.userId } };
      },
    },
    {
      // THE CHECKER's act: approve a pending request under your own sign-in. The engine's §28 rules now run with the
      // REAL two people — the approver cannot be the requester, and cannot hand out a permission they do not hold.
      api: 'API-01', method: 'POST', path: '/v1/identity/grants/:grantId/approve',
      permission: 'identity.role.grant', idempotent: true,
      reauth: { withinSeconds: 300, amr: ['mfa'] },
      handler: async (ctx) => {
        const grantId = (ctx.params['grantId'] ?? '').trim();
        const pending = (await deps.grantRequests(ctx.tenantId)).find((g) => g.grantId === grantId);
        if (pending === undefined) throw notFound(`grant request ${grantId}`);
        if (pending.state === 'granted') {
          return { status: 201, body: { granted: `already granted, approved by ${pending.decidedBy ?? 'a second person'}`, alreadyGranted: true } };
        }
        if (pending.state === 'rejected') {
          throw apiError(422, {
            code: 'grant_request_rejected',
            whatHappened: `Grant request ${grantId} was rejected${pending.decidedBy === undefined ? '' : ` by ${pending.decidedBy}`}; a rejected request is not revived.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Have the role requested again as a new request. Nothing changed.',
          });
        }
        // PA-12 round 10: judged again at APPROVAL — the user may have been granted something else since it was asked.
        if (deps.rolesHeldBy !== undefined) {
          const held = await deps.rolesHeldBy(ctx.tenantId, pending.userId);
          const mixed = machineIdentityGrantRefusal(pending.roleId, held, (await deps.isPerson?.(ctx.tenantId, pending.userId)) ?? false);
          if (mixed !== undefined) {
            throw apiError(422, { code: MACHINE_IDENTITY_REFUSAL_CODE, whatHappened: mixed, wasItSaved: 'not_saved', nextSafeAction: 'Reject this request; give the machine its own sign-in holding only its role. Nobody\'s access changed.' });
          }
          // OB-95: judged again at APPROVAL — the IT role and a business role, in either order, never meet on one person.
          const both = dutiesGrantRefusal(pending.roleId, held, await deps.roles(ctx.tenantId));
          if (both !== undefined) {
            throw apiError(422, { code: SEPARATION_OF_DUTIES_REFUSAL_CODE, whatHappened: both, wasItSaved: 'not_saved', nextSafeAction: 'Reject this request; give the IT work and the business work to two different people. Nobody\'s access changed.' });
          }
        }
        // Verifier r18 C2-R2: the SCOPE judged again at APPROVAL — a request made before round 18's checks (or a store closed
        // since) may name a store head office does not know, or one that is not plain text; approving it would add a ghost
        // store to the stores OB-82 counts and book a box's records there. Refused by name; nobody's access changes.
        const unboundNow = storeComputerGrantRefusal(pending.roleId, pending.branchScope);
        if (unboundNow !== undefined) {
          throw apiError(422, { code: 'store_computer_grant_must_name_one_store', whatHappened: unboundNow, wasItSaved: 'not_saved', nextSafeAction: 'Reject this request and request the store computer role for the box\'s own store only. Nobody\'s access changed.' });
        }
        if (pending.branchScope !== 'all' && deps.registeredStores !== undefined) {
          const ghost = firstUnknownStore(pending.branchScope, await deps.registeredStores(ctx.tenantId));
          if (ghost !== undefined) throw apiError(422, { ...unknownStoreWords(ghost, 'This pending request\'s branchScope'), nextSafeAction: 'Reject this request and ask for the role again naming a store head office has registered. Nobody\'s access changed.' });
        }
        // Round 14 (verifier G5): judged again at APPROVAL — the login may have become an outside party's since it was asked.
        const outside = outsidePartyGrantRefusal(pending.roleId, await deps.outsideLoginOf?.(ctx.tenantId, pending.userId));
        if (outside !== undefined) throw apiError(422, { code: OUTSIDE_LOGIN_REFUSAL_CODE, whatHappened: outside, wasItSaved: 'not_saved', nextSafeAction: 'Reject this request; a member of staff gets their own login. Nobody\'s access changed.' });
        const request: GrantRequest = {
          grantId, userId: pending.userId, roleId: pending.roleId, branchScope: pending.branchScope,
          requestedBy: pending.requestedBy, approvedBy: ctx.userId, requestedAt: pending.requestedAt,
        };
        const result = grantRole({
          request,
          roles: await deps.roles(ctx.tenantId),
          approverPermissions: await deps.permissionsOf(ctx.tenantId, ctx.userId),
        });
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nobody\'s access changed. The approver must be a different person from the requester and must already hold what is being granted.',
          });
        }
        await deps.recordGrant(ctx.tenantId, result.assignment!, request);
        // Seal the privilege change into the audit trail — who was given what, asked by whom, approved by whom (§28).
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'role.grant', objectType: 'user', objectId: request.userId,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: null,
          after: {
            roleId: request.roleId,
            branchScope: typeof request.branchScope === 'string' ? request.branchScope : request.branchScope.join(','),
            requestedBy: request.requestedBy,
            approvedBy: ctx.userId,
          },
          correlationId: grantId,
        });
        return { status: 201, body: { granted: result.detail } };
      },
    },
    {
      // Refuse a pending request under your own sign-in, with a reason. A rejection is a fact that stays, not a deletion.
      api: 'API-01', method: 'POST', path: '/v1/identity/grants/:grantId/reject',
      permission: 'identity.role.grant', idempotent: true,
      handler: async (ctx) => {
        const grantId = (ctx.params['grantId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'rejection_needs_reason', whatHappened: 'Rejecting a grant request needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Say why. Nothing changed.' });
        }
        const pending = (await deps.grantRequests(ctx.tenantId)).find((g) => g.grantId === grantId);
        if (pending === undefined) throw notFound(`grant request ${grantId}`);
        if (pending.state !== 'pending') return { status: 200, body: { grantId, state: pending.state, alreadyDecided: true } };
        await deps.recordGrantRejection(ctx.tenantId, { grantId, rejectedBy: ctx.userId, reason: b['reason'] as string, at: deps.now() });
        return { status: 200, body: { grantId, state: 'rejected', rejectedBy: ctx.userId } };
      },
    },
    {
      // What is waiting for a second person.
      api: 'API-01', method: 'GET', path: '/v1/identity/grants/pending',
      permission: 'identity.role.read',
      handler: async (ctx) => ({ status: 200, body: { requests: (await deps.grantRequests(ctx.tenantId)).filter((g) => g.state === 'pending') } }),
    },
    {
      // Allocate the next gap-free document number for a type (M01-FR-02). Idempotent: a retry under
      // the same key returns the SAME number (the kernel replays the stored response), so a dropped
      // connection never burns a number or hands out two. Gap-free/uniqueness is the store's job.
      // Revoke a token NOW, ahead of its expiry (GAP-SEC-05 · SEC-11): ONE token by its `jti`, or EVERY token of a
      // user issued at or before a moment (`userId` + optional `issuedBefore`, default now) — the stolen-token,
      // laptop-left-open, leaver and rotated-credential cases. Append-only (hard rule #2/#6): a revocation is a fact
      // that is added, never edited away. The acting user is the caller, never client-supplied.
      api: 'API-01', method: 'POST', path: '/v1/identity/token-revocations',
      permission: 'identity.session.revoke', idempotent: true,
      handler: async (ctx) => {
        if (deps.revocations === undefined) throw noRevocationStore();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const hasJti = isStr(b['jti']); const hasUser = isStr(b['userId']);
        if (hasJti === hasUser) {
          throw apiError(400, {
            code: 'revocation_needs_one_target',
            whatHappened: 'A revocation names exactly ONE target: a token id (jti) or a user (userId).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { jti, reason } to cut off one token, or { userId, reason, issuedBefore? } to cut off every token that user was issued up to a moment. Nothing was revoked.',
          });
        }
        if (!REVOCATION_REASONS.includes(b['reason'] as RevocationReason)) {
          throw apiError(400, {
            code: 'revocation_needs_reason',
            whatHappened: `A revocation needs a reason, one of: ${REVOCATION_REASONS.join(', ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the reason. Nothing was revoked.',
          });
        }
        const nowIso = deps.now();
        let issuedBefore: number | undefined;
        if (hasUser) {
          const raw = b['issuedBefore'];
          const ms = raw === undefined ? Date.parse(nowIso) : (typeof raw === 'string' ? Date.parse(raw) : Number.NaN);
          if (!Number.isFinite(ms)) {
            throw apiError(400, { code: 'revocation_issued_before_unreadable', whatHappened: 'issuedBefore must be an ISO-8601 moment (or omitted for now).', wasItSaved: 'not_saved', nextSafeAction: 'Send issuedBefore as an ISO-8601 timestamp, or leave it out. Nothing was revoked.' });
          }
          issuedBefore = Math.floor(ms / 1000);
        }
        const revocation: TokenRevocation = {
          id: `rev-${hasJti ? `jti-${b['jti'] as string}` : `user-${b['userId'] as string}-${issuedBefore}`}`,
          tenantId: ctx.tenantId,
          ...(hasJti ? { jti: b['jti'] as string } : {}),
          ...(hasUser ? { userId: b['userId'] as string, issuedBefore: issuedBefore! } : {}),
          reason: b['reason'] as RevocationReason,
          revokedBy: ctx.userId,
          revokedAt: nowIso,
        };
        await deps.revocations.revoke(ctx.tenantId, revocation);
        return { status: 201, body: { revocation } };
      },
    },
    {
      // What this tenant has revoked — the auditor's read (who cut whom off, when, why).
      api: 'API-01', method: 'GET', path: '/v1/identity/token-revocations',
      permission: 'identity.session.revoke',
      handler: async (ctx) => {
        if (deps.revocations === undefined) throw noRevocationStore();
        return { status: 200, body: { revocations: await deps.revocations.list(ctx.tenantId) } };
      },
    },
    {
      api: 'API-01', method: 'POST', path: '/v1/identity/number-series/:docType',
      permission: 'documents.number.allocate', idempotent: true,
      handler: async (ctx) => {
        const docType = ctx.params['docType'] ?? '';
        const format = NUMBER_FORMATS[docType];
        if (format === undefined) {
          throw apiError(404, {
            code: 'unknown_document_type',
            whatHappened: `There is no number series for document type '${docType}'.`,
            wasItSaved: 'not_saved',
            nextSafeAction: `Use one of: ${Object.keys(NUMBER_FORMATS).join(', ')}. Nothing was allocated.`,
          });
        }
        const seq = await deps.allocateNumber(ctx.tenantId, docType);
        return { status: 201, body: { docType, seq, formatted: formatNumber(format, seq) } };
      },
    },
  ];
}
