// API-11 Branch open / close lifecycle (M01-FR-04) — the governed decision on whether a branch may open,
// temporarily close, reopen or permanently close, on the live API, run on the tested `packages/org` engine.
//
// The decision is measured, never assumed: it reads what is ACTUALLY true at the branch — stock still held
// and valued, cash in tills and the safe, open documents, items the edge never synced, unresolved
// exceptions — and returns EVERY blocking reason at once, each in plain English with the number. Every
// transition except reopening needs the owner's approval, and the person executing is never the person
// approving (§28). A permanent close over unsent sync items is refused because it would destroy sales that
// were legitimately made (§31); a temporary close deliberately preserves state instead.
//
// Two routes, kept deliberately apart (audit PA-04):
//
//   • EVALUATE is a PREVIEW. The caller supplies the request, the current state and the readiness; this returns the
//     ruling and changes nothing (the reply says so: `preview: true`). It is a what-if, and a what-if can be fed
//     anything — so nothing ever acts on it.
//   • TRANSITION is the governed COMMAND. The caller sends only what they want and why. Head office MEASURES the
//     branch itself — its state from the org register, stock from the inventory ledger's valuation, cash and open
//     shifts from the till cash records, open deliveries from the purchase orders, unsent items from what the store
//     computer last reported (and how fresh that report is) — and a body that tries to supply any of it is refused.
//     Every transition but a reopen needs the OWNER's approval on the maker-checker engine (`branch_transition`), never
//     the maker's own; the approval is spent once. An allowed transition is persisted (a new version of the branch's
//     org node, the transition record with the readiness it was decided on) and, for a permanent close, every grant
//     limited to the branch is revoked in the same write — so the branch is closed to its people on their next request.
//     After a permanent close there is no further transition: the engine refuses one from `permanently_closed`.
//   • READINESS is the measured preview: what the command would decide right now, with every blocker, saving nothing.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope, notFound } from '../../kernel/src/index';
import {
  evaluateTransition,
  type BranchState, type BranchTransition, type TransitionRequest, type BranchReadiness, type ClosureApproval,
  type TransitionResult,
} from '../../../packages/org/src/index';
import { approvalNamedIn, actionDetails, type ApprovalPort } from '../../identity/src/approval-requests';

const STATES: readonly BranchState[] = ['draft', 'open', 'temporarily_closed', 'permanently_closed'];
const TRANSITIONS: readonly BranchTransition[] = ['open', 'temporarily_close', 'reopen', 'permanently_close'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isMoney = (v: unknown): boolean => isObj(v) && typeof v['minor'] === 'number' && typeof v['currency'] === 'string';

export function branchLifecycleRoutes(): readonly Route[] {
  return [
    {
      // Decide a branch transition and return every blocker at once. Read modelled as POST — writes nothing.
      api: 'API-11', method: 'POST', path: '/v1/platform/branches/transition/evaluate',
      permission: 'branch.transition.evaluate', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const request = b['request'];
        const readiness = b['readiness'];
        const currentState = b['currentState'];
        if (
          !isObj(request) || !TRANSITIONS.includes(request['transition'] as BranchTransition) ||
          typeof request['branchId'] !== 'string' || typeof request['requestedBy'] !== 'string' ||
          typeof request['reason'] !== 'string' || typeof request['at'] !== 'string' ||
          !STATES.includes(currentState as BranchState) ||
          !isObj(readiness) || !isMoney(readiness['stockValue']) || !isMoney(readiness['cashBalance'])
        ) {
          throw apiError(400, {
            code: 'transition_needs_request_state_readiness',
            whatHappened: 'A branch transition needs a request (branchId, transition, requestedBy, reason, at), the currentState, and the measured readiness (with stockValue and cashBalance as money).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the request, the branch’s current state and what is actually true at the branch now.',
          });
        }
        assertBranchInScope(ctx, request['branchId'] as string); // PA-01-r1: a transition for a branch the caller holds
        const result = evaluateTransition({
          request: request as unknown as TransitionRequest,
          currentState: currentState as BranchState,
          readiness: readiness as unknown as BranchReadiness,
          ...(isObj(b['approval']) ? { approval: b['approval'] as unknown as ClosureApproval } : {}),
        });
        // PA-04: a what-if on supplied figures — it never changes a branch. The governed command is
        // POST /v1/platform/branches/:branchId/transition, which measures the branch itself.
        return { status: 200, body: { ...result, preview: true, nothingChanged: true } };
      },
    },
  ];
}

