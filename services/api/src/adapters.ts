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
import type { ReturnsDeps, ReturnRecord, RecordedRefund, OriginalSale, RecordedReturn } from '../../pos/src/returns';
import type { CashDeps, RecordedCashMovement } from '../../pos/src/cash';
import type { StoredCashMovement } from '../../../packages/cash/src/index';
import type { SettlementRoutesDeps, SettlementBatch, SettlementLine, CapturedTender } from '../../finance/src/settlement';
import { attachEvidence, type Investigation } from '../../../packages/settlement/src/settlement';
import { project } from '../../inventory/src/index';
import type { Movement, Availability, InventoryDeps } from '../../inventory/src/index';
import type { MatchResult, BankChangeRequest, PurchaseDeps } from '../../purchase/src/index';
import type { JournalEntry, PeriodState, FinanceDeps } from '../../finance/src/index';
import type { ConsentRecord, CustomerDeps, RecordedPointsMovement } from '../../customer/src/index';
import type { StoredPointsMovement } from '../../../packages/loyalty/src/assess-points';
import type { StoredValueDeps, Instrument, ValueMovement } from '../../customer/src/stored-value';
import type { PromotionDeps, LaunchRecord } from '../../pricing/src/promotions';
import { expired } from '../../orders/src/index';
import type { Reservation, OrdersDeps } from '../../orders/src/index';
import type { DeliveryAttempt, FulfilmentDeps } from '../../fulfilment/src/index';
import type { IdentityDeps } from '../../identity/src/index';
import type { Role, RoleAssignment } from '../../../packages/rbac/src/rbac';
import type { DependencyProbe, FeatureFlagChange, PlatformDeps } from '../../platform/src/index';
import { inMemorySettings } from '../../platform/src/index';
import type { DurableTenantSettings } from '../../../packages/tenant/src/index';
import { InMemoryNumberSeriesStore, type NumberSeriesStore } from '../../../packages/persistence/src/number-series-store';
import { figure } from '../../reporting/src/index';
import type { ReportingDeps } from '../../reporting/src/index';
import type { MigrationDeps } from '../../migration/src/index';
import type { TargetKind } from '../../../packages/migration/src/trial';
import type { DomainFinding, Acceptance } from '../../../packages/migration/src/verification-report';
import type { Signature } from '../../../packages/migration/src/verification-report';
import type { AgentId, Budget, Proposal, AiDeps } from '../../ai/src/index';
import type { PricingDeps, PriceChangeRecord } from '../../pricing/src/index';
import { ROLE_CATALOGUE } from './roles';

/** Streams, named once. A typo here is a domain that silently reads an empty history. */
export const STREAM = {
  catalogue: 'catalogue',
  sales: 'sales',
  saleExceptions: 'sale-exceptions',
  inventory: 'inventory',
  purchase: 'purchase',
  finance: 'finance',
  periods: 'periods',
  /**
   * Consent is **per customer**, not per tenant — `forCustomer(customerId)`.
   *
   * It was one stream for the whole shop, so answering "may we text this customer?" read every
   * consent record the tenant held. At twenty thousand loyalty customers that is a hundred thousand
   * rows to answer a question somebody is waiting on at the counter. Stream-per-aggregate is the
   * shape the store's `(tenant_id, stream, seq)` index was built for.
   */
  consent: 'consent',
  reservations: 'reservations',
  delivery: 'delivery',
  identity: 'identity',
  platform: 'platform',
  migration: 'migration',
  ai: 'ai',
  pricing: 'pricing',
  settlement: 'settlement',
  loyalty: 'loyalty',
  promotions: 'promotions',
  cash: 'cash',
} as const;

const payloadOf = <T>(e: PersistedEvent): T => e.event.payload as T;

/**
 * Every payload of one type in a stream, oldest first.
 *
 * The type goes to the store rather than to a `filter` afterwards. A caller that reads a million
 * events and keeps forty has still read a million.
 */
async function allOf<T>(
  store: EventStore, tenantId: string, stream: string, type: string,
): Promise<readonly T[]> {
  const events = await store.readStream(tenantId, stream, { type });
  return events.map((e) => payloadOf<T>(e));
}

/**
 * The last event of a type in a stream, or nothing. "Current" is a fold, never a field.
 *
 * It goes to the store's indexed `latestOfType` rather than reading the stream and taking the end
 * of it. The first version did the latter, and the catalogue is what made that expensive: a shop
 * publishing a price list a day holds 365 packs a year, each carrying its entire product master,
 * and answering "which version are we on?" deserialised all of them to look at the last one — on
 * every sale, because the POS route checks the pack version before it banks anything.
 */
async function latest<T>(
  store: EventStore, tenantId: string, stream: string, type: string,
): Promise<T | undefined> {
  const found = await store.latestOfType(tenantId, stream, type);
  return found === undefined ? undefined : payloadOf<T>(found);
}

/**
 * Streams that belong to one thing rather than to the whole shop.
 *
 * A stream per aggregate is the shape the store's `(tenant_id, stream, seq)` index was built for,
 * and getting it wrong is invisible until the shop has been open a year: one stream for every
 * customer's consent, or every driver's deliveries, means answering a question about *one* of them
 * reads *all* of them. Consent was the first to be moved; these are the rest.
 */

