// API-09 Payroll — the DURABLE pay-run lifecycle store (WP3 inc9), on the tested `packages/payroll`
// pay-run engine. Increment 4 gave the lifecycle as a PURE fold + transition guard; the `…/evaluate` route
// folds caller-supplied events and stays. This makes the run DURABLE: each lifecycle step is appended to the
// tenant's append-only event log (one stream per pay run), so a run — its state, who submitted it, who
// approved it — survives a restart, and "current" is always a fold of the stored facts (hard rule #2).
//
//   • `POST …/pay-run/:payRunId/append` — append ONE lifecycle step (draft/submit/approve/reject/lock/
//     reverse). The proposed step is checked against the STORED state with the same transition guard before
//     anything is written, so **maker ≠ checker is enforced at the store's write boundary** (§28): a submitter
//     approving their own run is refused (422), not appended. A locked run is final; a correction is a
//     reversal + a new run, never a rewrite.
//   • `GET  …/pay-run/:payRunId`         — the current state, folded from the stored events.
//
// Confidential — owner-gated on `payroll.statutory.read`. Nothing here commits a payment; a live pay run
// still needs CA/HR/legal GO.
//
// **Step-up (Stage E slice 1 · SEC-03 · §28 · GAP-SEC-06 follow-on closed).** The RELEASE steps — approve, lock,
// reverse — are the ones that move money or undo a run, so they need a RECENT, MFA-backed re-authentication
// from the SIGNED token, checked here at the API boundary (`requireStepUp`) rather than only in the web-erp
// session, so a direct API call cannot skip the prompt. Draft, submit and reject are preparation and stay
// ordinary. The bank-file route in `payroll.ts` declares the same requirement route-level.

import type { ReauthRequirement, Route } from '../../kernel/src/index';
import { apiError, notFound, requireActorIsCaller, requireStepUp } from '../../kernel/src/index';
import {
  evaluatePayRunTransition,
  type PayRunAggregate, type PayRunEvent, type PayRunAction,
} from '../../../packages/payroll/src/index';

/** What the durable pay-run store must provide — load folds the stored stream, append writes one fact. */
export interface PayRunStoreDeps {
  readonly load: (tenantId: string, payRunId: string) => Promise<PayRunAggregate | undefined> | PayRunAggregate | undefined;
  readonly append: (tenantId: string, payRunId: string, event: PayRunEvent) => Promise<void> | void;
  readonly now: () => string;
}

// 'draft' bootstraps a run; the rest are the engine's transition actions.
const ACTIONS: readonly (PayRunAction | 'draft')[] = ['draft', 'submit', 'approve', 'reject', 'lock', 'reverse'];

/** The pay-run steps that RELEASE money or undo a released run — each needs a fresh MFA re-auth (§28). */
export const PAY_RUN_RELEASE_ACTIONS: readonly PayRunAction[] = ['approve', 'lock', 'reverse'];

/** What a payroll release demands of the sign-in: a re-authentication within 5 minutes, with a second factor —
 *  the same bar as a privilege grant or an erasure (`services/identity`, `services/customer`). */
export const PAYROLL_RELEASE_STEP_UP: ReauthRequirement = { withinSeconds: 300, amr: ['mfa'] };

