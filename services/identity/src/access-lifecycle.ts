// API-01 Joiner / mover / leaver access lifecycle (M02-FR-04 · SEC-11 · P-04 · §28 · Wave 2b · audit PA-02) — the
// command that keeps access tracking employment reality. The gap between what someone can do and what their job
// is, is where fraud lives, and two failures cause most of it — both closed here as rules, not reminders:
//
//   • THE MOVER WHO ACCUMULATES. Someone transfers from the Fresh counter to the cash office and keeps both;
//     six months on they can raise a stock adjustment AND settle the till it hides in. Nobody granted that
//     combination — it assembled itself. So a move REPLACES scope; the old roles/branches are removed in the
//     same act, and their sessions close so the new scope takes effect now.
//   • THE LEAVER WHO LINGERS. The account is disabled "later", the sessions stay open, and the items they
//     owned belong to nobody. So a leaver's OWNED OPEN ITEMS MUST BE REASSIGNED FIRST — a leaver whose work
//     has no new owner is not finished, it is abandoned — and the revocation is a PRIORITY sync item (§31).
//
// The rule is the tested `applyLifecycle` in `@sre/identity` (the services-run-on-their-tested-engine guardrail):
// it decides, and THIS ROUTE APPLIES. The audit (PA-02) found the earlier version reported `applied: true` with
// `grants: []` and `closeSessions: true` while nothing changed: the current grants came from the request body, no
// event was appended, no session was closed, and the leaver's next request was still 200. Now:
//   - what the person holds is READ FROM THE LEDGER (a body that carries `currentGrants` is refused by name);
//   - an applied change is ONE batch of `RoleRevoked` / `RoleGranted` events every reader of authority folds;
//   - a change that closes sessions revokes every token of the person issued up to this moment, through the
//     same revocation list the authenticator consults — the very next request with the old token is 401;
//   - the approver can grant no role whose permissions they do not themselves hold (the grant route's rule —
//     otherwise this route was the way round it);
//   - nothing is recorded while the decision is blocked, and nothing is recorded if the session cannot be cut.
// The authenticated caller is the APPROVER and can never be the person who requested the change (§28).

import type { Route } from '../../kernel/src/index';
import { apiError, requireActorIsCaller } from '../../kernel/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from './approval-requests';
import {
  applyLifecycle, SelfServiceAccessError,
  type LifecycleEvent, type AccessGrant, type LifecycleRequest, type LifecycleApproval, type OwnedItem, type LifecycleResult,
} from '../../../packages/identity/src/index';
import type { Permission, Role } from '../../../packages/rbac/src/rbac';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { TokenRevocation } from './revocation';

const EVENTS: readonly LifecycleEvent[] = ['joiner', 'mover', 'leaver'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** 'all' or a list of branch ids. */
const readScope = (v: unknown): readonly string[] | 'all' | undefined =>
  v === 'all' ? 'all' : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

/** Validate one caller-supplied TARGET grant (what a joiner/mover should hold afterwards), or return undefined. */
function readGrant(v: unknown): AccessGrant | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const g = v as Record<string, unknown>;
  const scope = readScope(g['branchScope']);
  if (!isStr(g['userId']) || !isStr(g['roleId']) || scope === undefined) return undefined;
  return { userId: g['userId'], roleId: g['roleId'], branchScope: scope };
}

function readGrants(v: unknown): readonly AccessGrant[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: AccessGrant[] = [];
  for (const raw of v) {
    const g = readGrant(raw);
    if (g === undefined) return undefined;
    out.push(g);
  }
  return out;
}

/** Validate the caller-supplied owned open items (checked for a leaver). */
function readOwnedItems(v: unknown): readonly OwnedItem[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: OwnedItem[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const i = raw as Record<string, unknown>;
    if (!isStr(i['itemId']) || !isStr(i['kind']) || typeof i['description'] !== 'string') return undefined;
    out.push({ itemId: i['itemId'], kind: i['kind'], description: i['description'] });
  }
  return out;
}

