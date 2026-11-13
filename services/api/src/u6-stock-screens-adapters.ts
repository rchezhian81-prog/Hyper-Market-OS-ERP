// The readers behind the U6 stock screens (7 Nov 2026 · §27 Inventory "Ledger" / "Quarantine" · M08-FR-01 · M07-FR-03).
//
// The stock ledger screen reads ONE product's movements from the same append-only `InventoryMoved` stream every other
// stock reading folds — in append order, which is the ledger's order. The quarantine register reads the quality holds
// and the goods receipts through their own adapters (the register is a reading of both, never a third record).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Movement } from '../../inventory/src/index';
import type { StockLedgerDeps } from '../../inventory/src/stock-ledger';
import { STREAM } from './adapters';

export function stockLedgerAdapter(input: { readonly store: EventStore }): Pick<StockLedgerDeps, 'movementsOf'> {
  return {
    movementsOf: async (tenantId, productId) =>
      (await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' }))
        .map((e) => e.event.payload as Movement)
        .filter((m) => m.productId === productId),
  };
}