export function payRunStoreRoutes(deps: PayRunStoreDeps): readonly Route[] {
  return [
    {
      // Append one lifecycle step to a durable pay run. Body: { action, actor, at?, payPeriod? (draft),
      // netTotalMinor? employeeCount? (draft), reason? (reject/reverse) }. The step is validated against the
      // STORED state (maker ≠ checker, lock-is-final) before it is written — an illegal step is refused, not stored.
      api: 'API-09', method: 'POST', path: '/v1/hr/payroll/pay-run/:payRunId/append',
      permission: 'payroll.statutory.read', idempotent: true,
      handler: async (ctx) => {
        const payRunId = ctx.params['payRunId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const action = b['action'];
        if (!ACTIONS.includes(action as PayRunAction | 'draft')) {
          throw apiError(400, { code: 'pay_run_append_needs_action', whatHappened: 'Appending a pay-run step needs action (draft/submit/approve/reject/lock/reverse).', wasItSaved: 'not_saved', nextSafeAction: 'Send the lifecycle action, and the actor taking it.' });
        }
        const at = typeof b['at'] === 'string' ? (b['at'] as string) : deps.now();
        const reason = typeof b['reason'] === 'string' ? (b['reason'] as string) : undefined;
        // WHO takes each step is the signed-in caller (ADR-0024 · audit PA-03 · §28): the maker drafts and submits under
        // their own sign-in, a different person approves under theirs. A body `actor` naming anyone else is refused —
        // before, both halves were body strings, so one person could submit as one name and approve as another.
        requireActorIsCaller(ctx, b, 'actor');
        const actor = ctx.userId;

        // draft — create the run. It has no prior state to transition from; refuse a second draft of the same id.
        if (action === 'draft') {
          if (typeof b['payPeriod'] !== 'string') {
            throw apiError(400, { code: 'pay_run_draft_needs_period_actor', whatHappened: 'Drafting a pay run needs payPeriod (e.g. 2026-08); who prepared it is the signed-in person.', wasItSaved: 'not_saved', nextSafeAction: 'Send payPeriod.' });
          }
          const existing = await deps.load(ctx.tenantId, payRunId);
          if (existing !== undefined) {
            return { status: 200, body: { payRunId, alreadyExists: true, current: existing } }; // idempotent — one draft per id
          }
          const drafted: PayRunEvent = {
            kind: 'drafted', payPeriod: b['payPeriod'], by: actor, at,
            ...(Number.isInteger(b['netTotalMinor']) ? { netTotalMinor: b['netTotalMinor'] as number } : {}),
            ...(Number.isInteger(b['employeeCount']) ? { employeeCount: b['employeeCount'] as number } : {}),
          };
          await deps.append(ctx.tenantId, payRunId, drafted);
          const current = await deps.load(ctx.tenantId, payRunId);
          return { status: 201, body: { payRunId, current } };
        }

        // Every other action must be a legal transition from the STORED state.
        // A RELEASE step (approve / lock / reverse) needs a fresh, MFA-backed re-authentication from the SIGNED
        // token — refused 403 `reauthentication_required` BEFORE the stored state is read or anything is
        // written. Maker ≠ checker below still applies on top (SEC-03, §28).
        if (PAY_RUN_RELEASE_ACTIONS.includes(action as PayRunAction)) {
          requireStepUp(ctx, PAYROLL_RELEASE_STEP_UP, Date.parse(deps.now()), `A pay-run '${String(action)}' releases or undoes pay.`);
        }
        const current = await deps.load(ctx.tenantId, payRunId);
        const decision = evaluatePayRunTransition({
          ...(current !== undefined ? { current } : {}),
          action: action as PayRunAction,
          actor,
          ...(reason !== undefined ? { reason } : {}),
        });
        if (!decision.allowed) {
          throw apiError(422, { code: `pay_run_${decision.refusal ?? 'refused'}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: 'Take a step the run’s current state allows (a different person approves; a locked run is corrected by a reversal + a new run).' });
        }
        const event = eventFor(action as PayRunAction, actor, at, reason);
        await deps.append(ctx.tenantId, payRunId, event);
        const updated = await deps.load(ctx.tenantId, payRunId);
        return { status: 200, body: { payRunId, decision, current: updated } };
      },
    },
    {
      // The current, durable pay-run state — folded from the stored append-only events.
      api: 'API-09', method: 'GET', path: '/v1/hr/payroll/pay-run/:payRunId',
      permission: 'payroll.statutory.read',
      handler: async (ctx) => {
        const payRunId = ctx.params['payRunId'] ?? '';
        const agg = await deps.load(ctx.tenantId, payRunId);
        if (agg === undefined) throw notFound(`a pay run ${payRunId}`);
        return { status: 200, body: agg };
      },
    },
  ];
}

/** The event a validated action appends. Pure — the guard already confirmed it is legal. */
function eventFor(action: PayRunAction, actor: string, at: string, reason: string | undefined): PayRunEvent {
  switch (action) {
    case 'submit': return { kind: 'submitted', by: actor, at };
    case 'approve': return { kind: 'approved', by: actor, at };
    case 'reject': return { kind: 'rejected', by: actor, at, ...(reason !== undefined ? { reason } : {}) };
    case 'lock': return { kind: 'locked', at };
    case 'reverse': return { kind: 'reversed', by: actor, reason: reason ?? '', at };
  }
}
