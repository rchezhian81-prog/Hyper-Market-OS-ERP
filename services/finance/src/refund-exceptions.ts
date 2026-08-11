// API-09 Refund exceptions & day totals (M14-FR-03/04) — the cash office's view of refunds that did NOT
// go cleanly, on the live API, run on the tested `packages/reversal` engine.
//
// A refund is where a shop pays money OUT, so the failure modes are the expensive ones: a reversal the
// provider REFUSED (the customer is owed money right now), one that came back UNCERTAIN (refund again and
// the shop pays twice), one confirmed but never seen on a statement (unreconciled — every refund must be
// independently reconcilable), and OVER-REFUNDED (more reversed against a tender than was ever charged).
// Every exception is **valued and owned** — a refund problem with no rupee figure and no name against it
// never reaches the top of anyone's day (P-03). And the day close does not balance by pretending an
// uncertain reversal is settled or failed — it balances by stating all three numbers so a manager
// closing at 10pm can see exactly how much money is in an unknown state.
//
// Stateless and read-only: the caller supplies the period's reversals and the originals they reverse;
// this returns the exception list and the day totals. The reversals themselves live in settlement/POS —
// this is the reading, not a second store.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  refundExceptions, refundDayTotals,
  type Reversal, type OriginalTender,
} from '../../../packages/reversal/src/index';

export function refundExceptionsRoutes(): readonly Route[] {
  return [
    {
      // The cash office's worst-first refund exception list. Read modelled as POST (arrays in body).
      api: 'API-09', method: 'POST', path: '/v1/finance/refunds/exceptions',
      permission: 'refund.exception.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Array.isArray(b['reversals']) || !Array.isArray(b['originals']) || typeof b['at'] !== 'string' || typeof b['owner'] !== 'string') {
          throw apiError(400, {
            code: 'refund_exceptions_need_reversals_originals_at_owner',
            whatHappened: 'The refund exception list needs reversals[], originals[], an as-at time and a named owner (an exception nobody owns is one nobody clears).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { reversals, originals, at, owner }. A list reads, it never writes.',
          });
        }
        const exceptions = refundExceptions({
          reversals: b['reversals'] as Reversal[],
          originals: b['originals'] as OriginalTender[],
          at: b['at'],
          ...(typeof b['reconcileWithinHours'] === 'number' ? { reconcileWithinHours: b['reconcileWithinHours'] } : {}),
          owner: b['owner'],
        });
        return { status: 200, body: { count: exceptions.length, exceptions } };
      },
    },
    {
      // Refund totals for the day close — three numbers stated, never one guessed.
      api: 'API-09', method: 'POST', path: '/v1/finance/refunds/day-totals',
      permission: 'refund.exception.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Array.isArray(b['reversals'])) {
          throw apiError(400, { code: 'day_totals_need_reversals', whatHappened: 'Refund day totals are summed from a reversals[] array.', wasItSaved: 'not_saved', nextSafeAction: 'Send { reversals: [...] }.' });
        }
        return { status: 200, body: refundDayTotals(b['reversals'] as Reversal[]) };
      },
    },
  ];
}
