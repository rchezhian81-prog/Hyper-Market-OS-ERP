// Round 9 · R9-A (owner decision OB-532, 28 Oct 2026) — head office's wiring for a quotation on a product whose floor it
// cannot read. Kept in its own file: main.ts carries only a spread line.
//
//   • OB-532 — such a quotation needs the OWNER's approval (like OB-520's till price cut): the quotation route counts an
//     approval as the owner's only when its decider holds the OWNER role at the quotation's store, read here from head
//     office's own grants (all stores, or that store) — never from the request.
//
// Reads only.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { QuotationsDeps } from '../../pos/src/quotations';
import { effectiveGrants } from './adapters';
import { OWNER_ROLE_ID } from './roles';

/** OB-532: what the quotation routes take from this round, spread after `r8bQuotationHooks` in main.ts. */
export function r9aQuotationHooks(input: { readonly store: EventStore }): Pick<QuotationsDeps, 'ownersAt'> {
  return {
    ownersAt: async (tenantId, storeId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      return [...new Set(grants
        .filter((g) => g.roleId === OWNER_ROLE_ID && (g.branchScope === 'all' || (Array.isArray(g.branchScope) && g.branchScope.includes(storeId))))
        .map((g) => g.userId))].sort();
    },
  };
}