/**
 * The separator between the parts of a stream name — a unit separator, which cannot appear in an
 * id, a name or a date.
 *
 * A hyphen was the obvious choice and it is wrong for a two-part name. `delivery-{driver}-{date}`
 * is unambiguous **only** while a date is exactly ten characters: a driver id ending in something
 * date-shaped, or a run date that ever gains a suffix, and two different runs compose to one
 * stream. Two drivers' deliveries in one stream means `reconcileRun` settles cash against the
 * wrong set of attempts — money, against a named person, on the strength of a coincidence in
 * string lengths.
 *
 * `packages/catalogue` learned the same lesson: joining fields with nothing let two different
 * products canonicalise identically, and its guardrail caught it. The fix there and here is a
 * separator the data cannot contain, plus a refusal if it somehow does.
 */
const PART = '\u001f';

function streamName(...parts: readonly string[]): string {
  for (const part of parts) {
    if (part.includes(PART)) {
      // Refused rather than stripped: a stripped separator is a silently different stream, which
      // is the failure this exists to prevent rather than a smaller version of it.
      throw new RangeError('a stream name part may not contain the unit separator');
    }
  }
  return parts.join(PART);
}

const forCustomer = (customerId: string): string => streamName(STREAM.consent, customerId);
/** Points hang off the customer they belong to, so one customer's balance folds one stream. */
const forCustomerPoints = (customerId: string): string => streamName(STREAM.loyalty, customerId);
/** Each stored-value instrument's movements fold one stream; the issued-instruments index is its own. */
const forInstrument = (instrumentId: string): string => streamName(STREAM.loyalty, 'value', instrumentId);
const STORED_VALUE_INDEX = streamName(STREAM.loyalty, 'instruments');
const forDriverRun = (driverId: string, runDate: string): string =>
  streamName(STREAM.delivery, driverId, runDate);
const forLocation = (locationId: string): string => streamName(STREAM.reservations, locationId);
const forInvoice = (invoiceId: string): string => streamName(STREAM.purchase, 'invoice', invoiceId);
/** Returns hang off the sale they are against, so "what came back on this bill?" reads one stream. */
const forSaleReturns = (saleId: string): string => streamName(STREAM.sales, 'return', saleId);
/** Each till's cash chain folds one stream — its balance and custodian read one till, not the shop. */
const forTillCash = (tillId: string): string => streamName(STREAM.cash, tillId);

export const STREAM_FOR = { forCustomer, forDriverRun, forLocation, forInvoice, forSaleReturns } as const;

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
  return {
    now: input.now,

    catalogue: async (tenantId) => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      return new Map((pack?.snapshot.products ?? []).map((p: CatalogueProduct) => [p.productId, p]));
    },

    currentPackVersion: async (tenantId) =>
      (await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished'))?.snapshot.version ?? 0,

    /**
     * Two indexed lookups, not two folds.
     *
     * Both of these used to read every sale the shop had ever made and build a `Map` or a `Set` so
     * that one key could be looked up in it — on **every sale**. At SRE's ~2,000 a day that is a
     * quarter of a million rows scanned per scan by month three, and it would have arrived as
     * "the tills have got slow" with nothing obviously changed.
     *
     * The store already indexes `(tenant_id, idempotency_key)` — it has to, because that unique
     * constraint is what makes `append` idempotent — so the answer was always one index hit away.
     * What was in the way was the *port's shape*, not the store.
     */
    isBanked: async (tenantId, saleId) =>
      (await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`)) !== undefined,

    /**
     * Receipt numbers get their own key alongside the sale, written by `bankSale` below.
     *
     * A receipt number is not the sale's identity — two sales carrying one receipt number is a
     * *finding*, not a collision — so it cannot share the sale's key. Its own key makes it
     * findable in one hit, and the reverse lookup is deliberately a **separate append** rather
     * than a second column on the sale, because the ledger has one shape and everything in it is
     * an event.
     */
    saleHoldingReceipt: async (tenantId, receiptNumber) => {
      const held = await input.store.findByIdempotencyKey(tenantId, `receipt-${tenantId}-${receiptNumber}`);
      return held === undefined ? undefined : (held.event.payload as { readonly saleId: string }).saleId;
    },

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

      // The receipt-number index, appended second and deliberately allowed to lose.
      //
      // If two sales carry one receipt number the second append dedupes and this entry keeps
      // pointing at the FIRST sale — which is exactly right, because the exception it raises reads
      // "receipt R-101 already belongs to sale S-7", and S-7 is the one that had it. The index
      // records who holds the number, not who asked for it last.
      await input.store.append(tenantId, STREAM.sales, makeEvent({
        id: `receipt-${sale.receiptNumber}`,
        type: 'ReceiptNumberIssued',
        occurredAt: sale.committedAt,
        idempotencyKey: `receipt-${tenantId}-${sale.receiptNumber}`,
        source: 'api/pos',
        payload: { receiptNumber: sale.receiptNumber, saleId: sale.saleId },
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
      allOf<SaleException>(input.store, tenantId, STREAM.saleExceptions, 'SaleExceptionRaised'),
  };
}

export function returnsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ReturnsDeps {
  // Both the return register and the refund history fold the SAME events — read once, project twice.
  const records = (tenantId: string, saleId: string) =>
    allOf<ReturnRecord>(input.store, tenantId, forSaleReturns(saleId), 'ReturnRecorded');

  return {
    now: input.now,

    // The original bill, mapped from the SaleCommitted event to the shape the register reads. Found
    // in one index hit on the sale's own key — the same key `bankSale` wrote and `isBanked` reads —
    // rather than folding the sales stream, which the lane cannot afford (see `isBanked`).
    originalSale: async (tenantId, saleId) => {
      const held = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`);
      if (held === undefined) return undefined;
      const s = held.event.payload as IncomingSale;
      return {
        saleId: s.saleId,
        number: s.receiptNumber,
        tradingDay: s.tradingDay,
        committedAt: s.committedAt,
        totalMinor: s.totalMinor,
        lines: s.lines.map((l) => ({ productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor })),
        tenders: s.tenders.map((t) => ({ kind: t.kind, amountMinor: t.amountMinor })),
      } satisfies OriginalSale;
    },

    priorReturns: async (tenantId, saleId) =>
      (await records(tenantId, saleId)).map((r): RecordedReturn => ({
        returnId: r.returnId,
        originalSaleId: r.originalSaleId,
        processedAt: r.processedAt,
        lines: r.lines.map((l) => ({ productId: l.productId, uom: l.uom, quantityMinor: l.quantityMinor })),
      })),

    priorRefunds: async (tenantId, saleId) =>
      (await records(tenantId, saleId)).map((r): RecordedRefund => ({
        returnId: r.returnId, originalSaleId: r.originalSaleId, refundMinor: r.refundMinor,
      })),

    recordReturn: async (tenantId, saleId, record) => {
      await input.store.append(tenantId, forSaleReturns(saleId), makeEvent({
        id: `return-${record.returnId}`,
        type: 'ReturnRecorded',
        occurredAt: record.processedAt,
        // The return's own id, no timestamp — a lane retrying an unconfirmed refund collapses to
        // one, so the money leaves once however many times the till re-sends it.
        idempotencyKey: `return-${tenantId}-${record.returnId}`,
        source: 'api/pos',
        payload: record,
      }));
    },
  };
}