/** A branch as the register holds it, for a transition. */
export interface BranchForTransition {
  readonly state: BranchState;
  /** It may activate: a company and a valid, own GST registration (the org register's own rule). */
  readonly configured: boolean;
}

/** A grant the transition took away — kept on the record so who lost access, and why, is never a mystery. */
export interface RevokedBranchAccess {
  readonly userId: string;
  readonly roleId: string;
  readonly branchScope: readonly string[];
  /** The branches the person keeps under the same role, when the grant covered others too. */
  readonly keeps: readonly string[];
}

/** One governed transition, as it is kept (append-only, for ever). */
export interface BranchTransitionRecord {
  readonly transitionId: string;
  readonly branchId: string;
  readonly transition: BranchTransition;
  readonly fromState: BranchState;
  readonly toState: BranchState;
  readonly reason: string;
  readonly reopensOn?: string;
  readonly requestedBy: string;
  /** The owner who approved it on the maker-checker engine; null only for a reopen, which needs none. */
  readonly approvedBy: string | null;
  readonly approvalId: string | null;
  readonly at: string;
  /** What head office measured, and decided on. */
  readonly readiness: BranchReadiness;
  readonly effects: readonly string[];
  /** Filled by the store when the transition is written (a permanent close only). */
  readonly accessRevoked: readonly RevokedBranchAccess[];
}

export interface BranchTransitionDeps {
  readonly branch: (tenantId: string, branchId: string) => Promise<BranchForTransition | undefined>;
  /** What is actually true at the branch now — measured from head office's own records, never the request. */
  readonly readiness: (tenantId: string, branchId: string, at: string) => Promise<BranchReadiness>;
  readonly approvals: ApprovalPort;
  /** Persist the transition: the branch's new state, the record and (permanent close) the access revocations — one write. */
  readonly commit: (tenantId: string, record: BranchTransitionRecord, toNodeStatus: 'draft' | 'active' | 'suspended' | 'closed') => Promise<BranchTransitionRecord>;
  readonly transitions: (tenantId: string, branchId: string) => Promise<readonly BranchTransitionRecord[]>;
  readonly now: () => string;
}

const NODE_STATUS: Readonly<Record<BranchState, 'draft' | 'active' | 'suspended' | 'closed'>> = {
  draft: 'draft', open: 'active', temporarily_closed: 'suspended', permanently_closed: 'closed',
};
/** Fields only head office may know — a body that carries one is trying to decide its own readiness. */
const MEASURED_FIELDS = ['readiness', 'currentState', 'approval', 'stockValue', 'stockUnits', 'cashBalance', 'unsentSyncItems', 'openDocuments', 'unresolvedExceptions', 'requestedBy', 'at'] as const;

const blockedText = (r: TransitionResult): string =>
  `The branch cannot be ${r.transition.replace('_', ' ')}d yet: ${r.blockers.map((b) => b.detail).join('; ')}.`;

