// Real persistence for the thirteen services — hard rule #2, M08, §29, OB-01.
//
// Until now `main.ts` wired every service to a stub: the API booted, answered, and forgot
// everything. These are the adapters that make it a system rather than a shell.
//
// **Everything is an event.** There is no products table, no sales table, no stock table — a sale
// is a `SaleCommitted` appended to the tenant's stream, a stock movement is `InventoryMoved`, a
// published price list is `CataloguePublished`, and every balance and every "current" anything is
// **projected by reading the stream forward**. That is not architectural taste; it is the only
// shape in which hard rule #2 can actually hold. A table with an `UPDATE` on it is a quantity
// somebody can overwrite, and the database triggers in `db/migrations/0004` exist because that is
// the mistake worth making impossible rather than forbidding.
//
// Two consequences that show up immediately in the code below:
//
//   • **"Current" is always a fold, never a field.** The current catalogue pack is the last
//     `CataloguePublished` in the stream. Nothing stores "the current pack", so nothing can
//     disagree with the history about what it is.
//   • **Streams are per tenant and per domain.** `tenantId` is the argument to every call, not a
//     column somebody remembers to filter on (OB-01).

import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
import type { SignedPack } from '../../catalogue/src/index';
import type { CatalogueDeps } from '../../catalogue/src/index';
import type { IncomingSale, SaleException, PosDeps } from '../../pos/src/index';
import type { Movement, InventoryDeps } from '../../inventory/src/index';

/** Streams, named once. A typo here is a domain that silently reads an empty history. */
export const STREAM = {
  catalogue: 'catalogue',
  sales: 'sales',
  saleExceptions: 'sale-exceptions',
  inventory: 'inventory',
} as const;

const payloadOf = <T>(e: PersistedEvent): T => e.event.payload as T;

/** The last event of a type in a stream, or nothing. "Current" is a fold, never a field. */
async function latest<T>(
  store: EventStore, tenantId: string, stream: string, type: string,
): Promise<T | undefined> {
  const events = await store.readStream(tenantId, stream);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.event.type === type) return payloadOf<T>(e);
  }
  return undefined;
}

export function catalogueAdapter(input: {
  readonly store: EventStore;
  readonly signer: CatalogueDeps['signer'];
  readonly now: () => string;
}): CatalogueDeps {
  return {
    signer: input.signer,
    now: input.now,

    currentPack: (tenantId) => latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished'),

    storePack: async (tenantId, pack) => {
      await input.store.append(tenantId, STREAM.catalogue, makeEvent({
        id: `pack-${tenantId}-${pack.snapshot.version}`,
        type: 'CataloguePublished',
        occurredAt: pack.publishedAt,
        // Version-scoped: republishing v7 is the same event, so a retry cannot create two.
        idempotencyKey: `catalogue-${tenantId}-v${pack.snapshot.version}`,
        source: 'api/catalogue',
        payload: pack,
      }));
    },

    /**
     * Build the next snapshot from what has been published before.
     *
     * A real catalogue is assembled from the product master (M03) and the approved price lists
     * (M05); until those services have their own persistence this carries the last published set
     * forward with the version advanced, which keeps the publish path honest — the shrink check
     * has a real previous pack to compare against rather than nothing.
     */
    buildSnapshot: async (tenantId) => {
      const previous = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return {
        tenantId,
        version: (previous?.snapshot.version ?? 0) + 1,
        builtAt: input.now(),
        products: previous?.snapshot.products ?? [],
        barcodes: previous?.snapshot.barcodes ?? [],
      };
    },

    approvalsSince: () => [],
  };
}

export function posAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PosDeps {
  const sales = (tenantId: string) => input.store.readStream(tenantId, STREAM.sales);

  return {
    now: input.now,

    catalogue: async (tenantId) => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return new Map((pack?.snapshot.products ?? []).map((p: CatalogueProduct) => [p.productId, p]));
    },

    currentPackVersion: async (tenantId) =>
      (await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished'))?.snapshot.version ?? 0,

    receiptNumbers: async (tenantId) => new Map(
      (await sales(tenantId)).map((e) => {
        const s = payloadOf<IncomingSale>(e);
        return [s.receiptNumber, s.saleId] as const;
      }),
    ),

    bankedSaleIds: async (tenantId) => new Set(
      (await sales(tenantId)).map((e) => payloadOf<IncomingSale>(e).saleId),
    ),

    bankSale: async (tenantId, sale) => {
      await input.store.append(tenantId, STREAM.sales, makeEvent({
        id: `sale-${sale.saleId}`,
        type: 'SaleCommitted',
        occurredAt: sale.committedAt,
        // The sale's own id. A till resending the same sale collapses to one, whatever
        // Idempotency-Key the transport happened to use.
        idempotencyKey: `sale-${tenantId}-${sale.saleId}`,
        source: 'api/pos',
        payload: sale,
      }));
    },

    recordExceptions: async (tenantId, exceptions) => {
      for (const [i, ex] of exceptions.entries()) {
        await input.store.append(tenantId, STREAM.saleExceptions, makeEvent({
          id: `saleex-${ex.saleId}-${i}`,
          type: 'SaleExceptionRaised',
          occurredAt: input.now(),
          idempotencyKey: `saleex-${tenantId}-${ex.saleId}-${ex.kind}`,
          source: 'api/pos',
          payload: ex,
        }));
      }
    },

    openExceptions: async (tenantId) =>
      (await input.store.readStream(tenantId, STREAM.saleExceptions))
        .map((e) => payloadOf<SaleException>(e)),
  };
}

export function inventoryAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): InventoryDeps {
  const all = (tenantId: string) => input.store.readStream(tenantId, STREAM.inventory);

  return {
    now: input.now,

    movements: async (tenantId, productId) => {
      const ms = (await all(tenantId)).map((e) => payloadOf<Movement>(e));
      return productId === undefined ? ms : ms.filter((m) => m.productId === productId);
    },

    known: async (tenantId) => new Set(
      (await all(tenantId)).map((e) => payloadOf<Movement>(e).movementId),
    ),

    appendMovement: async (tenantId, m) => {
      await input.store.append(tenantId, STREAM.inventory, makeEvent({
        id: `mv-${m.movementId}`,
        type: 'InventoryMoved',
        occurredAt: m.occurredAt,
        idempotencyKey: `mv-${tenantId}-${m.movementId}`,
        source: 'api/inventory',
        payload: m,
      }));
    },
  };
}
