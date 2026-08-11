// API-02 Price integrity across shelf, POS, app & ESL (D06/D14, ratified R2 B25) — the audit that turns
// "one commerce truth" (P-02) from a principle into a checked fact. Run on the tested
// `packages/self-checkout` engine, which nothing on the cloud could reach.
//
// The till is the reference — not because it is more likely right, but because it is what the customer
// is charged, and every other surface is a claim about it. The consequences are NOT symmetric: a shelf
// showing LESS than the till is a **legal exposure** under Legal Metrology (the displayed price is what
// the customer was offered) and is ranked FIRST regardless of value — a ₹4 label error still draws a
// notice while a ₹5,000 margin leak does not. A surface that has not confirmed within its freshness
// window is reported **stale rather than as agreeing** — a label silent for nine days is showing
// whatever it was last told and will keep showing it.
//
// Stateless: the caller supplies the till prices and each surface's displayed price (both already held
// elsewhere — the price list and the ESL/shelf feeds); this endpoint is the verdict, not a new store.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  auditPriceIntegrity,
  type DisplayedPrice, type PriceSurface,
} from '../../../packages/self-checkout/src/index';

const SURFACES: readonly PriceSurface[] = ['pos', 'shelf_label', 'esl', 'app', 'kiosk', 'website'];

export function priceIntegrityRoutes(): readonly Route[] {
  return [
    {
      // A read modelled as POST because products + displayed prices are arrays — idempotent, writes nothing.
      api: 'API-02', method: 'POST', path: '/v1/pricing/integrity/audit',
      permission: 'price.integrity.audit', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const asAt = b['asAt'];
        if (typeof b['branchId'] !== 'string' || typeof asAt !== 'string' || Number.isNaN(Date.parse(asAt)) || !Array.isArray(b['products']) || !Array.isArray(b['displayed'])) {
          throw apiError(400, {
            code: 'integrity_needs_branch_products_asat',
            whatHappened: 'A price-integrity audit needs branchId, an asAt timestamp, a products list (each with productId, name, posPriceMinor) and a displayed list.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the branch, the till prices and every surface’s displayed price.',
          });
        }
        const requiredSurfaces = Array.isArray(b['requiredSurfaces'])
          ? (b['requiredSurfaces'] as string[]).filter((s): s is PriceSurface => SURFACES.includes(s as PriceSurface))
          : undefined;
        const report = auditPriceIntegrity({
          branchId: b['branchId'],
          products: b['products'] as { productId: string; name: string; posPriceMinor: number }[],
          displayed: b['displayed'] as DisplayedPrice[],
          ...(b['unitsSold'] !== undefined ? { unitsSold: b['unitsSold'] as Record<string, number> } : {}),
          ...(requiredSurfaces !== undefined ? { requiredSurfaces } : {}),
          ...(typeof b['staleAfterMinutes'] === 'number' ? { staleAfterMinutes: b['staleAfterMinutes'] } : {}),
          asAt,
        });
        return { status: 200, body: report };
      },
    },
  ];
}
