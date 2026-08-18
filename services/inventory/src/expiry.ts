// API-04 FEFO expiry action list (M10-FR-01) — the daily "what to mark down and what to bin" list, run on
// the tested `packages/fefo` engine. Perishable stock leaks money at expiry: this returns, EARLIEST-EXPIRY
// FIRST, every on-hand batch that is EXPIRED (→ dispose) or within `nearExpiryDays` of expiry (→ markdown),
// so the floor pulls what is past date and marks down what is close. A recall-blocked or non-`on_hand`
// batch is never listed — it is not sellable stock to mark down (the recall block is honoured elsewhere at
// the till, M10-FR-04).
//
// Deliberately STATELESS. The cloud availability ledger holds no batch EXPIRY (a movement carries a batch
// id but not its use-by), and the store edge already holds the batch/expiry truth in its signed pack — one
// truth, not two (P-02). The caller supplies the on-hand batches with their expiry; this endpoint runs the
// FEFO engine that nothing on the cloud could otherwise reach, and writes nothing.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { expiryActions, InvalidFefoRequestError, type Batch } from '../../../packages/fefo/src/index';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isWholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A batch is enough to be a batch when it names itself, its product, a whole quantity and an expiry date.
 * `state`/`recallBlocked` are optional (default on_hand / not recalled); the engine reads them if present. */
const isBatch = (v: unknown): v is Batch => {
  if (v === null || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return isStr(b['batchId']) && isStr(b['productId'])
    && typeof b['qty'] === 'number' && Number.isInteger(b['qty'])
    && isStr(b['expiry']);
};

export function expiryRoutes(): readonly Route[] {
  return [
    {
      // A read masquerading as POST because the batches are an array — idempotent, writes nothing.
      api: 'API-04', method: 'POST', path: '/v1/inventory/expiry-actions',
      permission: 'inventory.availability.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const batches = b['batches'];
        if (!Array.isArray(batches) || !batches.every(isBatch) || !isStr(b['asOf']) || !isWholeNonNeg(b['nearExpiryDays'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_expiry_check',
            whatHappened: 'An expiry action list needs batches[] (each with a batchId, productId, whole qty and an expiry date), an asOf date, and nearExpiryDays (a whole number of days ≥ 0).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the on-hand batches with their expiry dates, today’s date, and how many days ahead counts as near-expiry.',
          });
        }
        try {
          const items = expiryActions(batches as Batch[], b['asOf'] as string, b['nearExpiryDays'] as number);
          // 200, not 201 — nothing was created; this is the read of what needs action today.
          return {
            status: 200,
            body: {
              items,
              asOf: b['asOf'],
              nearExpiryDays: b['nearExpiryDays'],
              disposeCount: items.filter((i) => i.action === 'dispose').length,
              markdownCount: items.filter((i) => i.action === 'markdown').length,
              totalQtyAtRisk: items.reduce((s, i) => s + i.qty, 0),
            },
          };
        } catch (err) {
          if (err instanceof InvalidFefoRequestError) {
            throw apiError(400, { code: 'invalid_expiry_request', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the offending batch date (an unparseable date) and try again.' });
          }
          throw err;
        }
      },
    },
  ];
}