/** One grant's identity: who, which role, which scope. */
const grantKey = (g: AccessGrant): string =>
  `${g.userId}\u0000${g.roleId}\u0000${g.branchScope === 'all' ? 'all' : [...g.branchScope].sort().join(',')}`;

/** What an applied lifecycle decision changes on the ledger — recorded as ONE batch by the adapter. */
export interface LifecycleChange {
  readonly requestId: string;
  readonly event: LifecycleEvent;
  readonly userId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly reason: string;
  /** Grants the person holds afterwards that they did not hold before. */
  readonly added: readonly AccessGrant[];
  /** Grants taken away. */
  readonly removed: readonly AccessGrant[];
}

export interface AccessLifecycleDeps {
  readonly now: () => string;
  /** The role catalogue — a target role must exist in it, and the approver must hold what it grants. */
  readonly roles: (tenantId: string) => Promise<readonly Role[]> | readonly Role[];
  /** What the person holds NOW, from the ledger (grants minus revocations) — never from the request. */
  readonly currentGrants: (tenantId: string, userId: string) => Promise<readonly AccessGrant[]> | readonly AccessGrant[];
  /** The permissions a user genuinely holds — the approver's, for the no-escalation rule. */
  readonly permissionsOf: (tenantId: string, userId: string) => Promise<readonly Permission[]> | readonly Permission[];
  /** Append the change — every grant added and every grant removed — as one batch. */
  readonly recordChange: (tenantId: string, change: LifecycleChange) => Promise<void> | void;
  /**
   * The token revocation list the authenticator consults (GAP-SEC-05). A change that closes sessions revokes every
   * token the person was issued up to this moment THROUGH it, so the next request with the old token is refused.
   * Optional on a bare stub; a deployment without it refuses to apply a session-closing change (503, nothing saved).
   */
  readonly revocations?: {
    readonly revoke: (tenantId: string, revocation: TokenRevocation) => Promise<void> | void;
  };
  /** Seal the access change into the domain audit trail (M34-FR-01), attributed to the approver. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /**
   * The person's sign-in at the identity server (OB-15-c). A leaver's is switched OFF and their open sessions there
   * ended BEFORE anything is recorded — so they cannot sign in again for a fresh token — and when the identity server
   * cannot be reached, nothing changes (503). Absent: this deployment signs nobody in through the identity server.
   */
  readonly signIns?: {
    readonly end: (tenantId: string, userId: string, endedBy: string, at: string) => Promise<'ended' | 'none' | 'not_connected'>;
  };
  /** Head office's maker-checker engine (ADR-0024): the approver approved this change in their own session. Optional
   *  on a bare stub (then every approval is unknown, and nothing changes); the running system provides it. */
  readonly approvals?: ApprovalPort;
}

/** The route's answer: the engine's decision plus what was actually done about it. */
export interface LifecycleOutcome extends LifecycleResult {
  /** True when the grants and revocations were appended to the ledger. False while blocked. */
  readonly recorded: boolean;
  /** True when every token of the person issued up to this moment was revoked. */
  readonly sessionsClosed: boolean;
  /** A leaver's sign-in at the identity server: switched off, none there, or no identity server connected. */
  readonly signIn?: 'ended' | 'none' | 'not_connected';
}

