// API-05 Restricted-sale gate (B14 / COTPA 2003) — the till asks this before it commits a basket that
// contains an age-restricted or tobacco line, run on the tested `packages/restricted-sales` engine.
//
// It is a decision, not a write: the lane sends the basket's restricted lines (their age-restricted /
// tobacco flags and pack minimum come from the offline price pack, so this works with the internet down,
// hard rule #1) and whatever age confirmation the cashier captured, and gets back whether the sale may
// complete and, if not, every blocking line named. The store's minimum age is configuration (OB-03).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { checkRestrictedSale, type RestrictedLine, type AgeVerification } from '../../../packages/restricted-sales/src/index';

export function restrictedSalesRoutes(): readonly Route[] {
  return [
    {
      // A gate modelled as POST (the basket lines are an array) — idempotent, writes nothing.
      api: 'API-05', method: 'POST', path: '/v1/pos/restricted-sale/check',
      permission: 'pos.restricted.check', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Array.isArray(b['lines'])) {
          throw apiError(400, {
            code: 'restricted_check_needs_lines',
            whatHappened: 'The restricted-sale gate needs the basket lines[] (each with productId, quantityMinor and its age-restricted/tobacco flags).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the basket’s lines and any age confirmation.',
          });
        }
        if (b['minimumAge'] !== undefined && (!Number.isInteger(b['minimumAge']) || (b['minimumAge'] as number) < 0)) {
          throw apiError(400, { code: 'restricted_min_age_invalid', whatHappened: 'minimumAge, if given, must be a non-negative integer.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store’s configured minimum age or omit it (defaults to 18).' });
        }
        const result = checkRestrictedSale({
          lines: b['lines'] as RestrictedLine[],
          ...(typeof b['ageVerification'] === 'object' && b['ageVerification'] !== null ? { ageVerification: b['ageVerification'] as AgeVerification } : {}),
          ...(typeof b['minimumAge'] === 'number' ? { minimumAge: b['minimumAge'] } : {}),
        });
        return { status: 200, body: result };
      },
    },
  ];
}