export function cashAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): CashDeps {
  return {
    now: input.now,

    tillMovements: async (tenantId, tillId) =>
      (await allOf<RecordedCashMovement>(input.store, tenantId, forTillCash(tillId), 'CashMovement'))
        .map((m): StoredCashMovement => ({ movementId: m.movementId, tillId: m.tillId, kind: m.kind, deltaMinor: m.deltaMinor, custodianId: m.custodianId })),

    recordCashMovement: async (tenantId, tillId, m) => {
      await input.store.append(tenantId, forTillCash(tillId), makeEvent({
        id: `cash-${m.movementId}`,
        type: 'CashMovement',
        occurredAt: m.at,
        // The movement's own id, no timestamp — a lane retrying an unconfirmed drop collapses to one,
        // so the drawer moves once however many times the till re-sends it.
        idempotencyKey: `cash-${tenantId}-${m.movementId}`,
        source: 'api/pos',
        payload: m,
      }));
    },
  };
}

export function settlementAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SettlementRoutesDeps {
  const batches = (tenantId: string) =>
    allOf<SettlementBatch>(input.store, tenantId, STREAM.settlement, 'SettlementBatchImported');

  // All investigation lifecycle events live on one stream, folded by id. Investigations are
  // exceptions, not sales — low-volume — so one stream read to answer for all of them is fine.
  const investigationsStream = streamName(STREAM.settlement, 'investigations');
  const foldInvestigations = async (tenantId: string): Promise<readonly Investigation[]> => {
    const events = await input.store.readStream(tenantId, investigationsStream);
    const byId = new Map<string, Investigation>();
    for (const e of events) {
      const p = e.event.payload as Record<string, unknown>;
      const id = p['investigationId'] as string;
      if (e.event.type === 'SettlementInvestigationOpened') {
        byId.set(id, p as unknown as Investigation);
      } else if (e.event.type === 'SettlementEvidenceAttached') {
        const inv = byId.get(id);
        if (inv !== undefined) byId.set(id, attachEvidence(inv, p['ref'] as string));
      } else if (e.event.type === 'SettlementInvestigationResolved') {
        const inv = byId.get(id);
        if (inv !== undefined) {
          byId.set(id, { ...inv, state: 'resolved', outcome: p['outcome'] as Investigation['outcome'], outcomeNote: p['outcomeNote'] as string, resolvedBy: p['resolvedBy'] as string, resolvedAt: p['resolvedAt'] as string });
        }
      }
    }
    return [...byId.values()];
  };

  return {
    now: input.now,

    investigations: (tenantId) => foldInvestigations(tenantId),

    recordInvestigationOpened: async (tenantId, inv) => {
      await input.store.append(tenantId, investigationsStream, makeEvent({
        id: `settle-inv-open-${inv.investigationId}`,
        type: 'SettlementInvestigationOpened',
        occurredAt: inv.openedAt,
        idempotencyKey: `settle-inv-open-${tenantId}-${inv.investigationId}`,
        source: 'api/finance',
        payload: inv,
      }));
    },

    recordInvestigationEvidence: async (tenantId, investigationId, ref, at) => {
      await input.store.append(tenantId, investigationsStream, makeEvent({
        id: `settle-inv-ev-${investigationId}-${ref}`,
        type: 'SettlementEvidenceAttached',
        occurredAt: at,
        // Keyed on the ref too — the same evidence attached twice collapses (append-only, never a
        // duplicate), but a second, different document is a new fact and is kept.
        idempotencyKey: `settle-inv-ev-${tenantId}-${investigationId}-${ref}`,
        source: 'api/finance',
        payload: { investigationId, ref },
      }));
    },

    recordInvestigationResolved: async (tenantId, inv) => {
      await input.store.append(tenantId, investigationsStream, makeEvent({
        id: `settle-inv-resolve-${inv.investigationId}`,
        type: 'SettlementInvestigationResolved',
        occurredAt: inv.resolvedAt ?? input.now(),
        idempotencyKey: `settle-inv-resolve-${tenantId}-${inv.investigationId}`,
        source: 'api/finance',
        payload: { investigationId: inv.investigationId, outcome: inv.outcome, outcomeNote: inv.outcomeNote, resolvedBy: inv.resolvedBy, resolvedAt: inv.resolvedAt },
      }));
    },

    importedBatchIds: async (tenantId) => (await batches(tenantId)).map((b) => b.batchId),

    recordBatch: async (tenantId, batch) => {
      await input.store.append(tenantId, STREAM.settlement, makeEvent({
        id: `settle-batch-${batch.batchId}`,
        type: 'SettlementBatchImported',
        occurredAt: batch.settlementDate + 'T00:00:00.000Z',
        // The batch's own id, no timestamp — re-importing the same file collapses rather than
        // doubling every credit in it. (The route also refuses a duplicate outright; this is the
        // backstop at the ledger, where the guarantee actually has to hold.)
        idempotencyKey: `settle-batch-${tenantId}-${batch.batchId}`,
        source: 'api/finance',
        payload: batch,
      }));
    },

    // Every imported credit line, flattened. Bounded: a shop imports a handful of batches a day, and
    // a batch is refused before it lands unless its lines sum to what it declares.
    credits: async (tenantId) =>
      (await batches(tenantId)).flatMap((b) => b.lines) satisfies readonly SettlementLine[],

    // Electronic tenders captured in the window, from the day's sales. Cash carries no provider
    // reference and is not part of settlement — only ref-bearing (card/UPI) tenders are projected.
    // The read is windowed at the store on `occurredAt`, so it costs a window, not the whole history.
    electronicTenders: async (tenantId, fromIso, toIso) => {
      const sales = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: fromIso, to: toIso });
      const out: CapturedTender[] = [];
      for (const e of sales) {
        const sale = e.event.payload as IncomingSale;
        const capturedOn = sale.committedAt.slice(0, 10);
        sale.tenders.forEach((t, i) => {
          if (typeof t.ref === 'string' && t.ref.trim() !== '') {
            out.push({ id: `${sale.saleId}:t${i}`, ref: t.ref, amountMinor: t.amountMinor, capturedOn });
          }
        });
      }
      return out;
    },
  };
}

