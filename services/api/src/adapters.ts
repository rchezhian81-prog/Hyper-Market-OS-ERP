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
import { project } from '../../inventory/src/index';
import type { Movement, InventoryDeps } from '../../inventory/src/index';
import type { MatchResult, BankChangeRequest, PurchaseDeps } from '../../purchase/src/index';
import type { JournalEntry, PeriodState, FinanceDeps } from '../../finance/src/index';
import type { ConsentRecord, CustomerDeps } from '../../customer/src/index';
import { expired } from '../../orders/src/index';
import type { Reservation, OrdersDeps } from '../../orders/src/index';
import type { DeliveryAttempt, FulfilmentDeps } from '../../fulfilment/src/index';

/** Streams, named once. A typo here is a domain that silently reads an empty history. */
export const STREAM = {
  catalogue: 'catalogue',
  sales: 'sales',
  saleExceptions: 'sale-exceptions',
  inventory: 'inventory',
  purchase: 'purchase',
  finance: 'finance',
  periods: 'periods',
  consent: 'consent',
  reservations: 'reservations',
  delivery: 'delivery',
} as const;

const payloadOf = <T>(e: PersistedEvent): T => e.event.payload as T;

/** Every payload of one type in a stream, oldest first. */
async function allOf<T>(
  store: EventStore, tenantId: string, stream: string, type: string,
): Promise<readonly T[]> {
  const events = await store.readStream(tenantId, stream);
  return events.filter((e) => e.event.type === type).map((e) => payloadOf<T>(e));
}

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

// ─────────────────────────────────────────────────────────────────────────────
//  Where a projection has no producer yet
// ─────────────────────────────────────────────────────────────────────────────
//
// Three of the reads below fold a stream nothing writes to: purchase orders, the chart of
// accounts, and the dispatch list. Folding an empty stream is easy; the problem is what the
// answer *means*.
//
// A stub returning `[]` is obviously a stub. A projection returning `[]` looks like an answer,
// and for these three the empty answer is an all-clear: "no lines, so the invoice matches",
// "no control totals failed, so close the month", "no assigned orders are missing, so the run
// reconciles". That is the worst possible failure mode — the system is most confident exactly
// where it knows least.
//
// So the domains were changed rather than the adapters papered over. An invoice with no lines is
// now blocked because nothing was compared; a period with no control total refuses to close
// because nothing checked it; a delivery attempt against an order not on the run is reported
// even when the run itself is empty; and what is on order returns *not known*, which is not zero.
// Every one of those is a defect that existed before persistence and would have shipped without
// it — wiring a real store is what made an empty answer visible as an answer.

export function purchaseAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PurchaseDeps {
  return {
    now: input.now,

    /**
     * Lines for one invoice, from the receiving and invoice-capture events.
     *
     * Nothing writes `PurchaseInvoiceCaptured` yet (M06 receiving and invoice capture are not on
     * this API surface), so today this is empty for every invoice — and `threeWayMatch` refuses
     * an empty line set rather than calling it a match.
     */
    matchLines: async (tenantId, invoiceId) => {
      const captured = await allOf<{ readonly invoiceId: string; readonly lines: readonly MatchLineOf[] }>(
        input.store, tenantId, STREAM.purchase, 'PurchaseInvoiceCaptured',
      );
      return captured.filter((c) => c.invoiceId === invoiceId).flatMap((c) => c.lines);
    },

    recordMatch: async (tenantId, invoiceId, r) => {
      await input.store.append(tenantId, STREAM.purchase, makeEvent({
        id: `match-${invoiceId}`,
        type: 'InvoiceMatched',
        occurredAt: input.now(),
        // Keyed on the *outcome*, not just the invoice. Re-running an unchanged match is the same
        // event and collapses; a match that now pays a different figure is a different fact and
        // must be recorded, or the ledger would show the first answer forever.
        idempotencyKey: `match-${tenantId}-${invoiceId}-${r.payableMinor}-${r.invoicedMinor}`,
        source: 'api/purchase',
        payload: { invoiceId, ...r } satisfies { invoiceId: string } & MatchResult,
      }));
    },

    applyBankChange: async (tenantId, r) => {
      await input.store.append(tenantId, STREAM.purchase, makeEvent({
        id: `bank-${r.supplierId}-${r.requestedAt}`,
        type: 'SupplierBankChanged',
        occurredAt: input.now(),
        // The request's own date is in the key. Without it a supplier who moved to a new account
        // and later moved back would have the return collapse into the original change as a
        // replay — and the ledger would then assert the money still goes to the middle account.
        idempotencyKey: `bank-${tenantId}-${r.supplierId}-${r.newAccount}-${r.requestedAt}`,
        source: 'api/purchase',
        payload: r satisfies BankChangeRequest,
      }));
    },

    // Not known, and not zero. See the note above.
    openCommitments: () => undefined,
  };
}