export function branchTransitionRoutes(deps: BranchTransitionDeps): readonly Route[] {
  const branchOr404 = async (tenantId: string, branchId: string): Promise<BranchForTransition> => {
    const b = await deps.branch(tenantId, branchId);
    if (b === undefined) throw notFound(`branch ${branchId}`);
    return b;
  };
  const measure = async (tenantId: string, branchId: string, branch: BranchForTransition, at: string): Promise<BranchReadiness> => ({
    ...(await deps.readiness(tenantId, branchId, at)), configured: branch.configured,
  });

  return [
    {
      // The measured PREVIEW: what the command would decide now, every blocker at once. Saves nothing. It cannot know a
      // future approval, so for any transition but a reopen it lists `approval_required` too.
      api: 'API-11', method: 'GET', path: '/v1/platform/branches/:branchId/readiness',
      permission: 'branch.transition.evaluate',
      handler: async (ctx) => {
        const branchId = ctx.params['branchId'] ?? '';
        assertBranchInScope(ctx, branchId);
        const transition = ctx.query['transition'] ?? 'permanently_close';
        if (!TRANSITIONS.includes(transition as BranchTransition)) {
          throw apiError(400, { code: 'unknown_transition', whatHappened: `A transition is one of ${TRANSITIONS.join(', ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask about one of those.' });
        }
        const branch = await branchOr404(ctx.tenantId, branchId);
        const at = deps.now();
        const readiness = await measure(ctx.tenantId, branchId, branch, at);
        const result = evaluateTransition({
          request: { branchId, transition: transition as BranchTransition, requestedBy: ctx.userId, reason: 'preview', at },
          currentState: branch.state, readiness,
        });
        return { status: 200, body: { ...result, readiness, preview: true, nothingChanged: true } };
      },
    },
    {
      // The governed COMMAND. The body says what and why (and names the owner's approval); head office measures the rest.
      api: 'API-11', method: 'POST', path: '/v1/platform/branches/:branchId/transition',
      permission: 'branch.transition.execute', idempotent: true,
      handler: async (ctx) => {
        const branchId = ctx.params['branchId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const supplied = MEASURED_FIELDS.filter((k) => b[k] !== undefined);
        if (supplied.length > 0) {
          throw apiError(400, { code: 'readiness_is_measured_not_sent', whatHappened: `A branch transition is decided on what head office measures at the branch, never on figures sent with it (${supplied.join(', ')}).`, wasItSaved: 'not_saved', nextSafeAction: 'Send only { transition, reason } (and reopensOn for a temporary close, approvalId for the owner\'s approval).' });
        }
        const transition = b['transition'];
        if (!TRANSITIONS.includes(transition as BranchTransition) || typeof b['reason'] !== 'string'
          || (b['reopensOn'] !== undefined && typeof b['reopensOn'] !== 'string')) {
          throw apiError(400, { code: 'transition_needs_what_and_why', whatHappened: `A branch transition needs { transition (${TRANSITIONS.join(', ')}), reason }.`, wasItSaved: 'not_saved', nextSafeAction: 'Say which change, and why.' });
        }
        assertBranchInScope(ctx, branchId); // PA-01-r1: a transition for a branch the caller holds
        const branch = await branchOr404(ctx.tenantId, branchId);
        const at = deps.now();
        const readiness = await measure(ctx.tenantId, branchId, branch, at);

        // The owner's approval, on the maker-checker engine: exactly this request, by someone else, unused, unexpired.
        const approval = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'branch_transition', subjectRef: branchId, details: actionDetails(b, { branchId }), valueMinor: null,
          maker: ctx.userId, usedBy: `branch-transition:${branchId}:${at}`, now: at,
        });
        const request: TransitionRequest = {
          branchId, transition: transition as BranchTransition, requestedBy: ctx.userId, reason: (b['reason'] as string).trim(), at,
          ...(typeof b['reopensOn'] === 'string' ? { reopensOn: b['reopensOn'] } : {}),
        };
        const result = evaluateTransition({
          request, currentState: branch.state, readiness,
          ...(approval === undefined ? {} : { approval: { subjectRef: branchId, status: 'approved' as const, decidedBy: approval.decision.decidedBy } }),
        });
        if (!result.allowed) {
          throw apiError(409, { code: 'branch_transition_blocked', whatHappened: blockedText(result), wasItSaved: 'not_saved', nextSafeAction: 'Nothing changed. Clear each reason (GET the branch\'s readiness to see them all), then ask again.' });
        }
        await approval?.spend();
        const record = await deps.commit(ctx.tenantId, {
          transitionId: `${branchId}:${result.toState}:${at}`, branchId, transition: request.transition,
          fromState: result.fromState, toState: result.toState, reason: request.reason,
          ...(request.reopensOn === undefined ? {} : { reopensOn: request.reopensOn }),
          requestedBy: ctx.userId, approvedBy: approval?.decision.decidedBy ?? null,
          approvalId: approval === undefined ? null : (b['approvalId'] as string).trim(),
          at, readiness, effects: result.effects, accessRevoked: [],
        }, NODE_STATUS[result.toState]);
        return { status: 200, body: { transition: record } };
      },
    },
    {
      // The branch's transitions, oldest first — with what each was decided on and who lost access.
      api: 'API-11', method: 'GET', path: '/v1/platform/branches/:branchId/transitions',
      permission: 'branch.transition.evaluate',
      handler: async (ctx) => {
        const branchId = ctx.params['branchId'] ?? '';
        assertBranchInScope(ctx, branchId);
        await branchOr404(ctx.tenantId, branchId);
        return { status: 200, body: { branchId, transitions: await deps.transitions(ctx.tenantId, branchId) } };
      },
    },
  ];
}

