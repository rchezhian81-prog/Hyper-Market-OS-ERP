// Round 16 · R16-A (independent check of rounds 10–15; decisions OB-611, OB-612) — head office's wiring for the gaps the
// checker found. Kept in its own file: shared files carry only import and spread lines.
//
//   • OB-612 (owner, 30 Oct 2026): the bill findings (`GET /v1/sales/exceptions`) narrow to the branches the caller may see.
//     The store a finding belongs to is head office's OWN answer for its bill — where the banked sale's stock left from (the
//     one rule `saleStockLocationOf` banking used: declared by the lane → the lane's registered store → the pack's store),
//     placed under its branch in the org hierarchy. Never the request's word, never the finding's.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { IncomingSale } from '../../pos/src/sale-intake';
import type { PosDeps } from '../../pos/src/index';
import { branchOfLocationIn } from '../../inventory/src/location-scope';
import { orgStructureAdapter, saleStockLocationOf } from './adapters';

/**
 * OB-612: the branch each banked sale belongs to, for the bill findings' scope. A sale head office never banked, or one no
 * store placed (its stock held at the lane's UNPLACED location), is in no branch: only a company-wide reader sees its finding.
 */
export function r16aSaleBranches(input: { readonly store: EventStore; readonly now: () => string }): Pick<PosDeps, 'branchOfSales'> {
  return {
    branchOfSales: async (tenantId, saleIds) => {
      const branchOf = branchOfLocationIn(await orgStructureAdapter({ store: input.store, now: input.now }).nodes(tenantId));
      const out = new Map<string, string>();
      for (const saleId of new Set(saleIds)) {
        const banked = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`);
        if (banked === undefined) continue;
        const placed = await saleStockLocationOf(input.store, tenantId, banked.event.payload as unknown as IncomingSale);
        if (placed.basis === 'unplaced') continue;
        out.set(saleId, branchOf(placed.locationId));
      }
      return out;
    },
  };
}