/** The shape `matchLines` yields; imported structurally to avoid a cycle through the route module. */
interface MatchLineOf {
  readonly productId: string;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly invoicedQty: number;
  readonly orderedUnitMinor: number;
  readonly invoicedUnitMinor: number;
}

/** `YYYY-MM` plus n months, without a Date round-trip that a timezone can move. */
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function financeAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FinanceDeps {
  const journals = (tenantId: string) =>
    allOf<JournalEntry>(input.store, tenantId, STREAM.finance, 'JournalPosted');
  const closed = async (tenantId: string): Promise<ReadonlySet<string>> => new Set(
    (await allOf<{ readonly period: string }>(input.store, tenantId, STREAM.periods, 'PeriodClosed'))
      .map((c) => c.period),
  );

  return {
    now: input.now,

    /** Open is the absence of a close, not a stored flag — so no period can be open and closed at once. */
    periodStates: async (tenantId) => {
      const shut = await closed(tenantId);
      const seen = new Set<string>([...shut, ...(await journals(tenantId)).map((j) => j.period)]);
      return new Map([...seen].sort().map((p) => [p, shut.has(p) ? 'closed' : 'open'] as const)) as ReadonlyMap<string, PeriodState>;
    },

    /**
     * Where a late document goes. The first month from today onwards that is not closed.
     *
     * Bounded deliberately: a walk that reads "while closed, step forward" over corrupt data is a
     * request that never returns. Ten years of consecutive closed months is not a data shape to
     * loop through, it is one to stop on.
     */
    nextOpenPeriod: async (tenantId) => {
      const shut = await closed(tenantId);
      let period = input.now().slice(0, 7);
      for (let i = 0; i < 120 && shut.has(period); i += 1) period = addMonths(period, 1);
      return period;
    },

    appendJournal: async (tenantId, e) => {
      await input.store.append(tenantId, STREAM.finance, makeEvent({
        id: `je-${e.entryId}`,
        type: 'JournalPosted',
        // When we recorded it, not the document's own date. Those are deliberately different here
        // — a late invoice posts to the next open period *carrying* its real document date, which
        // is a property of the entry and already in the payload. Conflating the two would put the
        // ledger's clock under the control of whoever typed the date on the paper.
        occurredAt: input.now(),
        idempotencyKey: `je-${tenantId}-${e.entryId}`,
        source: 'api/finance',
        payload: e,
      }));
    },

    /**
     * No control total can be built from this system alone, and saying so is the honest answer.
     *
     * A control total needs two figures reached two different ways — that is the whole point, and
     * `closePeriod` refuses a pair that shares a derivation by name. Everything this API holds for
     * a period comes down the same path: the till banks a sale, the sale becomes a journal. Adding
     * those two up and comparing them is one figure written twice.
     *
     * The genuine second sources are outside: the bank statement, the filed return, the counted
     * shelf. Until one of those is fed in, this returns nothing, the period does not close, and
     * the refusal says why. A month that closes because nobody checked it is the outcome worth
     * refusing — `packages/migration/src/banking-verification.ts` is the same control at migration.
     */
    controlTotals: () => [],

    /** Who posted into the month — the separation-of-duties check reads this, so it must be real. */
    postersIn: async (tenantId, period) => [...new Set(
      (await journals(tenantId)).filter((j) => j.period === period).map((j) => j.postedBy),
    )].sort(),

    markClosed: async (tenantId, period, signedBy) => {
      await input.store.append(tenantId, STREAM.periods, makeEvent({
        id: `close-${period}`,
        type: 'PeriodClosed',
        occurredAt: input.now(),
        idempotencyKey: `close-${tenantId}-${period}`,
        source: 'api/finance',
        payload: { period, signedBy, closedAt: input.now() },
      }));
    },
  };
}

