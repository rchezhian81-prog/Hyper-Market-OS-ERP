// API-01 Internal Committee membership (R2 addendum C20 · owner decision OB-165 "A", 16 Oct 2026, in writing · verifier
// lanes34 NEW-6 · §28 · P-04).
//
// The POSH Act Internal Committee must stay staffed: a member leaves, another joins. Before this, nobody could add one —
// the grant route rightly refuses an approver who does not hold what a role grants (`escalates_beyond_the_approver`),
// and only the committee holds `posh.*`. The owner chose a NAMED, NARROW exception:
//
//   • the OWNER (`posh.committee.manage`, held by the owner role alone) may add a person to, or remove a person from, the
//     `internal_committee` role — that role ONLY; this route grants and revokes nothing else;
//   • a SECOND PERSON confirms, through head office's maker-checker engine (ADR-0024): the owner asks for approval of
//     exactly this change (kind `posh_committee_change`), a different person who takes part in access changes
//     (`identity.role.request`) approves it in their own session, and only then does the owner's change apply — once.
//     OB-167 "A": that second person is a STORE MANAGER (holds the store_manager role now). Verifier r2final NEW-5: the
//     person joining or leaving is NEVER the one who confirms it — elevated access never approves its own (§28);
//   • the act is AUDITED on the domain trail (`role.grant` / `role.revoke`, object `user`, naming the role, who asked and
//     who confirmed) — it is an access change the owner sees, not a committee record;
//   • the owner can NEVER hold the role: the change is refused for anyone who holds the owner role, and everywhere else a
//     role is given (the grant route, emergency access, a joiner/mover change) the owner role and the committee role are
//     never put on one person (`ownerAndCommitteeRefusal`);
//   • OB-157 stands: holding `posh.committee.manage` reads no complaint — the owner sees counts and the filing reminder only.
//
// The usual grant rules still run on an addition: a machine identity is never a member, an outside party's login is never
// one, and the IT/platform role is never put beside a business role (OB-95).

import type { Route } from '../../kernel/src/index';
import { apiError, requireActorIsCaller } from '../../kernel/src/index';
import type { Role } from '../../../packages/rbac/src/rbac';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from './approval-requests';
import { machineIdentityGrantRefusal, MACHINE_IDENTITY_REFUSAL_CODE } from './machine-identities';
import { outsidePartyGrantRefusal, OUTSIDE_LOGIN_REFUSAL_CODE } from './outside-party-logins';
import { dutiesGrantRefusal, SEPARATION_OF_DUTIES_REFUSAL_CODE } from './separation-of-duties';

/** The POSH Act Internal Committee role (mirrors services/api/src/roles.ts INTERNAL_COMMITTEE_ROLE_ID). */
export const COMMITTEE_ROLE_ID = 'internal_committee';
/** The owner role (mirrors services/api/src/roles.ts OWNER_ROLE_ID). */
export const OWNER_ROLE = 'owner';
/** OB-167 "A": the role of the person who confirms a committee change (mirrors services/api/src/roles.ts STORE_MANAGER_ROLE_ID). */
export const COMMITTEE_CHANGE_CONFIRMER_ROLE = 'store_manager';
/** The code every "owner and committee on one person" refusal carries. */
export const OWNER_ON_COMMITTEE_REFUSAL_CODE = 'owner_never_on_the_internal_committee';

/**
 * OB-165: the owner never holds the committee role. A set of roles one person would hold: refused (the words) when it
 * holds both. undefined = acceptable.
 */
export function ownerAndCommitteeRefusal(roleIds: readonly string[]): string | undefined {
  return roleIds.includes(OWNER_ROLE) && roleIds.includes(COMMITTEE_ROLE_ID)
    ? 'The owner never sits on the Internal Committee (owner decision OB-165): the committee holds the confidential complaints register, and the owner sees only its counts and the filing reminder. Nobody holds the owner role and the Internal Committee role together.'
    : undefined;
}

export type CommitteeAction = 'add' | 'remove';

/** One applied change to the committee — what the adapter records on the identity ledger. */
export interface CommitteeChange {
  readonly changeId: string;
  readonly action: CommitteeAction;
  readonly userId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly at: string;
  /** For a removal: every committee grant the person holds (each scope), all revoked in one batch. */
  readonly revokes: readonly { readonly branchScope: readonly string[] | 'all' }[];
}

