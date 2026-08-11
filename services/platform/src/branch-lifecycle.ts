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
// Stateless and non-mutating: the caller supplies the request, the current state and the measured
// readiness; this is the ruling, and the caller applies it. That separation is what makes it auditable.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  evaluateTransition,
  type BranchState, type BranchTransition, type TransitionRequest, type BranchReadiness, type ClosureApproval,
} from '../../../packages/org/src/index';

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
        const result = evaluateTransition({
          request: request as unknown as TransitionRequest,
          currentState: currentState as BranchState,
          readiness: readiness as unknown as BranchReadiness,
          ...(isObj(b['approval']) ? { approval: b['approval'] as unknown as ClosureApproval } : {}),
        });
        return { status: 200, body: result };
      },
    },
  ];
}