export function customerAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): CustomerDeps {
  return {
    now: input.now,

    consentRecords: async (tenantId, customerId) =>
      (await allOf<ConsentRecord>(input.store, tenantId, STREAM.consent, 'ConsentRecorded'))
        .filter((r) => r.customerId === customerId),

    appendConsent: async (tenantId, r) => {
      await input.store.append(tenantId, STREAM.consent, makeEvent({
        id: `consent-${r.customerId}-${r.recordedAt}`,
        type: 'ConsentRecorded',
        occurredAt: r.recordedAt,
        // Time is part of the key: consent given, withdrawn and given again is three facts about
        // the same customer, purpose and channel, and the middle one is the one a regulator asks
        // about. A key without the timestamp would keep only the first and call the rest replays.
        idempotencyKey: `consent-${tenantId}-${r.customerId}-${r.purpose}-${r.channel}-${r.recordedAt}`,
        source: 'api/customer',
        payload: r,
      }));
    },

    // Not known, and not zero — the route already tells the counter which of the two it got.
    // Loyalty accrual (M14) does not post to this API yet.
    pointsBalance: () => undefined,
  };
}

export function ordersAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly holdMinutes: number;
}): OrdersDeps {
  return {
    now: input.now,
    holdMinutes: input.holdMinutes,

    /**
     * On hand, projected from the *inventory* ledger by the inventory service's own `project`.
     *
     * Deliberately not a second projection written here. Two functions that both compute stock
     * are two answers waiting to disagree, and the one that promises stock to a customer is not
     * the one you want drifting from the one that counts it.
     */
    onHand: async (tenantId, locationId) => {
      const movements = await allOf<Movement>(input.store, tenantId, STREAM.inventory, 'InventoryMoved');
      return new Map(
        project(movements, input.now())
          .filter((a) => a.locationId === locationId)
          .map((a) => [a.productId, a.onHandMinor] as const),
      );
    },

    /** Held and not yet lapsed. An expired hold is stock on the shelf, not stock spoken for. */
    outstanding: async (tenantId, locationId) => {
      const held = (await allOf<Reservation>(input.store, tenantId, STREAM.reservations, 'ReservationHeld'))
        .filter((r) => r.locationId === locationId);
      const lapsed = new Set(expired(held, input.now()).map((r) => r.reservationId));
      return held.filter((r) => !lapsed.has(r.reservationId));
    },

    holdReservations: async (tenantId, rs) => {
      for (const r of rs) {
        await input.store.append(tenantId, STREAM.reservations, makeEvent({
          id: `res-${r.reservationId}`,
          type: 'ReservationHeld',
          occurredAt: input.now(),
          idempotencyKey: `res-${tenantId}-${r.reservationId}`,
          source: 'api/orders',
          payload: r,
        }));
      }
    },
  };
}

export function fulfilmentAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FulfilmentDeps {
  return {
    now: input.now,

    appendAttempt: async (tenantId, a) => {
      await input.store.append(tenantId, STREAM.delivery, makeEvent({
        id: `att-${a.attemptId}`,
        type: 'DeliveryAttempted',
        occurredAt: a.attemptedAt,
        idempotencyKey: `att-${tenantId}-${a.attemptId}`,
        source: 'api/fulfilment',
        payload: a,
      }));
    },

    attempts: async (tenantId, driverId, runDate) =>
      (await allOf<DeliveryAttempt>(input.store, tenantId, STREAM.delivery, 'DeliveryAttempted'))
        .filter((a) => a.driverId === driverId && a.attemptedAt.slice(0, 10) === runDate),

    /**
     * What dispatch gave the driver. Nothing writes it yet (M20 route planning is not on this
     * surface), so it is empty — which is why `reconcileRun` now also reports attempts made
     * against orders that are *not* on the run. With only the assigned-minus-attempted check, an
     * empty run list made every run reconcile perfectly.
     */
    assigned: () => [],
  };
}
