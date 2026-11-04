// API-01 The chartered accountant's role — a NAMED grant path (owner decision OB-681, 3 Nov 2026 · OB-143 · §28 · P-04).
//
// The CA role carries three settings permissions the owner does not hold (`finance.rcm.configure`, `finance.tds.configure`,
// `privacy.volume.threshold.set` — OB-143 "A": the CA alone fills those lists; C9 · OB-324: the CA sets the volume
// threshold). The ordinary grant route rightly refuses an approver who does not hold what a role grants
// (`escalates_beyond_the_approver`), so nobody could ever give the role on the real cloud. The owner chose a NAMED, NARROW
// path, like the Internal Committee's (committee-membership.ts):
//
//   • the OWNER asks (`identity.ca.grant.request`, held by the owner role alone) to give a named person the
//     `chartered_accountant` role — that role ONLY; this route gives nothing else and takes nothing away;
//   • the IT CUSTODIAN approves it as the second, different person: the security reviewer named NOW under OB-330 / OB-405
//     (Mr Sivakumar, who holds the Security reviewer role and not the IT administrator login — OB-419), in his own session,
//     through head office's maker-checker engine (kind `ca_role_grant`, `decidedOnlyBy: security_reviewer`);
//   • the person given the role is never the owner who asks nor the custodian who approves, and never holds the owner role
//     — so the owner still does NOT gain those three permissions;
//   • the usual grant rules still run: a machine identity, an outside party's login, or the IT role beside it are refused;
//   • the grant is on the identity ledger (who asked, who approved, why) and sealed on the domain audit trail (`role.grant`).

import type { Route } from '../../kernel/src/index';
import { apiError, requireActorIsCaller } from '../../kernel/src/index';
import type { Role } from '../../../packages/rbac/src/rbac';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from './approval-requests';
import { machineIdentityGrantRefusal, MACHINE_IDENTITY_REFUSAL_CODE } from './machine-identities';
import { outsidePartyGrantRefusal, OUTSIDE_LOGIN_REFUSAL_CODE } from './outside-party-logins';
import { dutiesGrantRefusal, SEPARATION_OF_DUTIES_REFUSAL_CODE } from './separation-of-duties';

/** The role this path gives (mirrors services/api/src/roles.ts). */
export const CA_ROLE_ID = 'chartered_accountant';
/** The approval kind the owner asks and the custodian decides. */
export const CA_GRANT_KIND = 'ca_role_grant';
/** The permission the asker must hold — the owner role's alone. */
export const CA_GRANT_PERMISSION = 'identity.ca.grant.request';
/** The custodian's role (OB-405 · OB-419: the named security reviewer). */
export const CA_GRANT_CONFIRMER_ROLE = 'security_reviewer';
const OWNER_ROLE = 'owner';

/** One applied grant — what the adapter records on the identity ledger. */
export interface CaRoleGrant {
  readonly changeId: string;
  readonly userId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly at: string;
}

type Refusal = { readonly code: string; readonly why: string } | undefined;

/** OB-681, before any approval: only the owner asks, never for himself, and never for anyone holding the owner role. */
export function caGrantSubjectRefusal(input: { readonly askerRoles: readonly string[]; readonly asker: string; readonly subject: string; readonly subjectRoles: readonly string[] }): Refusal {
  if (!input.askerRoles.includes(OWNER_ROLE)) return { code: 'only_the_owner_asks_for_the_ca_role', why: `${input.asker} does not hold the owner role. Only the owner asks to give the chartered accountant's role (owner decision OB-681).` };
  if (input.subject === input.asker) return { code: 'granting_to_yourself', why: `${input.asker} cannot give the chartered accountant's role to themselves — the owner never gains its permissions (OB-681).` };
  if (input.subjectRoles.includes(OWNER_ROLE)) return { code: 'owner_never_holds_the_ca_role', why: `${input.subject} holds the owner role. The owner never holds the chartered accountant's role, so the owner never gains its settings permissions (OB-681, OB-143).` };
  return undefined;
}