export function accessLifecycleRoutes(deps: AccessLifecycleDeps): readonly Route[] {
  return [
    {
      // Apply a joiner / mover / leaver. Body: { event, userId, reason, grants? (target, for joiner/mover),
      // ownedOpenItems? (checked for a leaver), approvalId }. The AUTHENTICATED CALLER is the requester (M02-FR-04
      // "Store/HR manager (request/confirm)"); the approver is an approval given in their own session for exactly this
      // change (kind `access_change`, `identity.role.grant` — never the requester, §28). Before 2b-vi-c-2 the approver
      // called this route and TYPED who had asked. What the person holds now is read from the ledger — a body that
      // tries to supply it is refused by name. Returns the decision, what was recorded, and whether sessions were closed.
      api: 'API-01', method: 'POST', path: '/v1/access/lifecycle/:requestId',
      permission: 'identity.role.request', idempotent: true,
      handler: async (ctx) => {
        const requestId = (ctx.params['requestId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['currentGrants'] !== undefined) {
          throw apiError(400, {
            code: 'current_grants_are_the_servers',
            whatHappened: 'What a person holds today is read from the ledger, never from the request (audit PA-02) — a body that carries currentGrants is refused.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the change without currentGrants; the server reads the current grants itself. Nothing changed.',
          });
        }
        const grants = readGrants(b['grants']);
        const ownedOpenItems = readOwnedItems(b['ownedOpenItems']);
        if (requestId === '' || !EVENTS.includes(b['event'] as LifecycleEvent) || !isStr(b['userId'])
          || !isStr(b['reason']) || grants === undefined || ownedOpenItems === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_lifecycle_change',
            whatHappened: 'A lifecycle change needs a requestId in the path and { event (joiner/mover/leaver), userId, reason, grants? (target for joiner/mover: [{userId,roleId,branchScope}]), ownedOpenItems?, approvalId }. Who asks is taken from your sign-in.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'For a joiner or mover say the access they should hold AFTER; for a leaver, list any open items they own so they can be reassigned first.',
          });
        }
        const userId = b['userId'] as string;
        // Who asks is the signed-in caller — a body naming anyone else is refused by name (audit PA-03).
        requireActorIsCaller(ctx, b, 'requestedBy');
        const requestedBy = ctx.userId;
        const at = deps.now();
        // The approver's own act: an approval given in their own session for exactly this change. A typed approver is
        // refused by name; no approval at all changes nobody's access.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'access_change', subjectRef: requestId, details: actionDetails(ctx.body, { requestId }), valueMinor: null,
          maker: ctx.userId, usedBy: `access-change:${requestId}`, now: at,
        });
        if (opened === undefined) {
          throw apiError(422, {
            code: 'access_change_needs_approval',
            whatHappened: 'A joiner, mover or leaver change is applied only with an approval a second person gave in their own session for exactly this change (M02-FR-04, §28).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask for approval (POST /v1/approvals/requests, kind access_change, with exactly this change); once the owner approves it, send it again with the approvalId. Nobody\'s access changed.',
          });
        }
        const approvedBy = opened.decision.decidedBy;
        const request: LifecycleRequest = {
          requestId, event: b['event'] as LifecycleEvent, userId, requestedBy, reason: b['reason'] as string, at,
          ...(grants.length > 0 ? { grants } : {}),
        };
        // What the person holds NOW — the ledger's answer, folded grants minus revocations.
        const currentGrants = await deps.currentGrants(ctx.tenantId, userId);
        // The engine still refuses a self-approval (§28).
        const approval: LifecycleApproval = { subjectRef: requestId, status: 'approved', decidedBy: approvedBy };
        let result: LifecycleResult;
        try {
          result = applyLifecycle({ request, currentGrants, approval, ownedOpenItems });
        } catch (e) {
          if (e instanceof SelfServiceAccessError) {
            throw apiError(422, {
              code: 'self_service_access_refused',
              whatHappened: 'The person who requested the access change cannot be the one who approves it (§28) — access changes need a second person.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Have someone other than the requester approve this change.',
            });
          }
          throw e;
        }
        if (!result.applied) {
          // Blocked: the decision says why; nothing is recorded, nobody's access moved.
          const outcome: LifecycleOutcome = { ...result, recorded: false, sessionsClosed: false };
          return { status: 200, body: outcome };
        }

        const currentKeys = new Set(currentGrants.map(grantKey));
        const added = result.grants.filter((g) => !currentKeys.has(grantKey(g)));
        const removed = result.removed;

        // The grant route's rule, here too: the approver cannot hand out a permission they do not hold themselves —
        // otherwise a lifecycle change was the way to create an administrator past every other limit.
        if (added.length > 0) {
          const roles = await deps.roles(ctx.tenantId);
          const approverPermissions = await deps.permissionsOf(ctx.tenantId, approvedBy);
          for (const g of added) {
            const role = roles.find((r) => r.id === g.roleId);
            if (role === undefined) {
              throw apiError(422, {
                code: 'unknown_role',
                whatHappened: `There is no role "${g.roleId}" in this product's catalogue.`,
                wasItSaved: 'not_saved',
                nextSafeAction: 'Name a role from the catalogue (GET /v1/identity/roles). Nobody\'s access changed.',
              });
            }
            const beyond = role.permissions.filter((p) => !approverPermissions.includes(p));
            if (beyond.length > 0) {
              throw apiError(422, {
                code: 'escalates_beyond_the_approver',
                whatHappened: `${approvedBy} cannot grant ${beyond.join(', ')} because they do not hold it. Otherwise somebody who may approve access changes can create an administrator, and every other limit on them is decorative.`,
                wasItSaved: 'not_saved',
                nextSafeAction: 'Have the change approved by someone who already holds what is being granted. Nobody\'s access changed.',
              });
            }
          }
        }

        // A change that closes sessions must be able to: nothing is recorded if the session cannot be cut.
        if (result.closeSessions && deps.revocations === undefined) {
          throw apiError(503, {
            code: 'revocation_store_unavailable',
            whatHappened: 'This change closes the person\'s sessions, and this deployment has no revocation store wired, so the sessions could not be cut.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Wire the identity ledger (production always does). Nobody\'s access changed.',
          });
        }

        // A leaver's sign-in is switched off FIRST: a leaver who could still sign in would get a fresh token that no
        // revocation of the old ones covers. If the identity server cannot be reached, nothing changes.
        let signIn: LifecycleOutcome['signIn'];
        if (request.event === 'leaver') {
          if (deps.signIns === undefined) signIn = 'not_connected';
          else {
            try {
              signIn = await deps.signIns.end(ctx.tenantId, userId, approvedBy, at);
            } catch (e) {
              throw apiError(503, {
                code: 'identity_server_unavailable',
                whatHappened: `${userId}'s sign-in could not be switched off (${e instanceof Error ? e.message : 'no answer'}), so nothing was changed — a leaver who can still sign in has not left.`,
                wasItSaved: 'not_saved',
                nextSafeAction: 'Try again when the identity server answers. Nobody\'s access changed.',
              });
            }
          }
        }

        // Every rule passed: the approval is spent — once — and only then does anybody's access change.
        await opened.spend();
        await deps.recordChange(ctx.tenantId, {
          requestId, event: request.event, userId, requestedBy, approvedBy, reason: request.reason, added, removed,
        });
        if (result.closeSessions) {
          // Every token of the person issued up to THIS moment — the leaver's open laptop, the mover's old scope.
          await deps.revocations!.revoke(ctx.tenantId, {
            id: `rev-lifecycle-${requestId}`,
            tenantId: ctx.tenantId,
            userId,
            issuedBefore: Math.floor(Date.parse(at) / 1000),
            reason: 'admin_revoked',
            revokedBy: ctx.userId,
            revokedAt: at,
          });
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: approvedBy, action: `access.${request.event}`, objectType: 'user', objectId: userId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { grants: currentGrants.map((g) => `${g.roleId}@${g.branchScope === 'all' ? 'all' : g.branchScope.join('+')}`).join(',') },
          after: {
            grants: result.grants.map((g) => `${g.roleId}@${g.branchScope === 'all' ? 'all' : g.branchScope.join('+')}`).join(','),
            removed: String(removed.length), sessionsClosed: String(result.closeSessions), requestedBy, reason: request.reason,
          },
          correlationId: requestId,
        });
        const outcome: LifecycleOutcome = { ...result, recorded: true, sessionsClosed: result.closeSessions, ...(signIn === undefined ? {} : { signIn }) };
        return { status: 200, body: outcome };
      },
    },
  ];
}