export interface CommitteeMembershipDeps {
  readonly now: () => string;
  /** The roles a user holds now — the ledger's grants plus any live emergency grant. */
  readonly rolesHeldBy: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  /** The committee grants a user holds on the ledger (the scopes a removal revokes). */
  readonly committeeGrantsOf: (tenantId: string, userId: string) => Promise<readonly { readonly branchScope: readonly string[] | 'all' }[]>;
  readonly roles: (tenantId: string) => Promise<readonly Role[]> | readonly Role[];
  readonly isPerson?: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  readonly outsideLoginOf?: (tenantId: string, userId: string) => Promise<string | undefined> | string | undefined;
  /** Append the change — a `RoleGranted`, or a `RoleRevoked` per committee grant — as ONE batch, idempotent on the change id. */
  readonly recordChange: (tenantId: string, change: CommitteeChange) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /** Head office's maker-checker engine; absent on a bare stub (then nothing is ever approved, and nothing changes). */
  readonly approvals?: ApprovalPort;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function committeeMembershipRoutes(deps: CommitteeMembershipDeps): readonly Route[] {
  return [
    {
      // Body: { action: 'add' | 'remove', userId, reason, approvalId }. The caller (the owner) is the maker; the approval
      // names a second person's confirmation of exactly this change. Sensitive: a recent MFA re-authentication.
      api: 'API-01', method: 'POST', path: '/v1/identity/internal-committee/changes/:changeId',
      permission: 'posh.committee.manage', idempotent: true,
      reauth: { withinSeconds: 300, amr: ['mfa'] },
      handler: async (ctx) => {
        const changeId = (ctx.params['changeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'requestedBy');
        if (b['roleId'] !== undefined && b['roleId'] !== COMMITTEE_ROLE_ID) {
          throw refuse(422, 'only_the_internal_committee_role_here', `This route changes the Internal Committee only; it never gives or takes "${String(b['roleId'])}".`, 'Use the grant route for any other role. Nobody\'s access changed.');
        }
        const action = b['action'];
        if (changeId === '' || (action !== 'add' && action !== 'remove') || !isStr(b['userId']) || !isStr(b['reason'])) {
          throw refuse(400, 'not_readable_as_a_committee_change', 'A committee change needs a changeId in the path and { action: add or remove, userId, reason, approvalId } in the body. Who asks is taken from your sign-in.', 'Say who joins or leaves the Internal Committee, and why. Nobody\'s access changed.');
        }
        const userId = (b['userId'] as string).trim();
        if (userId === ctx.userId) {
          throw refuse(422, OWNER_ON_COMMITTEE_REFUSAL_CODE, `${ctx.userId} cannot change their own committee membership. ${ownerAndCommitteeRefusal([OWNER_ROLE, COMMITTEE_ROLE_ID])}`, 'Name the member of staff who joins or leaves. Nobody\'s access changed.');
        }
        const held = await deps.rolesHeldBy(ctx.tenantId, userId);
        const isMember = held.includes(COMMITTEE_ROLE_ID);
        if (action === 'add') {
          const owner = ownerAndCommitteeRefusal([...held, COMMITTEE_ROLE_ID]);
          if (owner !== undefined) throw refuse(422, OWNER_ON_COMMITTEE_REFUSAL_CODE, owner, 'Choose a member of staff who is not the owner. Nobody\'s access changed.');
          if (isMember) return { status: 200, body: { changeId, userId, action, alreadyMember: true } };
          const mixed = machineIdentityGrantRefusal(COMMITTEE_ROLE_ID, held, (await deps.isPerson?.(ctx.tenantId, userId)) ?? false);
          if (mixed !== undefined) throw refuse(422, MACHINE_IDENTITY_REFUSAL_CODE, mixed, 'A committee member is a person on their own sign-in. Nobody\'s access changed.');
          const both = dutiesGrantRefusal(COMMITTEE_ROLE_ID, held, await deps.roles(ctx.tenantId));
          if (both !== undefined) throw refuse(422, SEPARATION_OF_DUTIES_REFUSAL_CODE, both, 'Choose a member of staff who does not hold the IT role. Nobody\'s access changed.');
          const outside = outsidePartyGrantRefusal(COMMITTEE_ROLE_ID, await deps.outsideLoginOf?.(ctx.tenantId, userId));
          if (outside !== undefined) throw refuse(422, OUTSIDE_LOGIN_REFUSAL_CODE, outside, 'A committee member is a member of staff on their own login. Nobody\'s access changed.');
        } else if (!isMember) {
          return { status: 200, body: { changeId, userId, action, notAMember: true } };
        }
        const at = deps.now();
        // The second person's confirmation, given in their own session for exactly this change. A typed approver is refused.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'posh_committee_change', subjectRef: changeId, details: actionDetails(ctx.body, { changeId }), valueMinor: null,
          maker: ctx.userId, usedBy: `committee-change:${changeId}`, now: at,
        });
        if (opened === undefined) {
          throw refuse(422, 'committee_change_needs_a_second_person', 'Adding or removing an Internal Committee member applies only once a second person has confirmed exactly this change in their own session (owner decision OB-165).', 'Ask for approval (POST /v1/approvals/requests, kind posh_committee_change, with exactly this change); once a second person approves it, send it again with the approvalId. Nobody\'s access changed.');
        }
        const approvedBy = opened.decision.decidedBy;
        // NEW-5: the person joining or leaving never confirms their own change (§28: access never approves its own).
        if (approvedBy === userId) {
          throw refuse(422, 'committee_change_confirmed_by_its_subject', `${userId} is the person ${action === 'add' ? 'joining' : 'leaving'} the Internal Committee and cannot also be the second person who confirms it.`, 'Ask a different store manager to confirm exactly this change in their own session. Nobody\'s access changed.');
        }
        // OB-167 "A": the second person is a store manager.
        if (!(await deps.rolesHeldBy(ctx.tenantId, approvedBy)).includes(COMMITTEE_CHANGE_CONFIRMER_ROLE)) {
          throw refuse(422, 'committee_change_needs_a_store_manager', `${approvedBy} confirmed this change but does not hold the store manager role. An Internal Committee change is confirmed by a store manager (owner decision OB-167).`, 'Ask a store manager to confirm exactly this change in their own session. Nobody\'s access changed.');
        }
        const revokes = action === 'remove' ? await deps.committeeGrantsOf(ctx.tenantId, userId) : [];
        await opened.spend();
        const reason = (b['reason'] as string).trim();
        await deps.recordChange(ctx.tenantId, { changeId, action, userId, requestedBy: ctx.userId, approvedBy, reason, at, revokes });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: action === 'add' ? 'role.grant' : 'role.revoke', objectType: 'user', objectId: userId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { internalCommittee: String(isMember) },
          after: { roleId: COMMITTEE_ROLE_ID, internalCommittee: String(action === 'add'), requestedBy: ctx.userId, approvedBy, reason },
          correlationId: changeId,
        });
        return { status: 201, body: { changeId, userId, action, roleId: COMMITTEE_ROLE_ID, requestedBy: ctx.userId, approvedBy } };
      },
    },
  ];
}