/** OB-681, the second person: the IT custodian named NOW (the security reviewer, OB-405), never the asker or the subject. */
export function caGrantApproverRefusal(input: { readonly asker: string; readonly subject: string; readonly approver: string; readonly approverRoles: readonly string[]; readonly namedCustodian: string | undefined }): Refusal {
  if (input.namedCustodian === undefined) return { code: 'name_the_security_reviewer_first', why: 'Nobody is named as the security reviewer (OB-330), so there is no IT custodian to approve the chartered accountant\'s role (OB-681).' };
  if (input.approver === input.asker) return { code: 'approved_by_the_requester', why: `${input.asker} both asked and approved this. The IT custodian approves it as a different person (OB-681).` };
  if (input.approver === input.subject) return { code: 'ca_grant_approved_by_its_subject', why: `${input.subject} is the person receiving the role and cannot also approve it.` };
  if (input.approver !== input.namedCustodian || !input.approverRoles.includes(CA_GRANT_CONFIRMER_ROLE)) {
    return { code: 'ca_grant_needs_the_it_custodian', why: `${input.approver} approved this but is not the IT custodian: only the named security reviewer (${input.namedCustodian}), holding the security reviewer role, approves the chartered accountant's role (OB-681, OB-405).` };
  }
  return undefined;
}

/** The whole rule (OB-681). undefined = the grant may go ahead. */
export function caRoleGrantRefusal(input: Parameters<typeof caGrantSubjectRefusal>[0] & Omit<Parameters<typeof caGrantApproverRefusal>[0], 'asker' | 'subject'>): Refusal {
  return caGrantSubjectRefusal(input) ?? caGrantApproverRefusal(input);
}

