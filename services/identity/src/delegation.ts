// API-01 Approval delegation (M02-FR-03 · §28 · P-04 · hard rule #4) — tested since the module was written,
// on NO cloud route. The manager goes on leave and the shop still needs refunds authorised. Every business
// solves this, and most solve it the same way: **they share the login.** That is the single most damaging
// control failure in retail — two people on one account erases the audit trail permanently. Delegation makes
// the honest route easier than the dishonest one, and every rule here closes a route that ends in an
// unattributable decision:
//
//   • a delegate acts as THEMSELVES under a NAMED authority (never the absent manager's name);
//   • it is TIME-BOXED with a real end date — "until further notice" is a permanent escalation nobody
//     remembers granting, and an expired delegation stops on its own;
//   • you cannot lend MORE than you hold (value cap, branch scope) — and an uncapped delegation from a
//     limited approver is refused, because it would grant more than they have;
//   • a SEPARATE person must authorise it (§28) — lending your own authority away unsupervised is how a
//     limit quietly stops applying;
//   • NO self-delegation and NO chains — two hops in, nobody can say who was accountable.
//
// The rules are the tested `grantDelegation` / `effectiveAuthority` / `reviewDelegations` in `@sre/approvals`
// (the services-run-on-their-tested-engine guardrail). Delegations are recorded append-only, folded
// latest-per-id (a revocation supersedes). Gated `approvals.delegation.grant` to grant/revoke,
// `approvals.delegation.read` to review and to read effective authority.