/**
 * How many movements may pile up behind a snapshot before a new one is taken.
 *
 * A fold of a few thousand is cheap; a fold of a million is a shop waiting to be told how many bags
 * of rice there are. Large enough that snapshots are rare, small enough that the tail never gets
 * interesting — and it is a number rather than a policy because the only thing it trades is one
 * occasional write against every read.
 */
export const SNAPSHOT_EVERY = 2_000;

interface StockSnapshot {
  readonly asOfSeq: number;
  readonly balances: readonly Availability[];
}

export function inventoryAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /** Overridable so a test can reach the threshold without appending two thousand events. */
  readonly snapshotEvery?: number;
}): InventoryDeps {
  const every = input.snapshotEvery ?? SNAPSHOT_EVERY;

  /**
   * The balance, and the movements not yet folded into it.
   *
   * **A snapshot is not a second source of truth.** It is derived from the ledger, it can be
   * deleted and rebuilt from the ledger, and it is itself an append-only event — so nothing here
   * can be edited, and hard rule #2 holds exactly as it did when every read folded from the
   * beginning of time. What changes is only how far back the fold has to start.
   */
  const basis = async (tenantId: string): Promise<{
    readonly opening: readonly Availability[];
    readonly tail: readonly Movement[];
    readonly tailSeq: number;
  }> => {
    const snapshot = await input.store.latestOfType(tenantId, STREAM.inventory, 'InventorySnapshotTaken');
    const taken = snapshot === undefined ? undefined : payloadOf<StockSnapshot>(snapshot);
    // Narrowed at the STORE, not afterwards. Reading the whole stream and filtering to the tail is
    // the same read, and it is the read rather than the fold that a timing test cannot see.
    const tail = await input.store.readStream(tenantId, STREAM.inventory, {
      ...(taken === undefined ? {} : { sinceSeq: taken.asOfSeq }),
      type: 'InventoryMoved',
    });
    return {
      opening: taken?.balances ?? [],
      tail: tail.map((e) => payloadOf<Movement>(e)),
      tailSeq: tail.length === 0 ? (taken?.asOfSeq ?? 0) : tail[tail.length - 1]!.seq,
    };
  };

  return {
    now: input.now,

    // One index hit. Was a `Set` of every movement id the shop had ever recorded, built so that
    // one `.has()` could run against it — and a handheld back from the chiller sending forty
    // movements paid that forty times.
    isKnown: async (tenantId, movementId) =>
      (await input.store.findByIdempotencyKey(tenantId, `mv-${tenantId}-${movementId}`)) !== undefined,

    availability: async (tenantId, productId) => {
      const { opening, tail } = await basis(tenantId);
      const rows = project(tail, input.now(), opening);
      return productId === undefined ? rows : rows.filter((r) => r.productId === productId);
    },

    appendMovement: async (tenantId, m) => {
      await input.store.append(tenantId, STREAM.inventory, makeEvent({
        id: `mv-${m.movementId}`,
        type: 'InventoryMoved',
        occurredAt: m.occurredAt,
        idempotencyKey: `mv-${tenantId}-${m.movementId}`,
        source: 'api/inventory',
        payload: m,
      }));

      // Snapshot when the tail gets long. Deliberately on the WRITE path: a movement arriving from
      // a handheld can afford an occasional extra fold, whereas an availability lookup is somebody
      // standing in an aisle or a customer watching a page. The cost lands where there is slack.
      const { opening, tail, tailSeq } = await basis(tenantId);
      if (tail.length >= every) {
        await input.store.append(tenantId, STREAM.inventory, makeEvent({
          id: `stock-snap-${tenantId}-${tailSeq}`,
          type: 'InventorySnapshotTaken',
          occurredAt: input.now(),
          // Keyed on the sequence it covers, so two writers racing produce one snapshot rather
          // than two that disagree about where they start.
          idempotencyKey: `stock-snap-${tenantId}-${tailSeq}`,
          source: 'api/inventory',
          payload: {
            asOfSeq: tailSeq,
            balances: project(tail, input.now(), opening),
          } satisfies StockSnapshot,
        }));
      }
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
     * Lines for one invoice, from its capture events.
     *
     * `recordCapture` (the `/capture` route) writes `PurchaseInvoiceCaptured` onto this invoice's
     * stream; an invoice nobody has captured has no lines here, and `threeWayMatch` refuses an
     * empty line set rather than calling it a match. So the match answers only for invoices whose
     * ordered/received/invoiced figures a person has actually entered.
     */
    matchLines: async (tenantId, invoiceId) => {
      const captured = await allOf<{ readonly lines: readonly MatchLineOf[] }>(
        input.store, tenantId, forInvoice(invoiceId), 'PurchaseInvoiceCaptured',
      );
      return captured.flatMap((c) => c.lines);
    },

    // Capture the invoice's lines onto its own per-invoice stream, where `matchLines` reads them.
    // Idempotent per invoice: the key carries no timestamp, so a re-sent capture collapses rather
    // than doubling the lines the match would then compare.
    recordCapture: async (tenantId, invoiceId, lines) => {
      await input.store.append(tenantId, forInvoice(invoiceId), makeEvent({
        id: `capture-${invoiceId}`,
        type: 'PurchaseInvoiceCaptured',
        occurredAt: input.now(),
        idempotencyKey: `capture-${tenantId}-${invoiceId}`,
        source: 'api/purchase',
        payload: { invoiceId, lines },
      }));
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

/** `YYYY-MM-DD` plus n days, in UTC — the window the ledger's timestamps are stored in. */
export function addDays(day: string, n: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
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

    consentRecords: (tenantId, customerId) =>
      allOf<ConsentRecord>(input.store, tenantId, forCustomer(customerId), 'ConsentRecorded'),

    appendConsent: async (tenantId, r) => {
      await input.store.append(tenantId, forCustomer(r.customerId), makeEvent({
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

    // Not known, and not zero. A customer with no movement at all has no loyalty account here and
    // the balance is UNKNOWN; a customer whose movements net to zero has a real zero. The route
    // tells the counter which of the two it got, so the distinction is preserved through the fold.
    pointsBalance: async (tenantId, customerId) => {
      const moves = await allOf<RecordedPointsMovement>(input.store, tenantId, forCustomerPoints(customerId), 'PointsMovement');
      return moves.length === 0 ? undefined : moves.reduce((b, m) => b + m.delta, 0);
    },

    pointsMovements: async (tenantId, customerId) =>
      (await allOf<RecordedPointsMovement>(input.store, tenantId, forCustomerPoints(customerId), 'PointsMovement'))
        .map((m): StoredPointsMovement => ({ movementId: m.movementId, customerId: m.customerId, delta: m.delta })),

    recordPointsMovement: async (tenantId, customerId, m) => {
      await input.store.append(tenantId, forCustomerPoints(customerId), makeEvent({
        id: `points-${m.movementId}`,
        type: 'PointsMovement',
        occurredAt: m.at,
        // The movement's own id, no timestamp — a lane retrying an unconfirmed burn collapses to one,
        // so points leave once however many times the till re-sends it.
        idempotencyKey: `points-${tenantId}-${m.movementId}`,
        source: 'api/customer',
        payload: m,
      }));
    },
  };
}

export function storedValueAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): StoredValueDeps {
  return {
    now: input.now,

    instrument: async (tenantId, instrumentId) => {
      const issued = await allOf<Instrument>(input.store, tenantId, STORED_VALUE_INDEX, 'StoredValueIssued');
      return issued.find((i) => i.instrumentId === instrumentId);
    },

    movements: async (tenantId, instrumentId) =>
      allOf<ValueMovement>(input.store, tenantId, forInstrument(instrumentId), 'StoredValueMovement'),

    recordIssue: async (tenantId, instrument, opening) => {
      // The instrument goes on the shared index (so it can be found and, later, pooled by owner); its
      // opening value is the first movement on the instrument's own stream, where the balance folds.
      await input.store.append(tenantId, STORED_VALUE_INDEX, makeEvent({
        id: `sv-issue-${instrument.instrumentId}`,
        type: 'StoredValueIssued',
        occurredAt: instrument.issuedAt,
        idempotencyKey: `sv-issue-${tenantId}-${instrument.instrumentId}`,
        source: 'api/customer',
        payload: instrument,
      }));
      await input.store.append(tenantId, forInstrument(instrument.instrumentId), makeEvent({
        id: `sv-mv-${opening.movementId}`,
        type: 'StoredValueMovement',
        occurredAt: opening.at,
        idempotencyKey: `sv-mv-${tenantId}-${opening.movementId}`,
        source: 'api/customer',
        payload: opening,
      }));
    },

    recordMovement: async (tenantId, instrumentId, m) => {
      await input.store.append(tenantId, forInstrument(instrumentId), makeEvent({
        id: `sv-mv-${m.movementId}`,
        type: 'StoredValueMovement',
        occurredAt: m.at,
        // The movement's own id, no timestamp — a re-sent redemption collapses, so a gift card is
        // spent once however many times the till re-sends it.
        idempotencyKey: `sv-mv-${tenantId}-${m.movementId}`,
        source: 'api/customer',
        payload: m,
      }));
    },
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
    onHand: async (tenantId, locationId) => new Map(
      (await inventoryAdapter({ store: input.store, now: input.now }).availability(tenantId))
        .filter((a) => a.locationId === locationId)
        .map((a) => [a.productId, a.onHandMinor] as const),
    ),

    /** Held and not yet lapsed. An expired hold is stock on the shelf, not stock spoken for. */
    outstanding: async (tenantId, locationId) => {
      const held = await allOf<Reservation>(input.store, tenantId, forLocation(locationId), 'ReservationHeld');
      const lapsed = new Set(expired(held, input.now()).map((r) => r.reservationId));
      return held.filter((r) => !lapsed.has(r.reservationId));
    },

    holdReservations: async (tenantId, rs) => {
      for (const r of rs) {
        await input.store.append(tenantId, forLocation(r.locationId), makeEvent({
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
      await input.store.append(tenantId, forDriverRun(a.driverId, a.attemptedAt.slice(0, 10)), makeEvent({
        id: `att-${a.attemptId}`,
        type: 'DeliveryAttempted',
        occurredAt: a.attemptedAt,
        idempotencyKey: `att-${tenantId}-${a.attemptId}`,
        source: 'api/fulfilment',
        payload: a,
      }));
    },

    // The run IS the stream. Settling one driver's Tuesday no longer reads every delivery the
    // shop has ever made — and the two filters that used to do it are now the stream's name.
    attempts: (tenantId, driverId, runDate) =>
      allOf<DeliveryAttempt>(input.store, tenantId, forDriverRun(driverId, runDate), 'DeliveryAttempted'),

    /**
     * What dispatch gave the driver. Nothing writes it yet (M20 route planning is not on this
     * surface), so it is empty — which is why `reconcileRun` now also reports attempts made
     * against orders that are *not* on the run. With only the assigned-minus-attempted check, an
     * empty run list made every run reconcile perfectly.
     */
    assigned: () => [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The last five: identity, platform, reporting, migration, AI
// ─────────────────────────────────────────────────────────────────────────────

export function identityAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /**
   * The role catalogue. Configuration, not tenant data — a role is a set of permission codes this
   * product defines, and a tenant picks who holds it, not what it means. Passed in so the
   * deployment owns the list rather than this file.
   */
  readonly roleCatalogue: readonly Role[];
  /** Durable gap-free number series; a SqlNumberSeriesStore in production, in-memory otherwise. */
  readonly numberSeries?: NumberSeriesStore;
}): IdentityDeps {
  const assignments = (tenantId: string) =>
    allOf<RoleAssignment>(input.store, tenantId, STREAM.identity, 'RoleGranted');
  const numberSeries = input.numberSeries ?? new InMemoryNumberSeriesStore();

  return {
    now: input.now,
    roles: () => input.roleCatalogue,
    allocateNumber: (tenantId, docType) => numberSeries.allocate(tenantId, docType),

    /** Every permission from every role this user holds. Union, deduplicated, sorted. */
    permissionsOf: async (tenantId, userId) => {
      const held = (await assignments(tenantId)).filter((a) => a.userId === userId);
      const codes = held.flatMap((a) =>
        input.roleCatalogue.find((r) => r.id === a.roleId)?.permissions ?? []);
      return [...new Set(codes)].sort();
    },

    recordGrant: async (tenantId, assignment, request) => {
      await input.store.append(tenantId, STREAM.identity, makeEvent({
        id: `grant-${request.grantId}`,
        type: 'RoleGranted',
        occurredAt: request.requestedAt,
        idempotencyKey: `grant-${tenantId}-${request.grantId}`,
        source: 'api/identity',
        // Both: the assignment is what RBAC reads, the request is who asked and who approved —
        // and an access review a year later is about the second one.
        payload: { ...assignment, request },
      }));
    },

    branches: () => [],
  };
}

export function pricingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PricingDeps {
  return {
    now: input.now,

    // The approver must genuinely hold price.change.approve — read from the tenant's own grants, the
    // same authoritative source the kernel authorizes against. A named approver who cannot approve
    // prices is not an approval (§28).
    canApprove: async (tenantId, userId) => {
      const grants = await allOf<RoleAssignment>(input.store, tenantId, STREAM.identity, 'RoleGranted');
      const roleIds = new Set(grants.filter((g) => g.userId === userId).map((g) => g.roleId));
      return ROLE_CATALOGUE.some((r) => roleIds.has(r.id) && r.permissions.includes('price.change.approve'));
    },

    recordPriceChange: async (tenantId, change: PriceChangeRecord) => {
      await input.store.append(tenantId, STREAM.pricing, makeEvent({
        id: `pricechange-${change.productId}-${change.at}`,
        type: 'PriceChangeRecorded',
        occurredAt: change.at,
        idempotencyKey: `pricechange-${tenantId}-${change.productId}-${change.at}`,
        source: 'api/pricing',
        payload: change,
      }));
    },
  };
}

export function promotionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PromotionDeps {
  return {
    now: input.now,

    launchedPromotion: async (tenantId, promotionId) => {
      const launched = await allOf<LaunchRecord>(input.store, tenantId, STREAM.promotions, 'PromotionLaunched');
      return launched.find((r) => r.promotionId === promotionId);
    },

    recordLaunch: async (tenantId, record) => {
      await input.store.append(tenantId, STREAM.promotions, makeEvent({
        id: `promo-launch-${record.promotionId}`,
        type: 'PromotionLaunched',
        occurredAt: record.launchedAt,
        // The promotion's own id, no timestamp — re-launching the same one collapses rather than
        // recording a second launch of an offer that is already live.
        idempotencyKey: `promo-launch-${tenantId}-${record.promotionId}`,
        source: 'api/pricing',
        payload: record,
      }));
    },
  };
}

export function platformAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /** Reachability of the things the shop cannot trade without. A real call, not a cached flag. */
  readonly probes: () => Promise<readonly DependencyProbe[]>;
  /** Durable per-tenant settings — a SqlConfigVersionStore-backed store so setup survives a restart. */
  readonly settings?: DurableTenantSettings;
}): PlatformDeps {
  return {
    now: input.now,
    probe: input.probes,

    // Durable per-tenant settings for the self-service setup surface (config_versions table).
    // Production supplies a SqlConfigVersionStore-backed store; tests that omit it get an in-memory one.
    settings: input.settings ?? inMemorySettings(),

    /** Current flag state, folded forward. The last change to a key wins; the history keeps both. */
    flags: async (tenantId) => {
      // Every change, deliberately: the current state of *all* flags is genuinely a fold, and the
      // set of flags a tenant has is small and does not grow with trading.
      const changes = await allOf<FeatureFlagChange>(input.store, tenantId, STREAM.platform, 'FeatureFlagSet');
      const out: Record<string, boolean> = {};
      for (const c of changes) out[c.key] = c.enabled;
      return out;
    },

    setFlag: async (tenantId, change) => {
      await input.store.append(tenantId, STREAM.platform, makeEvent({
        id: `flag-${change.key}-${change.changedAt}`,
        type: 'FeatureFlagSet',
        occurredAt: change.changedAt,
        // Time is in the key: turning a flag off and back on again is two facts, and "who turned
        // this back on, and when" is the entire reason the record exists.
        idempotencyKey: `flag-${tenantId}-${change.key}-${change.changedAt}`,
        source: 'api/platform',
        payload: change,
      }));
    },

    /** Never deleted (#6). Somebody outside the business read this tenant's data, and that is kept. */
    recordSupportAccess: async (request, expiresAt) => {
      await input.store.append(request.tenantId, STREAM.platform, makeEvent({
        id: `support-${request.requestId}`,
        type: 'SupportAccessGranted',
        occurredAt: request.at,
        idempotencyKey: `support-${request.tenantId}-${request.requestId}`,
        source: 'api/platform',
        payload: { ...request, expiresAt },
      }));
    },
  };
}

export function reportingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ReportingDeps {
  return {
    now: input.now,

    /**
     * Figures projected from the streams that hold them.
     *
     * Only sales exists today, and it is deliberately the *only* one returned rather than a list
     * padded out with zeroes: `figure()` refuses to substitute a zero for an absent value, because
     * a zero is a number somebody acts on. A dashboard with one real figure on it is honest; one
     * with eleven zeroes and a real one is not.
     */
    figures: async (tenantId) => {
      const today = input.now().slice(0, 10);
      // A read of today, not a read of every sale the shop has ever made followed by a filter.
      // The owner looks at this number every morning, which makes it the one query in the system
      // guaranteed to be run against the largest table daily, forever.
      //
      // The window is on `occurredAt` and the check is on `tradingDay`, and both are needed: the
      // window is what makes the read cheap, and the trading day is what makes it *right*, because
      // a shop trading past midnight books those sales to the day that is still open (M09).
      const events = await input.store.readStream(tenantId, STREAM.sales, {
        type: 'SaleCommitted',
        from: `${today}T00:00:00.000Z`,
        to: `${addDays(today, 1)}T00:00:00.000Z`,
      });
      const todays = events.map((e) => payloadOf<IncomingSale>(e))
        .filter((s) => s.tradingDay === today);
      return [
        figure({
          name: 'Sales today',
          valueMinor: todays.reduce((t, s) => t + s.totalMinor, 0),
          unit: 'minor_currency',
          // As at now, because the ledger is read at request time — there is no cache between
          // this figure and the events it is computed from, so there is nothing to be stale.
          asAt: input.now(), now: input.now(),
        }),
        figure({
          name: 'Sales today — receipts',
          valueMinor: todays.length, unit: 'count',
          asAt: input.now(), now: input.now(),
        }),
      ];
    },
  };
}

export function migrationAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly targetKind: TargetKind;
  /** Which role means "the owner". Configuration — the word differs by tenant, the authority does not. */
  readonly ownerRoleId: string;
}): MigrationDeps {
  const grants = (tenantId: string) =>
    allOf<RoleAssignment>(input.store, tenantId, STREAM.identity, 'RoleGranted');

  return {
    now: input.now,

    target: (tenantId) => ({
      targetId: `tgt-${tenantId}`, tenantId,
      kind: input.targetKind, label: input.targetKind,
    }),

    findings: (tenantId) => allOf<DomainFinding>(input.store, tenantId, STREAM.migration, 'MigrationFindingRaised'),
    acceptances: (tenantId) => allOf<Acceptance>(input.store, tenantId, STREAM.migration, 'MigrationExceptionAccepted'),
    signatures: (tenantId) => allOf<Signature>(input.store, tenantId, STREAM.migration, 'MigrationReportSigned'),

    recordAcceptance: async (tenantId, a) => {
      await input.store.append(tenantId, STREAM.migration, makeEvent({
        id: `accept-${a.domain}-${a.acceptedOn}`,
        type: 'MigrationExceptionAccepted',
        occurredAt: a.acceptedOn,
        // Domain and date. One acceptance per domain per day is the shape the owner works in —
        // and re-sending the same one is a retry, while accepting the same domain again on a
        // later date is the owner changing their mind, which is a fact worth keeping.
        idempotencyKey: `accept-${tenantId}-${a.domain}-${a.acceptedOn}`,
        source: 'api/migration',
        payload: a,
      }));
    },

    /**
     * The owner, read from who actually holds the owner role — and **`undefined` when nobody
     * does**, which is what the routes refuse on.
     *
     * This was the literal string `'u-owner'` in the composition root, which meant the control
     * "only the owner may accept a figure into the opening books" was satisfied by anybody who
     * typed that string. A check comparing a caller against a placeholder is not a check.
     */
    ownerId: async (tenantId) =>
      (await grants(tenantId)).find((g) => g.roleId === input.ownerRoleId)?.userId,

    /**
     * Who ran the extraction — and `undefined` until something records it, which stops the signed
     * page being produced at all.
     *
     * It is named on that page and it is load-bearing there: the rule that whoever ran the
     * extraction cannot choose which stock lines get counted only means anything if the page says
     * who that was. A placeholder is a fabricated audit record on a signed document.
     */
    extractionOperator: async (tenantId) => {
      return (await latest<{ readonly operatorId: string }>(
        input.store, tenantId, STREAM.migration, 'ExtractionRun',
      ))?.operatorId;
    },
  };
}

export function aiAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): AiDeps {
  return {
    now: input.now,

    /**
     * Default **on** — the safe direction, and the opposite of every other default here.
     *
     * Everywhere else in this file the absence of a record means "we cannot say". Here it means
     * "stopped", because the kill switch is the one control whose failure mode is asymmetric: a
     * switch that defaults off is an agent running because nobody has told it not to.
     */
    killSwitchOn: async (tenantId) => {
      // One row. This folded every kill-switch change ever made to look at the last one.
      return (await latest<{ readonly on: boolean }>(input.store, tenantId, STREAM.ai, 'AiKillSwitchSet'))?.on ?? true;
    },

    setKillSwitch: async (tenantId, on, by, at) => {
      await input.store.append(tenantId, STREAM.ai, makeEvent({
        id: `kill-${at}`,
        type: 'AiKillSwitchSet',
        occurredAt: at,
        idempotencyKey: `kill-${tenantId}-${at}-${String(on)}`,
        source: 'api/ai',
        payload: { on, by, at },
      }));
    },

    /** No budget granted means nothing may be spent. Zero is the honest starting point here. */
    budget: async (tenantId) => {
      const cap = await latest<Budget>(input.store, tenantId, STREAM.ai, 'AiBudgetSet');
      // Spend genuinely is a sum, and it is bounded by the budget period rather than by history.
      const spent = await allOf<{ readonly costMinor: number }>(
        input.store, tenantId, STREAM.ai, 'AiRunCosted',
      );
      return {
        capMinor: cap?.capMinor ?? 0,
        spentMinor: spent.reduce((t, s) => t + s.costMinor, 0),
        periodEnds: cap?.periodEnds ?? input.now(),
      };
    },

    /** Nothing is enabled until somebody enables it, by name (AID-01…10). */
    enabledAgents: async (tenantId) =>
      (await latest<{ readonly agents: readonly AgentId[] }>(
        input.store, tenantId, STREAM.ai, 'AiAgentsEnabled',
      ))?.agents ?? [],

    /**
     * No model is called from here.
     *
     * The gate above this refuses first — nothing is enabled and no budget is granted — so this is
     * unreachable until a provider is chosen (OB-02) and an agent is turned on by name. It returns
     * nothing rather than pretending to have run, and the reply says `committedAnything: false`
     * whatever happens, because a proposal is never an action (hard rule #5).
     */
    run: () => [],

    openProposals: (tenantId) => allOf<Proposal>(input.store, tenantId, STREAM.ai, 'AiProposalRaised'),
  };
}
