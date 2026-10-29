// Round 10 · R10-A (owner decisions OB-542 and OB-543, 28 Oct 2026) — head office's wiring for this round. Kept in its own
// file: main.ts carries only an import and a spread line.
//
//   • OB-542 — a quotation on a product with no known floor that the OWNER himself makes is approved by the ACCOUNTANT: the
//     quotation route counts an approval as the accountant's only when its decider holds the ACCOUNTANT role at the
//     quotation's store, read here from head office's own grants (all stores, or that store) — never from the request.
//   • OB-543 — the accountant reads the goods-receipt screen through its own narrow word (`inventory.goodsreceipt.read`); the
//     route itself lives with the other goods-receipt routes (services/inventory/src/goods-receipt.ts).
//
// Reads only.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { QuotationsDeps } from '../../pos/src/quotations';
import { effectiveGrants } from './adapters';

/** The accountant's role id (services/api/src/roles.ts). */
export const ACCOUNTANT_ROLE_ID = 'accountant';

/** OB-542: what the quotation routes take from this round, spread after `r9aQuotationHooks` in main.ts. */
export function r10aQuotationHooks(input: { readonly store: EventStore }): Pick<QuotationsDeps, 'accountantsAt'> {
  return {
    accountantsAt: async (tenantId, storeId) => {
      const grants = await effectiveGrants(input.store, tenantId);
      return [...new Set(grants
        .filter((g) => g.roleId === ACCOUNTANT_ROLE_ID && (g.branchScope === 'all' || (Array.isArray(g.branchScope) && g.branchScope.includes(storeId))))
        .map((g) => g.userId))].sort();
    },
  };
}