import type { Route } from '../../kernel/src/index';
import { apiError, actorIsTheCaller } from '../../kernel/src/index';
import { SUBJECT_AUTHORITY } from './approval-decisions';
import {
  grantDelegation, effectiveAuthority, reviewDelegations, decideWithDelegation,
  type Delegation, type Approver, type DelegationRefusal,
  type ApprovalRequest, type Decision, type DelegatedRefusal,
} from '../../../packages/approvals/src/index';
import type { Money, CurrencyCode } from '../../../packages/contracts/src/money';
import type { Authority } from '../../../packages/approvals/src/authority-rules';
import { shopToday, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

const CURRENCIES: readonly CurrencyCode[] = ['INR', 'USD', 'EUR', 'GBP'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const strArray = (v: unknown): readonly string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
const isCurrency = (v: unknown): v is CurrencyCode => typeof v === 'string' && (CURRENCIES as readonly string[]).includes(v);
const isMoney = (v: unknown): v is Money => isObj(v) && isInt(v['minor']) && isCurrency(v['currency']);
// A value limit is a Money OR null (unlimited); anything else is malformed.
const readLimit = (v: unknown): Money | null | 'invalid' => v === null || v === undefined ? null : (isMoney(v) ? v : 'invalid');
// An Approver: { userId, branchScope: string[] | 'all', authorityLimit: Money | null }.
function readApprover(v: unknown): Approver | undefined {
  if (!isObj(v) || !isStr(v['userId'])) return undefined;
  const scope = v['branchScope'] === 'all' ? 'all' : strArray(v['branchScope']);
  if (scope === undefined) return undefined;
  const limit = readLimit(v['authorityLimit']);
  if (limit === 'invalid') return undefined;
  return { userId: v['userId'] as string, branchScope: scope, authorityLimit: limit };
}

// Every refusal is a route that would otherwise end in an unattributable decision — a 422, nothing saved.
const REFUSAL_STATUS: Readonly<Record<DelegationRefusal, number>> = {
  no_reason: 422, not_authorised: 422, self_delegation: 422, open_ended: 422, backwards_dates: 422,
  no_subject_types: 422, too_long: 422, exceeds_granter_authority: 422, widens_branch_scope: 422, chain_forbidden: 422,
};

// A decision refused on §28 grounds is not saved either — the maker deciding their own request (directly
// or through a delegation aimed back at themselves), a decider with no authority, out of scope, or over
// their cap. Every one is a 422 so the attempt is visible rather than silently blocked (P-08).
const DECISION_REFUSAL_STATUS: Readonly<Record<DelegatedRefusal, number>> = {
  self_approval_forbidden: 422, delegation_to_maker_forbidden: 422, no_authority: 422,
  out_of_scope: 422, exceeds_authority: 422, reason_required: 422,
};

const isDecision = (v: unknown): v is Decision => v === 'approved' || v === 'rejected';

/**
 * Read the request being decided. `branchId` is null (or omitted) for a company-wide request; `value`
 * is a Money or null (no monetary threshold). `status` is always 'pending' here — a decided request is
 * what this route PRODUCES, never what it accepts.
 */
function readApprovalRequest(v: unknown): ApprovalRequest | undefined {
  if (!isObj(v) || !isStr(v['id']) || !isStr(v['subjectType']) || !isStr(v['subjectRef']) || !isStr(v['requestedBy'])) return undefined;
  const branchId = v['branchId'];
  if (!(branchId === null || branchId === undefined || isStr(branchId))) return undefined;
  const value = v['value'];
  if (!(value === null || value === undefined || isMoney(value))) return undefined;
  return {
    id: v['id'] as string, subjectType: v['subjectType'] as string, subjectRef: v['subjectRef'] as string,
    requestedBy: v['requestedBy'] as string,
    branchId: isStr(branchId) ? branchId : null,
    value: isMoney(value) ? value : null,
    status: 'pending',
  };
}

export interface DelegationDeps {
  /** R1c (M01-FR-02): the shop's calendar — "today" is the shop's date, never the UTC one. */
  readonly calendar?: ShopCalendarOf;
  /** Every delegation recorded for the tenant — folded latest-per-delegationId (a revocation supersedes). */
  readonly delegations: (tenantId: string) => Promise<readonly Delegation[]> | readonly Delegation[];
  readonly recordDelegation: (tenantId: string, delegation: Delegation, key: string) => Promise<void> | void;
  /** WHERE a person holds a permission (Wave 2b · PA-03): the server's branch scope for an approver record; undefined when unknown. Optional on a stub. */
  readonly branchScopeOfUser?: (tenantId: string, userId: string, permission: string) => Promise<readonly string[] | 'all' | undefined> | readonly string[] | 'all' | undefined;
  /**
   * OB-290 (owner, 23 Oct 2026 · audit M02-FR-02): a person's money limit for a kind of decision, held on the SERVER. When
   * wired, every approver record's `authorityLimit` is the server's figure — a limit sent in the body is ignored (the audit
   * found `/v1/access/approvals/decide` taking the decider's own limit from the body). Optional on a bare stub.
   */
  readonly authorityOf?: (tenantId: string, userId: string, subjectType: string) => Promise<Authority>;
  readonly now: () => string;
}

/** The server's limit as an approver record carries it: null = no money cap; not set = nothing (₹0). */
export function limitAsMoney(a: Authority, currency: CurrencyCode = 'INR'): Money | null {
  if (a.state === 'not_value_limited' || a.state === 'unlimited') return null;
  return { minor: a.state === 'limit' ? a.limitMinor ?? 0 : 0, currency };
}

/** An approver record with the SERVER's limit for this kind in place of whatever the body said. */
async function withServerLimit(deps: Pick<DelegationDeps, 'authorityOf'>, tenantId: string, approver: Approver, subjectType: string): Promise<Approver> {
  if (deps.authorityOf === undefined) return approver;
  return { ...approver, authorityLimit: limitAsMoney(await deps.authorityOf(tenantId, approver.userId, subjectType)) };
}

/**
 * Round 12 (verifier r11 #11): the branch scope the SERVER gives the lender for EACH lent subject type — where their grants
 * carry THAT subject's authority — never the union across the types (a b1 refund authority lent beside a company-wide
 * day-close authority stays b1). A subject type with no known authority is refused by name, never taken from the body.
 * `undefined` per type: the server cannot say (no dep) and the approver record's own scope stands.
 */
async function serverScopes(
  deps: Pick<DelegationDeps, 'branchScopeOfUser'>, tenantId: string, approver: Approver, subjectTypes: readonly string[],
): Promise<{ readonly unknown: readonly string[]; readonly bySubject: Readonly<Record<string, readonly string[] | 'all'>> | undefined }> {
  const unknown = subjectTypes.filter((t) => SUBJECT_AUTHORITY[t] === undefined);
  if (unknown.length > 0 || deps.branchScopeOfUser === undefined) return { unknown, bySubject: undefined };
  const bySubject: Record<string, readonly string[] | 'all'> = {};
  for (const t of new Set(subjectTypes)) {
    const where = await deps.branchScopeOfUser(tenantId, approver.userId, SUBJECT_AUTHORITY[t]!);
    bySubject[t] = where === 'all' ? 'all' : [...new Set(where ?? [])].sort();
  }
  return { unknown, bySubject };
}

export function delegationRoutes(deps: DelegationDeps): readonly Route[] {
  return [
    {
      // What may this person actually approve today — their own authority, a live delegation, or nothing?
      // STATIC path, registered BEFORE `/:delegationId` so it is not read as a delegation called
      // "effective-authority". Body: { userId, subjectType, own?, onDate? }.
      api: 'API-01', method: 'POST', path: '/v1/access/delegations/effective-authority',
      permission: 'approvals.delegation.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const own = b['own'] === undefined ? undefined : readApprover(b['own']);
        if (!isStr(b['userId']) || !isStr(b['subjectType']) || (b['own'] !== undefined && own === undefined)
          || (b['onDate'] !== undefined && !isDate(b['onDate']))) {
          throw apiError(400, { code: 'not_readable_as_an_authority_query', whatHappened: 'An effective-authority query needs { userId, subjectType, own? (the person\'s own approver record), onDate? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send who and which kind of decision.' });
        }
        // OB-290: the person's own limit is the server's, never the body's.
        const ownServer = own === undefined ? undefined : await withServerLimit(deps, ctx.tenantId, own, b['subjectType'] as string);
        const result = effectiveAuthority({
          userId: b['userId'] as string, subjectType: b['subjectType'] as string,
          delegations: await deps.delegations(ctx.tenantId),
          today: isDate(b['onDate']) ? b['onDate'] as string : await shopToday(deps, ctx.tenantId),
          ...(ownServer !== undefined ? { own: ownServer } : {}),
        });
        return { status: 200, body: { ...result, ...(deps.authorityOf === undefined ? {} : { limitFrom: 'server' }) } };
      },
    },
    {
      // Grant a delegation — or refuse it. Body: { fromUserId, toUserId, fromDate, untilDate, subjectTypes[],
      // reason, granter (the fromUser's own approver record), valueCap?, branchScope?, maximumDays? }. The
      // authoriser is the caller (§28 — a separate person signs it off, never the person lending authority).
      api: 'API-01', method: 'POST', path: '/v1/access/delegations/:delegationId',
      permission: 'approvals.delegation.grant', idempotent: true,
      handler: async (ctx) => {
        const delegationId = (ctx.params['delegationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const subjectTypes = strArray(b['subjectTypes']);
        const granter = readApprover(b['granter']);
        const cap = readLimit(b['valueCap']);
        const branchScope = b['branchScope'] === undefined ? undefined : strArray(b['branchScope']);
        if (delegationId === '' || !isStr(b['fromUserId']) || !isStr(b['toUserId']) || !isDate(b['fromDate'])
          || !isDate(b['untilDate']) || subjectTypes === undefined || !isStr(b['reason']) || granter === undefined
          || cap === 'invalid' || (b['branchScope'] !== undefined && branchScope === undefined)
          || (b['maximumDays'] !== undefined && (!isInt(b['maximumDays']) || (b['maximumDays'] as number) <= 0))) {
          throw apiError(400, { code: 'not_readable_as_a_delegation', whatHappened: 'A delegation needs a delegationId in the path and { fromUserId, toUserId, fromDate, untilDate (YYYY-MM-DD), subjectTypes[], reason, granter (the fromUser\'s approver record), valueCap?, branchScope?, maximumDays? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send whose authority, to whom, for what and until when. Who authorises it is taken from your login.' });
        }
        // The granter record is the LENDER's own (PA-03): it must name the fromUser, and its branch scope is the server's.
        if (granter.userId !== (b['fromUserId'] as string)) throw actorIsTheCaller('granter.userId', granter.userId, `the lender ${b['fromUserId'] as string}`);
        const { unknown, bySubject } = await serverScopes(deps, ctx.tenantId, granter, subjectTypes);
        if (unknown.length > 0) {
          throw apiError(422, { code: 'unknown_subject_type', whatHappened: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a kind of decision head office knows the authority for, so nobody can say what would be lent.`, wasItSaved: 'not_saved', nextSafeAction: `Lend only kinds of decision head office knows: ${Object.keys(SUBJECT_AUTHORITY).join(', ')}. Nothing was saved.` });
        }
        const scopes = bySubject === undefined ? [] : Object.values(bySubject);
        const shared = scopes.length > 0 && scopes.every((x) => JSON.stringify(x) === JSON.stringify(scopes[0])) ? scopes[0] : undefined;
        const delegation: Delegation = {
          delegationId, fromUserId: b['fromUserId'] as string, toUserId: b['toUserId'] as string,
          fromDate: b['fromDate'] as string, untilDate: b['untilDate'] as string, subjectTypes,
          reason: b['reason'] as string, authorisedBy: ctx.userId, // §28 — the caller, never the fromUser
          ...(cap !== null ? { valueCap: cap } : {}),
          // Round 10 (found by the M02 browser proof): a delegation that names no branches is lent only where the LENDER
          // holds the authority (the server's scope) — never company-wide from a one-branch manager.
          ...(branchScope !== undefined ? { branchScope } : shared !== undefined && shared !== 'all' ? { branchScope: shared } : {}),
          // Round 12: and each subject type only where the lender holds THAT type's authority — never the union.
          ...(bySubject === undefined ? {} : { branchScopeBySubject: bySubject }),
        };
        // Judged per subject type against the lender's authority for THAT type: the cap, and a named scope never widened.
        const existing = await deps.delegations(ctx.tenantId);
        const today = await shopToday(deps, ctx.tenantId);
        // OB-290: the lender's limit is the server's for EACH lent kind — a cap above what they may approve is refused.
        const limitFor = async (t: string): Promise<Money | null> => (await withServerLimit(deps, ctx.tenantId, granter, t)).authorityLimit;
        const judge = (scope: readonly string[] | 'all', limit: Money | null = granter.authorityLimit) => grantDelegation({
          delegation, granter: { ...granter, branchScope: scope, authorityLimit: limit }, existing, today,
          ...(isInt(b['maximumDays']) ? { maximumDays: b['maximumDays'] as number } : {}),
        });
        let result = judge(bySubject === undefined ? granter.branchScope : 'all', deps.authorityOf === undefined || subjectTypes.length === 0 ? granter.authorityLimit : await limitFor(subjectTypes[0]!));
        for (const t of subjectTypes) {
          if (!result.created) break;
          const where = bySubject === undefined ? granter.branchScope : bySubject[t]!;
          if (bySubject !== undefined && where !== 'all' && where.length === 0) {
            throw apiError(422, { code: 'exceeds_granter_authority', whatHappened: `${b['fromUserId'] as string} does not hold the authority for ${t} anywhere, so it cannot be lent — nobody can hand out authority they do not have.`, wasItSaved: 'not_saved', nextSafeAction: 'Lend only what the lender holds. Nothing was saved.' });
          }
          if (bySubject === undefined && deps.authorityOf === undefined) break;
          result = judge(where, deps.authorityOf === undefined ? granter.authorityLimit : await limitFor(t));
        }
        if (!result.created) {
          throw apiError(REFUSAL_STATUS[result.refusal!], { code: result.refusal!, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Correct the delegation and send it again. Nothing was saved.' });
        }
        await deps.recordDelegation(ctx.tenantId, result.delegation!, ctx.idempotencyKey ?? delegationId);
        return { status: 201, body: { delegationId, fromUserId: delegation.fromUserId, toUserId: delegation.toUserId, untilDate: delegation.untilDate, authorisedBy: ctx.userId, detail: result.detail } };
      },
    },
    {
      // Revoke a delegation early — the counterpart to the March grant nobody remembered in August.
      api: 'API-01', method: 'POST', path: '/v1/access/delegations/:delegationId/revoke',
      permission: 'approvals.delegation.grant', idempotent: true,
      handler: async (ctx) => {
        const delegationId = (ctx.params['delegationId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['revokedOn'] !== undefined && !isDate(b['revokedOn'])) {
          throw apiError(400, { code: 'not_readable_as_a_revocation', whatHappened: 'A revocation takes an optional { revokedOn (YYYY-MM-DD) }; it defaults to today.', wasItSaved: 'not_saved', nextSafeAction: 'Send the date it is revoked, or none for today.' });
        }
        const existing = (await deps.delegations(ctx.tenantId)).find((d) => d.delegationId === delegationId);
        if (existing === undefined) throw apiError(404, { code: 'delegation_not_found', whatHappened: `No delegation "${delegationId}".`, wasItSaved: 'not_saved', nextSafeAction: 'Check the delegation id.' });
        const revokedOn = isDate(b['revokedOn']) ? b['revokedOn'] as string : await shopToday(deps, ctx.tenantId);
        const revoked: Delegation = { ...existing, revokedOn };
        await deps.recordDelegation(ctx.tenantId, revoked, `${delegationId}-revoke-${revokedOn}`);
        return { status: 200, body: { delegationId, revokedOn } };
      },
    },
    {
      // The standing-delegations review — the quiet failure it catches is a fortnight's-leave delegation
      // from March still live in August. `?onDate=` (defaults to today), `?warnWithinDays=` (default 7).
      api: 'API-01', method: 'GET', path: '/v1/access/delegations',
      permission: 'approvals.delegation.read',
      handler: async (ctx) => {
        const today = isDate(ctx.query['onDate']) ? ctx.query['onDate'] as string : await shopToday(deps, ctx.tenantId);
        const warnRaw = Number(ctx.query['warnWithinDays']);
        const rows = reviewDelegations({
          delegations: await deps.delegations(ctx.tenantId), today,
          ...(Number.isInteger(warnRaw) && warnRaw >= 0 ? { warnWithinDays: warnRaw } : {}),
        });
        return { status: 200, body: { onDate: today, rows, count: rows.length, needsAttention: rows.filter((r) => r.state === 'expiring').length } };
      },
    },
    {
      // Decide an approval under separation of duties (§28, hard rule #4). The decider is ALWAYS the
      // authenticated caller — never a name from the body — and the two §28 refusals are enforced here:
      // the maker cannot decide their own request, and a delegation aimed back at the maker ("I'll
      // approve my own requests while I cover for you") is a self-approval with an extra step, refused by
      // name so the attempt is visible. The caller's authority — their own, a live delegation, or none —
      // is computed from the same append-only delegation store as `effective-authority`, so a decision
      // over the delegate's cap or outside their branch is refused too. This is the SoD GATE: it returns
      // the attributed decision to record, or the refusal; it commits nothing itself (like
      // effective-authority). Body: { request { id, subjectType, subjectRef, requestedBy, branchId|null,
      // value|null }, decision (approved|rejected), reason, own? (the decider's own approver record), onDate? }.
      api: 'API-01', method: 'POST', path: '/v1/access/approvals/decide',
      permission: 'approvals.delegation.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const request = readApprovalRequest(b['request']);
        const own = b['own'] === undefined ? undefined : readApprover(b['own']);
        if (request === undefined || !isDecision(b['decision']) || typeof b['reason'] !== 'string'
          || (b['own'] !== undefined && own === undefined) || (b['onDate'] !== undefined && !isDate(b['onDate']))) {
          throw apiError(400, { code: 'not_readable_as_a_decision', whatHappened: 'A delegated decision needs { request { id, subjectType, subjectRef, requestedBy, branchId|null, value {minor,currency}|null }, decision (approved|rejected), reason, own? (the decider\'s own approver record), onDate? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the request, your decision and a reason. Who decides is taken from your login, never the body.' });
        }
        // The decider's own record is the CALLER's (PA-03) — a body cannot lend somebody else's authority to this sign-in —
        // and its branch scope is the server's.
        if (own !== undefined && own.userId !== ctx.userId) throw actorIsTheCaller('own.userId', own.userId, ctx.userId);
        const ownWhere = own === undefined || deps.branchScopeOfUser === undefined || SUBJECT_AUTHORITY[request.subjectType] === undefined ? undefined
          : await deps.branchScopeOfUser(ctx.tenantId, own.userId, SUBJECT_AUTHORITY[request.subjectType]!);
        const ownScopedRaw = own === undefined ? undefined
          : deps.branchScopeOfUser === undefined || SUBJECT_AUTHORITY[request.subjectType] === undefined ? own
          : { ...own, branchScope: ownWhere === 'all' ? 'all' as const : [...new Set(ownWhere ?? [])].sort() };
        // OB-290 (the audit's finding): the decider's limit is the SERVER's — `own.authorityLimit` in the body is ignored.
        const ownScoped = ownScopedRaw === undefined ? undefined : await withServerLimit(deps, ctx.tenantId, ownScopedRaw, request.subjectType);
        const authority = effectiveAuthority({
          userId: ctx.userId, subjectType: request.subjectType,
          delegations: await deps.delegations(ctx.tenantId),
          today: isDate(b['onDate']) ? b['onDate'] as string : await shopToday(deps, ctx.tenantId),
          ...(ownScoped !== undefined ? { own: ownScoped } : {}),
        });
        const outcome = decideWithDelegation({
          request, decidedBy: ctx.userId, decision: b['decision'] as Decision,
          reason: b['reason'] as string, authority, at: deps.now(),
        });
        if (!outcome.ok) {
          throw apiError(DECISION_REFUSAL_STATUS[outcome.refusal], { code: outcome.refusal, whatHappened: outcome.detail, wasItSaved: 'not_saved', nextSafeAction: 'The decision was not permitted and nothing was recorded. Escalate to someone who holds the authority, or correct the request.' });
        }
        return { status: 200, body: { ok: true, decision: outcome.request, ...(deps.authorityOf === undefined || ownScoped === undefined ? {} : { limitFrom: 'server', limitApplied: ownScoped.authorityLimit }) } };
      },
    },
  ];
}
