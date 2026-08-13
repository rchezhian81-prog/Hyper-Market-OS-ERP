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

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
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

        // draft — create the run. It has no prior state to transition from; refuse a second draft of the same id.
        if (action === 'draft') {
          if (typeof b['payPeriod'] !== 'string' || typeof b['actor'] !== 'string') {
            throw apiError(400, { code: 'pay_run_draft_needs_period_actor', whatHappened: 'Drafting a pay run needs payPeriod (e.g. 2026-08) and actor (who prepared it).', wasItSaved: 'not_saved', nextSafeAction: 'Send payPeriod and actor.' });
          }
          const existing = await deps.load(ctx.tenantId, payRunId);
          if (existing !== undefined) {
            return { status: 200, body: { payRunId, alreadyExists: true, current: existing } }; // idempotent — one draft per id
          }
          const drafted: PayRunEvent = {
            kind: 'drafted', payPeriod: b['payPeriod'], by: b['actor'], at,
            ...(Number.isInteger(b['netTotalMinor']) ? { netTotalMinor: b['netTotalMinor'] as number } : {}),
            ...(Number.isInteger(b['employeeCount']) ? { employeeCount: b['employeeCount'] as number } : {}),
          };
          await deps.append(ctx.tenantId, payRunId, drafted);
          const current = await deps.load(ctx.tenantId, payRunId);
          return { status: 201, body: { payRunId, current } };
        }

        // Every other action must be a legal transition from the STORED state.
        if (typeof b['actor'] !== 'string') {
          throw apiError(400, { code: 'pay_run_append_needs_actor', whatHappened: 'A pay-run step needs actor (who is taking it) — the approver must differ from the submitter (§28).', wasItSaved: 'not_saved', nextSafeAction: 'Send the actor.' });
        }
        const current = await deps.load(ctx.tenantId, payRunId);
        const decision = evaluatePayRunTransition({
          ...(current !== undefined ? { current } : {}),
          action: action as PayRunAction,
          actor: b['actor'],
          ...(reason !== undefined ? { reason } : {}),
        });
        if (!decision.allowed) {
          throw apiError(422, { code: `pay_run_${decision.refusal ?? 'refused'}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: 'Take a step the run’s current state allows (a different person approves; a locked run is corrected by a reversal + a new run).' });
        }
        const event = eventFor(action as PayRunAction, b['actor'], at, reason);
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