export interface CaRoleGrantDeps {
  readonly now: () => string;
  readonly rolesHeldBy: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  readonly roles: (tenantId: string) => Promise<readonly Role[]> | readonly Role[];
  readonly isPerson?: (tenantId: string, userId: string) => Promise<boolean> | boolean;
  readonly outsideLoginOf?: (tenantId: string, userId: string) => Promise<string | undefined> | string | undefined;
  /** The security reviewer named NOW (OB-330) — the same register the floor-device switch and the risk acceptance read. */
  readonly securityReviewer: (tenantId: string) => Promise<{ readonly userId: string; readonly displayName: string } | undefined>;
  /** Append the grant (a `RoleGranted`), idempotent on the change id. */
  readonly recordGrant: (tenantId: string, grant: CaRoleGrant) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly approvals?: ApprovalPort;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) => apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function caRoleGrantRoutes(deps: CaRoleGrantDeps): readonly Route[] {
  return [
    {
      // Body: { userId, reason, approvalId }. The owner is the maker; the approval is the named IT custodian's of exactly
      // this grant (kind ca_role_grant, subjectRef = the change id).
      api: 'API-01', method: 'POST', path: '/v1/identity/chartered-accountant/grants/:changeId',
      permission: CA_GRANT_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const changeId = (ctx.params['changeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        requireActorIsCaller(ctx, b, 'requestedBy');
        if (b['roleId'] !== undefined && b['roleId'] !== CA_ROLE_ID) {
          throw refuse(422, 'only_the_ca_role_here', `This path gives the chartered accountant's role only; it never gives "${String(b['roleId'])}".`, 'Use the grant route for any other role. Nobody\'s access changed.');
        }
        if (changeId === '' || !isStr(b['userId']) || !isStr(b['reason'])) {
          throw refuse(400, 'not_readable_as_a_ca_grant', 'Giving the chartered accountant\'s role needs a change id in the path and { userId, reason, approvalId } in the body. Who asks is taken from your sign-in.', 'Say who receives the role, and why. Nobody\'s access changed.');
        }
        const userId = (b['userId'] as string).trim();
        const askerRoles = await deps.rolesHeldBy(ctx.tenantId, ctx.userId);
        const held = await deps.rolesHeldBy(ctx.tenantId, userId);
        // Before any approval: the asker and the person receiving it (approver checks follow the approval).
        const early = caGrantSubjectRefusal({ askerRoles, asker: ctx.userId, subject: userId, subjectRoles: held });
        if (early !== undefined) throw refuse(422, early.code, early.why, 'Nobody\'s access changed.');
        if (held.includes(CA_ROLE_ID)) return { status: 200, body: { changeId, userId, roleId: CA_ROLE_ID, alreadyHeld: true } };
        const mixed = machineIdentityGrantRefusal(CA_ROLE_ID, held, (await deps.isPerson?.(ctx.tenantId, userId)) ?? false);
        if (mixed !== undefined) throw refuse(422, MACHINE_IDENTITY_REFUSAL_CODE, mixed, 'The chartered accountant signs in as a person on their own login. Nobody\'s access changed.');
        const both = dutiesGrantRefusal(CA_ROLE_ID, held, await deps.roles(ctx.tenantId));
        if (both !== undefined) throw refuse(422, SEPARATION_OF_DUTIES_REFUSAL_CODE, both, 'Choose a person who does not hold the IT role. Nobody\'s access changed.');
        const outside = outsidePartyGrantRefusal(CA_ROLE_ID, await deps.outsideLoginOf?.(ctx.tenantId, userId));
        if (outside !== undefined) throw refuse(422, OUTSIDE_LOGIN_REFUSAL_CODE, outside, 'The chartered accountant gets their own login. Nobody\'s access changed.');
        const custodian = await deps.securityReviewer(ctx.tenantId);
        if (custodian === undefined) throw refuse(422, 'name_the_security_reviewer_first', 'Nobody is named as the security reviewer (OB-330), so there is no IT custodian to approve the chartered accountant\'s role (OB-681).', 'The owner names the security reviewer on the Risk acceptance page first. Nobody\'s access changed.');
        const at = deps.now();
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: CA_GRANT_KIND, subjectRef: changeId, details: actionDetails(ctx.body, { changeId }), valueMinor: null,
          maker: ctx.userId, usedBy: `ca-role-grant:${changeId}`, now: at,
        });
        if (opened === undefined) {
          throw refuse(422, 'ca_grant_needs_the_it_custodian', `Giving the chartered accountant's role applies only once the IT custodian, ${custodian.displayName}, has approved exactly this grant in their own session (owner decision OB-681).`, `Ask for approval (POST /v1/approvals/requests, kind ${CA_GRANT_KIND}, subjectRef ${changeId}, with exactly this grant); once ${custodian.displayName} approves it, send it again with the approvalId. Nobody's access changed.`);
        }
        const approvedBy = opened.decision.decidedBy;
        const no = caGrantApproverRefusal({ asker: ctx.userId, subject: userId, approver: approvedBy, approverRoles: await deps.rolesHeldBy(ctx.tenantId, approvedBy), namedCustodian: custodian.userId });
        if (no !== undefined) throw refuse(422, no.code, no.why, 'Ask the named IT custodian to approve exactly this grant in their own session. Nobody\'s access changed; the approval was not used.');
        await opened.spend();
        const reason = (b['reason'] as string).trim();
        await deps.recordGrant(ctx.tenantId, { changeId, userId, requestedBy: ctx.userId, approvedBy, reason, at });
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'role.grant', objectType: 'user', objectId: userId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { charteredAccountant: 'false' },
          after: { roleId: CA_ROLE_ID, branchScope: 'all', requestedBy: ctx.userId, approvedBy, reason, decision: 'OB-681' },
          correlationId: changeId,
        });
        return { status: 201, body: { changeId, userId, roleId: CA_ROLE_ID, branchScope: 'all', requestedBy: ctx.userId, approvedBy } };
      },
    },
  ];
}
