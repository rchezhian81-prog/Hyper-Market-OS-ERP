// API-04 Near-expiry stock (M10-FR-01 · A03 · ADR-0015) — the STATEFUL counterpart to the stateless
// `/v1/inventory/expiry-actions` (which takes batches in the body). This reads the store's own ledger:
// it folds the received batches (with the expiry ADR-0015 now persists), nets what has sold (FIFO-by-receipt,
// ADR-0006) and what has been wasted, and returns the batches now on hand that are expired (dispose) or near
// expiry (markdown), earliest expiry first. A pure READ — it writes nothing. Gated inventory.availability.read.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { ExpiryActionItem } from '../../../packages/fefo/src/index';

export interface NearExpiryDeps {
  /** Fold the ledger to the batches on hand now that are expired or within `nearExpiryDays` of expiry. */
  readonly nearExpiry: (
    tenantId: string,
    opts: { readonly asOf: string; readonly nearExpiryDays: number },
  ) => Promise<readonly ExpiryActionItem[]> | readonly ExpiryActionItem[];
  readonly now: () => string;
}

const isPosInt = (n: number): boolean => Number.isInteger(n) && n >= 0;

export function nearExpiryRoutes(deps: NearExpiryDeps): readonly Route[] {
  return [
    {
      // What is on the shelves now and close to (or past) its use-by, worst-first. Query: withinDays?
      // (default 7), asOf? (default today). Read-only.
      api: 'API-04', method: 'GET', path: '/v1/inventory/near-expiry',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const asOf = typeof ctx.query['asOf'] === 'string' && ctx.query['asOf'] !== ''
          ? ctx.query['asOf'] : deps.now().slice(0, 10);
        const withinRaw = ctx.query['withinDays'];
        const nearExpiryDays = withinRaw === undefined || withinRaw === '' ? 7 : Number(withinRaw);
        if (!isPosInt(nearExpiryDays)) {
          throw apiError(400, {
            code: 'not_a_valid_window',
            whatHappened: 'withinDays must be a whole number of days (0 or more).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Call GET /v1/inventory/near-expiry?withinDays=7 — a read never changes anything.',
          });
        }
        const items = await deps.nearExpiry(ctx.tenantId, { asOf, nearExpiryDays });
        const disposeCount = items.filter((i) => i.action === 'dispose').length;
        return {
          status: 200,
          body: {
            items,
            count: items.length,
            markdownCount: items.filter((i) => i.action === 'markdown').length,
            disposeCount,
            asOf,
            nearExpiryDays,
          },
        };
      },
    },
  ];
}
