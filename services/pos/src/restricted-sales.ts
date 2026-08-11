// API-05 Restricted-sale gates (B14 / COTPA 2003 + B19 / Plastic Waste Management Rules) — the till asks
// these before it commits a basket, run on the tested `packages/restricted-sales` engine.
//
// Both are a decision, not a write: the lane sends the basket's restricted lines (their age-restricted /
// tobacco flags, pack minimum, and plastic attributes come from the offline price pack, so this works
// with the internet down, hard rule #1) and gets back whether the sale may complete and, if not, every
// blocking line named. The store's minimum age and the minimum carry-bag thickness are configuration
// (OB-03). Both gates share the `pos.restricted.check` permission the cashier already holds.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  checkRestrictedSale, type RestrictedLine, type AgeVerification,
  checkSingleUsePlastic, type PlasticLine,
} from '../../../packages/restricted-sales/src/index';

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
    {
      // Single-use-plastic & carry-bag gate (B19). POST because the basket lines are an array; idempotent,
      // writes nothing. minCarryBagMicrons, if given, overrides the 120 µm default (configuration OB-03).
      api: 'API-05', method: 'POST', path: '/v1/pos/single-use-plastic/check',
      permission: 'pos.restricted.check', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Array.isArray(b['lines'])) {
          throw apiError(400, {
            code: 'plastic_check_needs_lines',
            whatHappened: 'The single-use-plastic gate needs the basket lines[] (each with productId, unitPriceMinor and its carry-bag / banned-plastic flags).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the basket’s lines.',
          });
        }
        if (b['minCarryBagMicrons'] !== undefined && (!Number.isInteger(b['minCarryBagMicrons']) || (b['minCarryBagMicrons'] as number) <= 0)) {
          throw apiError(400, { code: 'plastic_min_microns_invalid', whatHappened: 'minCarryBagMicrons, if given, must be a positive integer.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store’s configured minimum thickness or omit it (defaults to 120 µm).' });
        }
        const result = checkSingleUsePlastic({
          lines: b['lines'] as PlasticLine[],
          ...(typeof b['minCarryBagMicrons'] === 'number' ? { minCarryBagMicrons: b['minCarryBagMicrons'] } : {}),
        });
        return { status: 200, body: result };
      },
    },
  ];
}
