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

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { Money } from '../../../packages/contracts/src/money';
import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
import type { SignedPack } from '../../catalogue/src/index';
import type { CatalogueDeps } from '../../catalogue/src/index';
import type { IncomingSale, SaleException, PosDeps } from '../../pos/src/index';
import type { ReturnsDeps, ReturnRecord, RecordedRefund, OriginalSale, RecordedReturn } from '../../pos/src/returns';
import type { CashDeps, RecordedCashMovement } from '../../pos/src/cash';
import type { StoredCashMovement } from '../../../packages/cash/src/index';
import type { ShiftDeps, ClosedShiftRecord } from '../../pos/src/shift';
import type { B2BCreditDeps, B2BAccount, RecordedReceivable } from '../../finance/src/b2b-credit';
import type { B2BCollectionsDeps, Receivable as CollectionsReceivable, RecordedPayment } from '../../finance/src/b2b-collections';
import type { B2BCommissionDeps, CommissionAccrual } from '../../finance/src/b2b-commission';
import type { B2BDocumentsDeps, StoredB2BDocument } from '../../finance/src/b2b-documents';
import { checkCredit } from '../../../packages/b2b/src/credit';
import type { LpCasesDeps, LpRulesDeps } from '../../pos/src/loss-prevention';
import type { InvestigationCase, EvidenceItem } from '../../../packages/loss-prevention/src/cases';
import type { LpRule } from '../../../packages/loss-prevention/src/loss-prevention';
import type { FraudSignalsDeps } from '../../pos/src/fraud-signals';
import type { FraudThresholds } from '../../../packages/loss-prevention/src/fraud-signals';
import type { WarehouseDeps } from '../../inventory/src/warehouse';
import type { Bin, BinContents } from '../../../packages/warehouse/src/movements';
import { binKey } from '../../../packages/warehouse/src/movements';
import type { StockMovement } from '../../../packages/stock/src/position';
import type { TransfersDeps } from '../../inventory/src/warehouse-transfers';
import type { Transfer } from '../../../packages/warehouse/src/transfers';
import type { CountsDeps, StoredReconciliation } from '../../inventory/src/counts';
import type { ProductionDeps, StoredRun, StoredRelease } from '../../inventory/src/production';
import type { Recipe } from '../../../packages/production/src/recipe';
import type { SupplierPortalDeps, PartnerConfig, SubmissionRecord, StatementLine } from '../../purchase/src/supplier-portal';
import type { ConcessionDeps, ConcessionContract, ConcessionSale } from '../../finance/src/concession';
import type { ScrapDeps, ScrapSale } from '../../finance/src/scrap';
import type { FacilitiesDeps, MaintenanceSchedule, ScheduledTask, SafetyIncident } from '../../platform/src/facilities';
import type { FacilitiesAssetsDeps, Asset, ServiceLog, DowntimeEvent, EnergyReading } from '../../platform/src/facilities-assets';
import type { FacilitiesMonitoringDeps, EquipmentRangeReg, EquipmentContents, EquipmentReading, PowerEvent } from '../../platform/src/facilities-monitoring';
import type { PackagingDeps, PackagingItem, PackagingMovement } from '../../inventory/src/packaging';
import type { WasteDeps, WasteRecord, WasteCoverage } from '../../inventory/src/waste';
import type { IntegrationDeps, CertifiedEntry, AdapterConfig, AdapterHeartbeat } from '../../platform/src/integration';
import type { WebhookDeps, WebhookConfig } from '../../platform/src/webhooks';
import type { ConnectorMappingDeps, Mapping } from '../../platform/src/connectors';
import type { Hasher } from '../../../packages/audit/src/audit-trail';
import type { SettlementRoutesDeps, SettlementBatch, SettlementLine, CapturedTender } from '../../finance/src/settlement';
import { attachEvidence, type Investigation } from '../../../packages/settlement/src/settlement';
import { project, EFFECT_ON_HAND } from '../../inventory/src/index';
import type { Movement, Availability, InventoryDeps } from '../../inventory/src/index';
import { weightedAverageValuation, type ValuationMovement } from '../../../packages/stock/src/valuation';
import { agedStockLots, type DatedMovement } from '../../../packages/stock/src/ageing-source';
import type { MatchResult, BankChangeRequest, PurchaseDeps } from '../../purchase/src/index';
import type { JournalEntry, PeriodState, FinanceDeps } from '../../finance/src/index';
import type { ConsentRecord, CustomerDeps, RecordedPointsMovement } from '../../customer/src/index';
import type { StoredPointsMovement } from '../../../packages/loyalty/src/assess-points';
import type { StoredValueDeps, Instrument, ValueMovement } from '../../customer/src/stored-value';
import type { PromotionDeps, LaunchRecord } from '../../pricing/src/promotions';
import type { PromotionCatalogueDeps } from '../../pricing/src/promotion-catalogue';
import type { Promotion } from '../../../packages/promotions/src/promotions';
import { expired } from '../../orders/src/index';
import type {
  Reservation, OrdersDeps, PlacedOrder, OrderTransition, OrderStateView,
} from '../../orders/src/index';
import type { DeliveryAttempt, FulfilmentDeps } from '../../fulfilment/src/index';
import type { IdentityDeps } from '../../identity/src/index';
import type { Role, RoleAssignment } from '../../../packages/rbac/src/rbac';
import type { DependencyProbe, FeatureFlagChange, PlatformDeps, ExportedEvent } from '../../platform/src/index';
import { inMemorySettings } from '../../platform/src/index';
import { buildTenantExport } from '../../../packages/platform/src/lifecycle';
import type { TenantBranding } from '../../../packages/platform/src/branding';
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
import type { PriceListDeps } from '../../pricing/src/price-list';
import type { PriceEntry } from '../../../packages/price-list/src/price-list';
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
  b2b: 'b2b',
  concession: 'concession',
  scrap: 'scrap',
  facilities: 'facilities',
  packaging: 'packaging',
  waste: 'waste',
  integration: 'integration',
  lossPrevention: 'loss-prevention',
  warehouse: 'warehouse',
  orders: 'orders',
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
/** Each order's lifecycle folds one stream — one order's history end-to-end, not the whole shop's. */
const forOrder = (orderId: string): string => streamName(STREAM.orders, orderId);
const forInvoice = (invoiceId: string): string => streamName(STREAM.purchase, 'invoice', invoiceId);
/** Each supplier partner's portal config and submissions fold one stream — one partner, not the shop. */
const forPortalPartner = (partnerId: string): string => streamName(STREAM.purchase, 'partner', partnerId);
/** Returns hang off the sale they are against, so "what came back on this bill?" reads one stream. */
const forSaleReturns = (saleId: string): string => streamName(STREAM.sales, 'return', saleId);
/** Each till's cash chain folds one stream — its balance and custodian read one till, not the shop. */
const forTillCash = (tillId: string): string => streamName(STREAM.cash, tillId);
/** Shift closes share one stream (low-volume — a few tills × shifts a day), folded by shift id. */
const SHIFTS_STREAM = streamName(STREAM.cash, 'shifts');
/** Each B2B customer's credit terms and AR movements fold one stream — one customer, not the shop. */
const forB2BCustomer = (customerId: string): string => streamName(STREAM.b2b, customerId);
/** Each salesperson's commission accruals fold one stream — one person's earnings, not every deal. */
const forB2BSalesperson = (salespersonId: string): string => streamName(STREAM.b2b, 'commission', salespersonId);
/** Each B2B customer's document chain (quotations, orders, …) folds one stream — one customer, not the shop. */
const forB2BDocuments = (customerId: string): string => streamName(STREAM.b2b, 'documents', customerId);
/** Each product's effective-dated price-list entries fold one stream — one product's prices, not the shop's. */
const forPriceList = (productId: string): string => streamName(STREAM.pricing, 'list', productId);
/** Each concession contract's terms and sales fold one stream — one counter, not the shop. */
const forConcession = (contractId: string): string => streamName(STREAM.concession, contractId);
/** Each packaging item's registration and movements fold one stream — one item, not every crate. */
const forPackaging = (packagingId: string): string => streamName(STREAM.packaging, packagingId);
/** Each webhook provider's config and processed deliveries fold one stream — one provider, not all. */
const forWebhook = (provider: string): string => streamName(STREAM.integration, 'webhook', provider);
/** Each connector mapping version folds one stream — one (connector, version), not every mapping. */
const forConnectorMapping = (connectorId: string, version: string): string => streamName(STREAM.integration, 'mapping', connectorId, version);

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

export function shiftAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ShiftDeps {
  const closes = (tenantId: string) =>
    allOf<ClosedShiftRecord>(input.store, tenantId, SHIFTS_STREAM, 'TillClosed');

  return {
    now: input.now,

    closedShift: async (tenantId, shiftId) => (await closes(tenantId)).find((r) => r.shiftId === shiftId),

    overShortShifts: async (tenantId) => (await closes(tenantId)).filter((r) => r.exceptionRaised),

    recordShiftClose: async (tenantId, record) => {
      await input.store.append(tenantId, SHIFTS_STREAM, makeEvent({
        id: `shift-close-${record.shiftId}`,
        type: 'TillClosed',
        occurredAt: record.closedAt,
        // The shift's own id, no timestamp — re-sending a close collapses rather than recording the
        // same shift closed twice on a different figure.
        idempotencyKey: `shift-close-${tenantId}-${record.shiftId}`,
        source: 'api/pos',
        payload: record,
      }));
    },
  };
}

export function b2bCreditAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): B2BCreditDeps {
  return {
    now: input.now,

    // The latest credit limit applies — a limit change is a new fact, folded to its most recent value.
    account: async (tenantId, customerId) => {
      const latestLimit = await latest<B2BAccount>(input.store, tenantId, forB2BCustomer(customerId), 'B2BCreditLimitSet');
      return latestLimit;
    },

    // Outstanding is PROJECTED from the receivable movements — never a stored balance that could drift
    // from the invoices and payments beneath it (the whole point of a ledger).
    outstandingMinor: async (tenantId, customerId) =>
      (await allOf<RecordedReceivable>(input.store, tenantId, forB2BCustomer(customerId), 'B2BReceivableMovement'))
        .reduce((b, m) => b + m.deltaMinor, 0),

    recordAccount: async (tenantId, customerId, creditLimitMinor, currency) => {
      await input.store.append(tenantId, forB2BCustomer(customerId), makeEvent({
        id: `b2b-limit-${customerId}-${creditLimitMinor}`,
        type: 'B2BCreditLimitSet',
        occurredAt: input.now(),
        // Keyed on the value — setting the same limit twice collapses, a different limit is a new fact.
        idempotencyKey: `b2b-limit-${tenantId}-${customerId}-${creditLimitMinor}`,
        source: 'api/finance',
        payload: { creditLimitMinor, currency } satisfies B2BAccount,
      }));
    },

    recordReceivable: async (tenantId, customerId, m) => {
      await input.store.append(tenantId, forB2BCustomer(customerId), makeEvent({
        id: `b2b-ar-${m.movementId}`,
        type: 'B2BReceivableMovement',
        occurredAt: m.at,
        // The movement's own id, no timestamp — a re-sent invoice or payment collapses, so the balance
        // moves once however many times it is sent.
        idempotencyKey: `b2b-ar-${tenantId}-${m.movementId}`,
        source: 'api/finance',
        payload: m,
      }));
    },
  };
}

export function concessionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ConcessionDeps {
  return {
    now: input.now,

    // The latest contract applies — terms can change, folded to their newest set.
    contract: async (tenantId, contractId) =>
      latest<ConcessionContract>(input.store, tenantId, forConcession(contractId), 'ConcessionContractSet'),

    sales: async (tenantId, contractId) =>
      allOf<ConcessionSale>(input.store, tenantId, forConcession(contractId), 'ConcessionSaleRecorded'),

    recordContract: async (tenantId, contract) => {
      await input.store.append(tenantId, forConcession(contract.contractId), makeEvent({
        id: `concession-contract-${contract.contractId}-${contract.basis}-${contract.fixedRentMinor ?? 0}-${contract.revenueShareBps ?? 0}`,
        type: 'ConcessionContractSet',
        occurredAt: input.now(),
        // Keyed on the terms — re-sending the same contract collapses, a change of terms is a new fact.
        idempotencyKey: `concession-contract-${tenantId}-${contract.contractId}-${contract.basis}-${contract.fixedRentMinor ?? 0}-${contract.revenueShareBps ?? 0}-${contract.depositMinor}-${contract.active}`,
        source: 'api/finance',
        payload: contract,
      }));
    },

    recordSale: async (tenantId, sale) => {
      await input.store.append(tenantId, forConcession(sale.contractId), makeEvent({
        id: `concession-sale-${sale.saleId}`,
        type: 'ConcessionSaleRecorded',
        occurredAt: sale.at,
        // The sale's own id — a re-sent concession sale collapses rather than double-counting the
        // partner's takings, which are money the shop holds on their behalf.
        idempotencyKey: `concession-sale-${tenantId}-${sale.saleId}`,
        source: 'api/finance',
        payload: sale,
      }));
    },
  };
}

export function scrapAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ScrapDeps {
  // Scrap is low-volume (a few disposals a week), so all of it folds one stream: the recorded sales,
  // plus the "posted to finance" events that clear each one's off-books flag.
  return {
    now: input.now,

    scrapSales: async (tenantId) => {
      const events = await input.store.readStream(tenantId, STREAM.scrap);
      const posted = new Set<string>();
      const sales: ScrapSale[] = [];
      for (const e of events) {
        const p = e.event.payload as Record<string, unknown>;
        if (e.event.type === 'ScrapPostedToFinance') posted.add(p['scrapId'] as string);
        else if (e.event.type === 'ScrapSaleRecorded') sales.push(p as unknown as ScrapSale);
      }
      return sales.map((s) => (posted.has(s.scrapId) ? { ...s, postedToFinance: true } : s));
    },

    recordScrapSale: async (tenantId, sale) => {
      await input.store.append(tenantId, STREAM.scrap, makeEvent({
        id: `scrap-${sale.scrapId}`,
        type: 'ScrapSaleRecorded',
        occurredAt: sale.at,
        // The disposal's own id — a re-sent scrap sale collapses rather than double-recording the
        // proceeds (which would make the off-books number wrong in the other direction).
        idempotencyKey: `scrap-${tenantId}-${sale.scrapId}`,
        source: 'api/finance',
        payload: sale,
      }));
    },

    recordPosted: async (tenantId, scrapId, at) => {
      await input.store.append(tenantId, STREAM.scrap, makeEvent({
        id: `scrap-posted-${scrapId}`,
        type: 'ScrapPostedToFinance',
        occurredAt: at,
        idempotencyKey: `scrap-posted-${tenantId}-${scrapId}`,
        source: 'api/finance',
        payload: { scrapId },
      }));
    },
  };
}

export function facilitiesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FacilitiesDeps {
  // Facilities is low-volume (a store's schedules and their weekly tasks), so all of it folds one
  // stream: the latest set of each schedule, and each task's due record merged with its completion.
  return {
    now: input.now,

    schedules: async (tenantId) => {
      const set = await allOf<MaintenanceSchedule>(input.store, tenantId, STREAM.facilities, 'FacilitiesScheduleSet');
      const byId = new Map<string, MaintenanceSchedule>();
      for (const s of set) byId.set(s.scheduleId, s); // later set wins
      return [...byId.values()];
    },

    tasks: async (tenantId) => {
      const events = await input.store.readStream(tenantId, STREAM.facilities);
      const byId = new Map<string, ScheduledTask>();
      for (const e of events) {
        const p = e.event.payload as Record<string, unknown>;
        if (e.event.type === 'FacilitiesTaskDue') {
          const id = p['taskId'] as string;
          byId.set(id, { ...(byId.get(id) ?? {} as ScheduledTask), taskId: id, scheduleId: p['scheduleId'] as string, dueOn: p['dueOn'] as string });
        } else if (e.event.type === 'FacilitiesTaskCompleted') {
          const id = p['taskId'] as string;
          byId.set(id, { ...(byId.get(id) ?? { taskId: id, scheduleId: p['scheduleId'] as string, dueOn: p['dueOn'] as string }), ...(p as unknown as ScheduledTask) });
        }
      }
      return [...byId.values()];
    },

    recordSchedule: async (tenantId, schedule) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-sched-${schedule.scheduleId}-${schedule.title}-${schedule.active}`,
        type: 'FacilitiesScheduleSet',
        occurredAt: input.now(),
        // Keyed on the definition — re-setting the same schedule collapses, a change is a new fact.
        idempotencyKey: `fac-sched-${tenantId}-${schedule.scheduleId}-${schedule.category}-${schedule.frequency}-${schedule.evidenceRequired}-${schedule.verificationRequired}-${schedule.active}`,
        source: 'api/platform',
        payload: schedule,
      }));
    },

    recordTaskDue: async (tenantId, task) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-task-due-${task.taskId}`,
        type: 'FacilitiesTaskDue',
        occurredAt: input.now(),
        idempotencyKey: `fac-task-due-${tenantId}-${task.taskId}`,
        source: 'api/platform',
        payload: task,
      }));
    },

    recordTaskCompleted: async (tenantId, task) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-task-done-${task.taskId}`,
        type: 'FacilitiesTaskCompleted',
        occurredAt: input.now(),
        // The task's own id — a re-sent completion collapses rather than recording two.
        idempotencyKey: `fac-task-done-${tenantId}-${task.taskId}`,
        source: 'api/platform',
        payload: task,
      }));
    },

    incidents: async (tenantId) => {
      const all = await allOf<SafetyIncident>(input.store, tenantId, STREAM.facilities, 'FacilitiesIncidentRecorded');
      const byId = new Map<string, SafetyIncident>();
      for (const i of all) byId.set(i.incidentId, i); // the closed record supersedes the open one
      return [...byId.values()];
    },

    recordIncident: async (tenantId, incident) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-incident-${incident.incidentId}-${incident.closedAt ?? 'open'}`,
        type: 'FacilitiesIncidentRecorded',
        occurredAt: input.now(),
        // Open and closed are two facts about one incident; the reader keeps the later by incidentId.
        idempotencyKey: `fac-incident-${tenantId}-${incident.incidentId}-${incident.closedAt ?? 'open'}`,
        source: 'api/platform',
        payload: incident,
      }));
    },
  };
}

export function facilitiesAssetsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FacilitiesAssetsDeps {
  // Assets, their service history, their downtime and their energy — all low-volume, all folded from
  // the one facilities stream by event type. An asset is the latest set of it; a downtime event is the
  // latest set of it (recording the restore supersedes the open record, so it is not counted twice);
  // services and readings each dedupe on their own id via the append's idempotency key.
  return {
    now: input.now,

    assets: async (tenantId) => {
      const all = await allOf<Asset>(input.store, tenantId, STREAM.facilities, 'FacilitiesAssetSet');
      const byId = new Map<string, Asset>();
      for (const a of all) byId.set(a.assetId, a); // later set wins
      return [...byId.values()];
    },

    services: async (tenantId) => {
      const all = await allOf<ServiceLog>(input.store, tenantId, STREAM.facilities, 'FacilitiesServiceLogged');
      const byId = new Map<string, ServiceLog>();
      for (const s of all) byId.set(s.serviceId, s);
      return [...byId.values()];
    },

    downtime: async (tenantId) => {
      const all = await allOf<DowntimeEvent>(input.store, tenantId, STREAM.facilities, 'FacilitiesDowntimeRecorded');
      const byId = new Map<string, DowntimeEvent>();
      for (const d of all) byId.set(d.eventId, d); // the restore record supersedes the open one
      return [...byId.values()];
    },

    energyReadings: async (tenantId) =>
      allOf<EnergyReading>(input.store, tenantId, STREAM.facilities, 'FacilitiesEnergyReading'),

    recordAsset: async (tenantId, asset) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-asset-${asset.assetId}`,
        type: 'FacilitiesAssetSet',
        occurredAt: input.now(),
        // Keyed on the fields that matter — restating the same asset collapses, a change (renewed AMC,
        // new criticality, retired) is a new fact.
        idempotencyKey: `fac-asset-${tenantId}-${asset.assetId}-${asset.criticality}-${asset.amcUntil ?? 'none'}-${asset.warrantyUntil ?? 'none'}-${asset.serviceEveryDays ?? 'none'}-${asset.protectsValueMinor ?? 'none'}-${asset.active}`,
        source: 'api/platform',
        payload: asset,
      }));
    },

    recordService: async (tenantId, service) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-service-${service.serviceId}`,
        type: 'FacilitiesServiceLogged',
        occurredAt: input.now(),
        idempotencyKey: `fac-service-${tenantId}-${service.serviceId}`,
        source: 'api/platform',
        payload: service,
      }));
    },

    recordDowntime: async (tenantId, event) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-downtime-${event.eventId}-${event.restoredAt ?? 'open'}`,
        type: 'FacilitiesDowntimeRecorded',
        occurredAt: input.now(),
        // Open and restored are two facts about one event; the reader keeps the later by eventId.
        idempotencyKey: `fac-downtime-${tenantId}-${event.eventId}-${event.restoredAt ?? 'open'}`,
        source: 'api/platform',
        payload: event,
      }));
    },

    recordEnergy: async (tenantId, readingId, reading) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-energy-${readingId}`,
        type: 'FacilitiesEnergyReading',
        occurredAt: input.now(),
        idempotencyKey: `fac-energy-${tenantId}-${readingId}`,
        source: 'api/platform',
        payload: reading,
      }));
    },
  };
}

export function facilitiesMonitoringAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FacilitiesMonitoringDeps {
  // Equipment monitoring folds the one facilities stream by event type: a range and an equipment's
  // contents fold latest-wins by assetId, readings and power events dedupe on their own id via the
  // append idempotency key. Append-only — a new contents set is a new fact, never an overwrite.
  return {
    now: input.now,

    ranges: async (tenantId) => {
      const all = await allOf<EquipmentRangeReg>(input.store, tenantId, STREAM.facilities, 'FacilitiesEquipmentRangeSet');
      const byId = new Map<string, EquipmentRangeReg>();
      for (const r of all) byId.set(r.assetId, r); // later set wins
      return [...byId.values()];
    },

    readings: async (tenantId) => {
      const all = await allOf<EquipmentReading>(input.store, tenantId, STREAM.facilities, 'FacilitiesEquipmentReading');
      const byId = new Map<string, EquipmentReading>();
      for (const r of all) byId.set(r.readingId, r);
      return [...byId.values()];
    },

    contents: async (tenantId) => {
      const all = await allOf<EquipmentContents>(input.store, tenantId, STREAM.facilities, 'FacilitiesEquipmentContents');
      const byId = new Map<string, EquipmentContents>();
      for (const c of all) byId.set(c.assetId, c); // later set wins
      return [...byId.values()];
    },

    powerEvents: async (tenantId) => {
      const all = await allOf<PowerEvent>(input.store, tenantId, STREAM.facilities, 'FacilitiesPowerEvent');
      const byId = new Map<string, PowerEvent>();
      for (const e of all) byId.set(e.eventId, e);
      return [...byId.values()];
    },

    recordRange: async (tenantId, reg) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-range-${reg.assetId}`,
        type: 'FacilitiesEquipmentRangeSet',
        occurredAt: input.now(),
        // Keyed on the fields that matter so restating collapses and a change is a new fact.
        idempotencyKey: `fac-range-${tenantId}-${reg.assetId}-${reg.range.minTenthsC}-${reg.range.maxTenthsC}-${reg.range.graceMinutes}-${reg.range.expectEveryMinutes ?? 'def'}-${reg.onBackup}`,
        source: 'api/platform',
        payload: reg,
      }));
    },

    recordReading: async (tenantId, reading) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-eqreading-${reading.readingId}`,
        type: 'FacilitiesEquipmentReading',
        occurredAt: input.now(),
        idempotencyKey: `fac-eqreading-${tenantId}-${reading.readingId}`,
        source: 'api/platform',
        payload: reading,
      }));
    },

    recordContents: async (tenantId, contents) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-contents-${contents.assetId}-${contents.contents.length}`,
        type: 'FacilitiesEquipmentContents',
        occurredAt: input.now(),
        // The contents move; a new set is a new fact. Key on the whole set so an identical resend
        // collapses but any change appends.
        idempotencyKey: `fac-contents-${tenantId}-${contents.assetId}-${contents.contents.map((b) => `${b.batchId}:${b.valueMinor}`).join(',')}`,
        source: 'api/platform',
        payload: contents,
      }));
    },

    recordPowerEvent: async (tenantId, event) => {
      await input.store.append(tenantId, STREAM.facilities, makeEvent({
        id: `fac-power-${event.eventId}`,
        type: 'FacilitiesPowerEvent',
        occurredAt: input.now(),
        idempotencyKey: `fac-power-${tenantId}-${event.eventId}`,
        source: 'api/platform',
        payload: event,
      }));
    },
  };
}

export function packagingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PackagingDeps {
  // Each packaging item folds its own stream: the latest registration of the item, and every movement
  // deduped on its own id. Nothing is stored as a balance — the position is projected on read (#2).
  return {
    now: input.now,

    item: async (tenantId, packagingId) =>
      latest<PackagingItem>(input.store, tenantId, forPackaging(packagingId), 'PackagingItemRegistered'),

    movements: async (tenantId, packagingId) => {
      const all = await allOf<PackagingMovement>(input.store, tenantId, forPackaging(packagingId), 'PackagingMoved');
      const byId = new Map<string, PackagingMovement>();
      for (const m of all) byId.set(m.movementId, m); // a re-sent movement collapses, never doubles
      return [...byId.values()];
    },

    registerItem: async (tenantId, item) => {
      await input.store.append(tenantId, forPackaging(item.packagingId), makeEvent({
        id: `pkg-item-${item.packagingId}`,
        type: 'PackagingItemRegistered',
        occurredAt: input.now(),
        // Keyed on the fields that matter so restating collapses and a change is a new fact.
        idempotencyKey: `pkg-item-${tenantId}-${item.packagingId}-${item.kind}-${item.returnable}-${item.chargeMinor ?? 'free'}-${item.taxRateBps ?? 'none'}-${item.depositMinor ?? 'none'}`,
        source: 'api/inventory',
        payload: item,
      }));
    },

    recordMovement: async (tenantId, movement) => {
      await input.store.append(tenantId, forPackaging(movement.packagingId), makeEvent({
        id: `pkg-mov-${movement.movementId}`,
        type: 'PackagingMoved',
        occurredAt: movement.at,
        idempotencyKey: `pkg-mov-${tenantId}-${movement.movementId}`,
        source: 'api/inventory',
        payload: movement,
      }));
    },
  };
}

export function wasteAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): WasteDeps {
  // Waste is low-to-moderate volume (losses logged by department), so it folds one tenant stream: every
  // waste record deduped on its own id, and the latest coverage expectation. Nothing is a stored total —
  // the report is projected on read, with its coverage derived the same way (#2, P-08).
  return {
    now: input.now,

    records: async (tenantId) => {
      const all = await allOf<WasteRecord>(input.store, tenantId, STREAM.waste, 'WasteRecorded');
      const byId = new Map<string, WasteRecord>();
      for (const r of all) byId.set(r.wasteId, r);
      return [...byId.values()];
    },

    coverage: async (tenantId) =>
      (await latest<WasteCoverage>(input.store, tenantId, STREAM.waste, 'WasteCoverageSet')) ?? { expected: [], departmentNames: {} },

    recordWaste: async (tenantId, record) => {
      await input.store.append(tenantId, STREAM.waste, makeEvent({
        id: `waste-${record.wasteId}`,
        type: 'WasteRecorded',
        occurredAt: record.at,
        idempotencyKey: `waste-${tenantId}-${record.wasteId}`,
        source: 'api/inventory',
        payload: record,
      }));
    },

    recordCoverage: async (tenantId, coverage) => {
      await input.store.append(tenantId, STREAM.waste, makeEvent({
        id: `waste-coverage-${coverage.expected.length}`,
        type: 'WasteCoverageSet',
        occurredAt: input.now(),
        // Keyed on the expected set so re-sending the same expectation collapses, a change is a new fact.
        idempotencyKey: `waste-coverage-${tenantId}-${coverage.expected.map((e) => `${e.branchId}:${e.departmentId}`).sort().join(',')}`,
        source: 'api/inventory',
        payload: coverage,
      }));
    },
  };
}

export function integrationAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): IntegrationDeps {
  // The certified matrix, the registered adapters and their heartbeats fold one tenant stream: matrix
  // entries and adapter configs latest-wins by id, heartbeats deduped on their own id. Health is
  // projected on read from when each adapter last actually worked (#2).
  return {
    now: input.now,

    matrix: async (tenantId) => {
      const all = await allOf<CertifiedEntry>(input.store, tenantId, STREAM.integration, 'IntegrationMatrixEntrySet');
      const byId = new Map<string, CertifiedEntry>();
      for (const e of all) byId.set(e.entryId, e);
      return [...byId.values()];
    },

    adapters: async (tenantId) => {
      const all = await allOf<AdapterConfig>(input.store, tenantId, STREAM.integration, 'IntegrationAdapterRegistered');
      const byId = new Map<string, AdapterConfig>();
      for (const a of all) byId.set(a.adapterId, a);
      return [...byId.values()];
    },

    heartbeats: async (tenantId) =>
      allOf<AdapterHeartbeat>(input.store, tenantId, STREAM.integration, 'IntegrationHeartbeat'),

    recordMatrixEntry: async (tenantId, entry) => {
      await input.store.append(tenantId, STREAM.integration, makeEvent({
        id: `intg-matrix-${entry.entryId}`,
        type: 'IntegrationMatrixEntrySet',
        occurredAt: input.now(),
        idempotencyKey: `intg-matrix-${tenantId}-${entry.entryId}-${entry.vendor}-${entry.model}-${entry.versions.join('.')}-${entry.rbiAuthorised ?? 'na'}`,
        source: 'api/platform',
        payload: entry,
      }));
    },

    recordAdapter: async (tenantId, config) => {
      await input.store.append(tenantId, STREAM.integration, makeEvent({
        id: `intg-adapter-${config.adapterId}`,
        type: 'IntegrationAdapterRegistered',
        occurredAt: input.now(),
        idempotencyKey: `intg-adapter-${tenantId}-${config.adapterId}-${config.environment}-${config.credentialRef}-${config.enabled}`,
        source: 'api/platform',
        payload: config,
      }));
    },

    recordHeartbeat: async (tenantId, heartbeatId, heartbeat) => {
      await input.store.append(tenantId, STREAM.integration, makeEvent({
        id: `intg-hb-${heartbeatId}`,
        type: 'IntegrationHeartbeat',
        occurredAt: heartbeat.at,
        idempotencyKey: `intg-hb-${tenantId}-${heartbeatId}`,
        source: 'api/platform',
        payload: heartbeat,
      }));
    },
  };
}

export function webhookAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly hasher: Hasher;
}): WebhookDeps {
  // Each provider folds its own stream: the latest config, and the delivery ids already processed —
  // the ledger a replay is checked against. A processed delivery is a fact, never overwritten (#2).
  return {
    now: input.now,
    hasher: input.hasher,

    config: async (tenantId, provider) =>
      latest<WebhookConfig>(input.store, tenantId, forWebhook(provider), 'WebhookConfigured'),

    seenDeliveryIds: async (tenantId, provider) => {
      const events = await input.store.readStream(tenantId, forWebhook(provider), { type: 'WebhookDeliveryProcessed' });
      return events.map((e) => (e.event.payload as { deliveryId: string }).deliveryId);
    },

    recordConfig: async (tenantId, config) => {
      await input.store.append(tenantId, forWebhook(config.provider), makeEvent({
        id: `wh-config-${config.provider}`,
        type: 'WebhookConfigured',
        occurredAt: input.now(),
        idempotencyKey: `wh-config-${tenantId}-${config.provider}-${config.signingKeyRef}-${config.maxAgeSeconds ?? 'def'}`,
        source: 'api/platform',
        payload: config,
      }));
    },

    recordDelivery: async (tenantId, provider, envelope) => {
      await input.store.append(tenantId, forWebhook(provider), makeEvent({
        id: `wh-del-${provider}-${envelope.deliveryId}`,
        type: 'WebhookDeliveryProcessed',
        occurredAt: input.now(),
        // The delivery's own id — a genuine provider retry collapses here rather than processing twice.
        idempotencyKey: `wh-del-${tenantId}-${provider}-${envelope.deliveryId}`,
        source: 'api/platform',
        payload: { deliveryId: envelope.deliveryId, event: envelope.event, sentAt: envelope.sentAt },
      }));
    },
  };
}

export function connectorAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ConnectorMappingDeps {
  // Each (connector, version) mapping folds its own stream — the latest registration. A mapping is
  // configuration, latest-wins; nothing here delivers, so nothing here needs the message log.
  return {
    now: input.now,

    mapping: async (tenantId, connectorId, version) =>
      latest<Mapping>(input.store, tenantId, forConnectorMapping(connectorId, version), 'ConnectorMappingSet'),

    recordMapping: async (tenantId, mapping) => {
      await input.store.append(tenantId, forConnectorMapping(mapping.connectorId, mapping.version), makeEvent({
        id: `conn-map-${mapping.connectorId}-${mapping.version}`,
        type: 'ConnectorMappingSet',
        occurredAt: input.now(),
        idempotencyKey: `conn-map-${tenantId}-${mapping.connectorId}-${mapping.version}-${mapping.rules.length}-${mapping.required.join('.')}`,
        source: 'api/platform',
        payload: mapping,
      }));
    },
  };
}

export function b2bCollectionsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): B2BCollectionsDeps {
  // Each B2B customer folds its own stream. Invoices are recorded with settledMinor 0; each invoice's
  // real settled is PROJECTED by summing the allocations of every recorded payment (#2 — never stored).
  return {
    now: input.now,

    invoices: async (tenantId, customerId) => {
      const invoices = await allOf<CollectionsReceivable>(input.store, tenantId, forB2BCustomer(customerId), 'B2BInvoiceRecorded');
      const payments = await allOf<RecordedPayment>(input.store, tenantId, forB2BCustomer(customerId), 'B2BPaymentAllocated');
      const settledByInvoice = new Map<string, number>();
      for (const p of payments) {
        for (const a of p.allocations) settledByInvoice.set(a.invoiceId, (settledByInvoice.get(a.invoiceId) ?? 0) + a.appliedMinor);
      }
      const byId = new Map<string, CollectionsReceivable>();
      for (const inv of invoices) byId.set(inv.invoiceId, { ...inv, settledMinor: settledByInvoice.get(inv.invoiceId) ?? 0 }); // later invoice restatement wins
      return [...byId.values()];
    },

    recordInvoice: async (tenantId, customerId, invoice) => {
      await input.store.append(tenantId, forB2BCustomer(customerId), makeEvent({
        id: `b2b-inv-${customerId}-${invoice.invoiceId}`,
        type: 'B2BInvoiceRecorded',
        occurredAt: input.now(),
        idempotencyKey: `b2b-inv-${tenantId}-${customerId}-${invoice.invoiceId}-${invoice.grossMinor}-${invoice.dueOn}-${invoice.disputed ?? false}`,
        source: 'api/finance',
        payload: invoice,
      }));
    },

    recordPayment: async (tenantId, customerId, payment) => {
      await input.store.append(tenantId, forB2BCustomer(customerId), makeEvent({
        id: `b2b-pay-${customerId}-${payment.receiptId}`,
        type: 'B2BPaymentAllocated',
        occurredAt: input.now(),
        // The receipt's own id — a re-sent payment collapses rather than allocating twice.
        idempotencyKey: `b2b-pay-${tenantId}-${customerId}-${payment.receiptId}`,
        source: 'api/finance',
        payload: payment,
      }));
    },
  };
}

export function b2bCommissionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): B2BCommissionDeps {
  // Each salesperson folds its own stream. The total earned is projected by summing the accruals here
  // and in the route — never a stored balance (#2). A re-sent accrual (same id) collapses on append.
  return {
    now: input.now,

    accruals: (tenantId, salespersonId) =>
      allOf<CommissionAccrual>(input.store, tenantId, forB2BSalesperson(salespersonId), 'B2BCommissionAccrued'),

    recordAccrual: async (tenantId, salespersonId, accrual) => {
      await input.store.append(tenantId, forB2BSalesperson(salespersonId), makeEvent({
        id: `b2b-comm-${salespersonId}-${accrual.accrualId}`,
        type: 'B2BCommissionAccrued',
        occurredAt: input.now(),
        // The accrual's own id — a re-sent accrual collapses rather than earning twice (append-only).
        idempotencyKey: `b2b-comm-${tenantId}-${salespersonId}-${accrual.accrualId}`,
        source: 'api/finance',
        payload: accrual,
      }));
    },
  };
}

export function b2bDocumentsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  readonly numberSeries?: NumberSeriesStore;
}): B2BDocumentsDeps {
  const numberSeries = input.numberSeries ?? new InMemoryNumberSeriesStore();
  // Each B2B customer's document chain folds its own stream. A later restatement of a document (same id)
  // wins; the credit gate reads the customer's credit/AR stream, exactly as the credit surface does.
  const foldDocuments = async (tenantId: string, customerId: string): Promise<readonly StoredB2BDocument[]> => {
    const docs = await allOf<StoredB2BDocument>(input.store, tenantId, forB2BDocuments(customerId), 'B2BDocumentIssued');
    const byId = new Map<string, StoredB2BDocument>();
    for (const d of docs) byId.set(d.documentId, d);
    return [...byId.values()];
  };

  return {
    now: input.now,

    document: async (tenantId, customerId, documentId) =>
      (await foldDocuments(tenantId, customerId)).find((d) => d.documentId === documentId),

    documents: (tenantId, customerId) => foldDocuments(tenantId, customerId),

    // Which quotations already became an order — the derivedFrom of every sales order on the stream.
    convertedQuotationIds: async (tenantId, customerId) =>
      (await foldDocuments(tenantId, customerId))
        .filter((d) => d.kind === 'sales_order' && d.derivedFrom !== undefined)
        .map((d) => d.derivedFrom as string),

    recordDocument: async (tenantId, customerId, doc) => {
      await input.store.append(tenantId, forB2BDocuments(customerId), makeEvent({
        id: `b2b-doc-${customerId}-${doc.documentId}`,
        type: 'B2BDocumentIssued',
        occurredAt: input.now(),
        // The document's own id — a re-sent issue collapses rather than drawing a second number.
        idempotencyKey: `b2b-doc-${tenantId}-${customerId}-${doc.documentId}`,
        source: 'api/finance',
        payload: doc,
      }));
    },

    // The gap-free series, keyed by (tenant, doc type). Called only once the engine would issue.
    allocateNumber: (tenantId, docType) => numberSeries.allocate(tenantId, docType),

    // The real credit gate (M22-FR-01): read the customer's limit and projected AR, run checkCredit.
    // No account set means credit control has not cleared them — blocked, never a silent pass.
    creditAllowed: async (tenantId, customerId, orderValueMinor) => {
      const account = await latest<B2BAccount>(input.store, tenantId, forB2BCustomer(customerId), 'B2BCreditLimitSet');
      if (account === undefined) return false;
      const outstanding = (await allOf<RecordedReceivable>(input.store, tenantId, forB2BCustomer(customerId), 'B2BReceivableMovement'))
        .reduce((b, m) => b + m.deltaMinor, 0);
      const decision = checkCredit({
        id: `conv-${customerId}`, customerId, takenBy: 'system',
        creditLimit: { minor: account.creditLimitMinor, currency: account.currency },
        outstanding: { minor: outstanding, currency: account.currency },
        orderValue: { minor: orderValueMinor, currency: account.currency },
      });
      return decision.allowed;
    },
  };
}

export function lpCasesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): LpCasesDeps {
  // Loss-prevention cases are exceptions, not transactions — low volume — so all fold one tenant
  // stream, by caseId. The append-only stream IS the chain of custody: an opened case, then each sealed
  // evidence item in the order it was added (the seal chain depends on that order), then a close.
  const foldCases = async (tenantId: string): Promise<readonly InvestigationCase[]> => {
    const events = await input.store.readStream(tenantId, STREAM.lossPrevention);
    const byId = new Map<string, InvestigationCase>();
    for (const e of events) {
      const p = e.event.payload as Record<string, unknown>;
      if (e.event.type === 'LpCaseOpened') {
        const c = p as unknown as InvestigationCase;
        byId.set(c.caseId, c);
      } else if (e.event.type === 'LpEvidenceAdded') {
        const cur = byId.get(p['caseId'] as string);
        if (cur !== undefined) byId.set(cur.caseId, { ...cur, evidence: [...cur.evidence, p['item'] as EvidenceItem] });
      } else if (e.event.type === 'LpCaseClosed') {
        const cur = byId.get(p['caseId'] as string);
        if (cur !== undefined) byId.set(cur.caseId, { ...cur, state: 'closed', outcome: p['outcome'] as InvestigationCase['outcome'], outcomeNote: p['outcomeNote'] as string, closedBy: p['closedBy'] as string, closedAt: p['closedAt'] as string });
      }
    }
    return [...byId.values()];
  };

  return {
    now: input.now,

    cases: (tenantId) => foldCases(tenantId),
    case: async (tenantId, caseId) => (await foldCases(tenantId)).find((c) => c.caseId === caseId),

    recordOpened: async (tenantId, investigation) => {
      await input.store.append(tenantId, STREAM.lossPrevention, makeEvent({
        id: `lp-case-open-${investigation.caseId}`,
        type: 'LpCaseOpened',
        occurredAt: investigation.openedAt,
        idempotencyKey: `lp-case-open-${tenantId}-${investigation.caseId}`,
        source: 'api/pos',
        payload: investigation,
      }));
    },

    recordEvidence: async (tenantId, caseId, item) => {
      await input.store.append(tenantId, STREAM.lossPrevention, makeEvent({
        id: `lp-ev-${caseId}-${item.evidenceId}`,
        type: 'LpEvidenceAdded',
        occurredAt: item.collectedAt,
        // The (case, evidence) id — the same item added twice collapses; the engine also refuses a dup id.
        idempotencyKey: `lp-ev-${tenantId}-${caseId}-${item.evidenceId}`,
        source: 'api/pos',
        payload: { caseId, item },
      }));
    },

    recordClosed: async (tenantId, c) => {
      await input.store.append(tenantId, STREAM.lossPrevention, makeEvent({
        id: `lp-case-close-${c.caseId}`,
        type: 'LpCaseClosed',
        occurredAt: c.closedAt ?? input.now(),
        idempotencyKey: `lp-case-close-${tenantId}-${c.caseId}`,
        source: 'api/pos',
        payload: { caseId: c.caseId, outcome: c.outcome, outcomeNote: c.outcomeNote, closedBy: c.closedBy, closedAt: c.closedAt },
      }));
    },
  };
}

export function lpRulesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): LpRulesDeps {
  // Rules are data — a store's own thresholds. They fold one per-tenant stream, latest per signal kind
  // wins (a re-tune is a new fact, never an overwrite). Low volume — five kinds.
  const rulesStream = streamName(STREAM.lossPrevention, 'rules');
  return {
    now: input.now,

    rules: async (tenantId) => {
      const set = await allOf<LpRule>(input.store, tenantId, rulesStream, 'LpRuleSet');
      const byKind = new Map<string, LpRule>();
      for (const r of set) byKind.set(r.kind, r); // later re-tune wins
      return [...byKind.values()];
    },

    recordRule: async (tenantId, rule) => {
      await input.store.append(tenantId, rulesStream, makeEvent({
        id: `lp-rule-${rule.kind}-${input.now()}`,
        type: 'LpRuleSet',
        occurredAt: input.now(),
        // Keyed on the kind AND the limits — re-setting the same thresholds collapses, a re-tune is a new fact.
        idempotencyKey: `lp-rule-${tenantId}-${rule.kind}-${rule.maxCount ?? ''}-${rule.maxTotalValueMinor ?? ''}-${rule.maxSingleValueMinor ?? ''}-${rule.escalateAtMultiple ?? ''}`,
        source: 'api/pos',
        payload: rule,
      }));
    },
  };
}

export function fraudSignalsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): FraudSignalsDeps {
  // A tenant's fraud thresholds are config — one small object, folded to its latest value on its own
  // per-tenant stream. Empty until set, and the engine then applies its safe defaults.
  const thresholdsStream = streamName(STREAM.lossPrevention, 'fraud-thresholds');
  return {
    now: input.now,

    thresholds: async (tenantId) =>
      (await latest<FraudThresholds>(input.store, tenantId, thresholdsStream, 'FraudThresholdsSet')) ?? {},

    recordThresholds: async (tenantId, thresholds) => {
      await input.store.append(tenantId, thresholdsStream, makeEvent({
        id: `fraud-thresholds-${input.now()}`,
        type: 'FraudThresholdsSet',
        occurredAt: input.now(),
        // Keyed on the values — re-setting the same thresholds collapses, a re-tune is a new fact.
        idempotencyKey: `fraud-thresholds-${tenantId}-${JSON.stringify(thresholds)}`,
        source: 'api/pos',
        payload: thresholds,
      }));
    },

    /**
     * Each supplier's CURRENT bank account, folded from the append-only bank-change ledger (the
     * last change per supplier wins), as holder→account references for duplicate detection
     * (M15-FR-03). Supplier accounts are what this API captures; employee accounts would join the
     * same fold when they are recorded. The `newAccount` ref is masked/tokenised (PRV).
     */
    bankHolders: async (tenantId) => {
      const changes = await allOf<BankChangeRequest>(input.store, tenantId, STREAM.purchase, 'SupplierBankChanged');
      const currentAccount = new Map<string, string>();
      for (const c of changes) currentAccount.set(c.supplierId, c.newAccount);
      return [...currentAccount.entries()].map(([holderId, accountRef]) => ({
        holderId, holderType: 'supplier' as const, accountRef,
      }));
    },
  };
}

export function warehouseAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): WarehouseDeps {
  const binsStream = streamName(STREAM.warehouse, 'bins');
  const movementsStream = streamName(STREAM.warehouse, 'movements');

  // Bin contents are PROJECTED from the append-only movement ledger, never stored (#2): a movement INTO
  // a bin (to !== null) adds, one OUT of a bin (to === null) subtracts, keyed by bin|product|batch.
  const foldContents = async (tenantId: string): Promise<BinContents> => {
    const recorded = await allOf<{ commandId: string; movements: readonly StockMovement[] }>(input.store, tenantId, movementsStream, 'WarehouseMovementRecorded');
    const contents: Record<string, number> = {};
    for (const r of recorded) {
      for (const m of r.movements) {
        const key = binKey(m.locationId, m.productId, m.batchId);
        contents[key] = (contents[key] ?? 0) + (m.to !== null ? m.quantityMinor : -m.quantityMinor);
      }
    }
    return contents;
  };

  return {
    now: input.now,

    bins: async (tenantId) => {
      const registered = await allOf<Bin>(input.store, tenantId, binsStream, 'WarehouseBinRegistered');
      const byId = new Map<string, Bin>();
      for (const b of registered) byId.set(b.binId, b); // latest definition wins
      return [...byId.values()];
    },

    contents: (tenantId) => foldContents(tenantId),

    appliedCommandIds: async (tenantId) =>
      (await allOf<{ commandId: string }>(input.store, tenantId, movementsStream, 'WarehouseMovementRecorded')).map((r) => r.commandId),

    recordBin: async (tenantId, bin) => {
      await input.store.append(tenantId, binsStream, makeEvent({
        id: `wh-bin-${bin.binId}`,
        type: 'WarehouseBinRegistered',
        occurredAt: input.now(),
        // Keyed on the bin id + its shape — re-registering the same bin collapses, a redefinition is a new fact.
        idempotencyKey: `wh-bin-${tenantId}-${bin.binId}-${bin.capacityMinor}-${bin.pickable}-${bin.zone ?? ''}`,
        source: 'api/inventory',
        payload: bin,
      }));
    },

    recordMovement: async (tenantId, commandId, movements) => {
      await input.store.append(tenantId, movementsStream, makeEvent({
        id: `wh-move-${commandId}`,
        type: 'WarehouseMovementRecorded',
        occurredAt: input.now(),
        // The command's own id — a re-sent scan collapses rather than moving twice (append-only, #2).
        idempotencyKey: `wh-move-${tenantId}-${commandId}`,
        source: 'api/inventory',
        payload: { commandId, movements },
      }));
    },
  };
}

export function transfersAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): TransfersDeps {
  // Each transfer folds one per-tenant stream by transferId; the aggregate carried on each event is the
  // latest truth (proposed → in_transit → received). Movements/discrepancies ride the event as evidence.
  const transfersStream = streamName(STREAM.warehouse, 'transfers');
  const foldTransfers = async (tenantId: string): Promise<Map<string, Transfer>> => {
    const events = await input.store.readStream(tenantId, transfersStream);
    const byId = new Map<string, Transfer>();
    for (const e of events) {
      const t = (e.event.payload as { transfer?: Transfer }).transfer;
      if (t !== undefined) byId.set(t.transferId, t);
    }
    return byId;
  };

  return {
    now: input.now,

    transfer: async (tenantId, transferId) => (await foldTransfers(tenantId)).get(transferId),

    recordProposed: async (tenantId, transfer) => {
      await input.store.append(tenantId, transfersStream, makeEvent({
        id: `transfer-proposed-${transfer.transferId}`,
        type: 'TransferProposed',
        occurredAt: input.now(),
        idempotencyKey: `transfer-proposed-${tenantId}-${transfer.transferId}`,
        source: 'api/inventory',
        payload: { transfer },
      }));
    },

    recordDispatched: async (tenantId, transfer, movements) => {
      await input.store.append(tenantId, transfersStream, makeEvent({
        id: `transfer-dispatched-${transfer.transferId}`,
        type: 'TransferDispatched',
        occurredAt: transfer.dispatchedAt ?? input.now(),
        idempotencyKey: `transfer-dispatched-${tenantId}-${transfer.transferId}`,
        source: 'api/inventory',
        payload: { transfer, movements },
      }));
    },

    recordReceived: async (tenantId, transfer, movements, discrepancies) => {
      await input.store.append(tenantId, transfersStream, makeEvent({
        id: `transfer-received-${transfer.transferId}`,
        type: 'TransferReceived',
        occurredAt: transfer.receivedAt ?? input.now(),
        idempotencyKey: `transfer-received-${tenantId}-${transfer.transferId}`,
        source: 'api/inventory',
        payload: { transfer, movements, discrepancies },
      }));
    },
  };
}

export function countsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): CountsDeps {
  // Count reconciliations live on their own append-only stream, LAYERED on the authoritative M08
  // position. The count-correction ledger is separate from M08 because M08's movement model (a kind +
  // a positive quantity) cannot express a signed count correction; the corrected on-hand is the M08
  // base plus the sum of the corrections here. `recordReconciliation` is idempotent on the count id.
  const countsStream = streamName(STREAM.inventory, 'counts');
  const inv = inventoryAdapter({ store: input.store, now: input.now });

  const foldReconciliations = async (tenantId: string): Promise<readonly StoredReconciliation[]> =>
    allOf<StoredReconciliation>(input.store, tenantId, countsStream, 'CountReconciled');

  return {
    now: input.now,

    // The authoritative M08 on-hand for this product at this location (0 if the position is unknown).
    onHand: async (tenantId, productId, locationId) => {
      const rows = await inv.availability(tenantId, productId);
      const here = rows.find((r) => r.productId === productId && r.locationId === locationId);
      return here?.onHandMinor ?? 0;
    },

    reconciliations: async (tenantId, productId, locationId) =>
      (await foldReconciliations(tenantId)).filter((r) => r.productId === productId && r.locationId === locationId),

    countExists: async (tenantId, countId) =>
      (await foldReconciliations(tenantId)).some((r) => r.countId === countId),

    recordReconciliation: async (tenantId, rec) => {
      await input.store.append(tenantId, countsStream, makeEvent({
        id: `count-${rec.countId}`,
        type: 'CountReconciled',
        occurredAt: rec.at,
        // The count's own id — a re-sent reconciliation of the same count collapses rather than
        // layering the correction twice (append-only, #2). A re-count is a NEW count id.
        idempotencyKey: `count-${tenantId}-${rec.countId}`,
        source: 'api/inventory',
        payload: rec,
      }));
    },
  };
}

export function productionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ProductionDeps {
  // Recipes and runs live on one append-only production stream, LAYERED on M08 (as counts does).
  // Recipes fold by id (latest wins); runs fold by id. The on-hand a run is checked against is M08
  // MINUS what prior runs at that location consumed — production is state-aware and M08 is not.
  const productionStream = streamName(STREAM.inventory, 'production');
  const inv = inventoryAdapter({ store: input.store, now: input.now });

  // Runs fold ProductionRunCommitted, then have their quality-release state merged from the
  // ProductionBatchReleased events — a batch is sellable only once a named releaser has passed it.
  const foldRuns = async (tenantId: string): Promise<readonly StoredRun[]> => {
    const committed = await allOf<StoredRun>(input.store, tenantId, productionStream, 'ProductionRunCommitted');
    const releases = await allOf<StoredRelease>(input.store, tenantId, productionStream, 'ProductionBatchReleased');
    const byRun = new Map(releases.map((r) => [r.runId, r] as const));
    return committed.map((run) => {
      const rel = byRun.get(run.runId);
      return rel === undefined
        ? { ...run, released: false, releasedBy: null, releasedAt: null }
        : { ...run, released: true, releasedBy: rel.releasedBy, releasedAt: rel.releasedAt };
    });
  };

  return {
    now: input.now,

    recipe: async (tenantId, recipeId) => {
      const registered = await allOf<Recipe>(input.store, tenantId, productionStream, 'RecipeRegistered');
      let latest: Recipe | undefined;
      for (const r of registered) if (r.recipeId === recipeId) latest = r; // last write wins
      return latest;
    },

    recordRecipe: async (tenantId, recipe) => {
      await input.store.append(tenantId, productionStream, makeEvent({
        id: `recipe-${recipe.recipeId}`,
        type: 'RecipeRegistered',
        occurredAt: input.now(),
        // A light signature in the key so re-registering the SAME recipe collapses, but a genuinely
        // changed recipe (different output, input count or shelf life) is a new fact and supersedes.
        idempotencyKey: `recipe-${tenantId}-${recipe.recipeId}-${recipe.outputQuantityMinor}-${recipe.inputs.length}-${recipe.shelfLifeHours}`,
        source: 'api/inventory',
        payload: recipe,
      }));
    },

    ingredientCost: async (tenantId, productId) => {
      const set = await allOf<{ productId: string; cost: Money }>(input.store, tenantId, productionStream, 'ProductionCostSet');
      let latest: Money | undefined;
      for (const s of set) if (s.productId === productId) latest = s.cost; // last write wins
      return latest;
    },

    recordCost: async (tenantId, productId, cost) => {
      await input.store.append(tenantId, productionStream, makeEvent({
        id: `prod-cost-${productId}`,
        type: 'ProductionCostSet',
        occurredAt: input.now(),
        // Keyed on the product + the value — re-setting the same cost collapses, a new value supersedes.
        idempotencyKey: `prod-cost-${tenantId}-${productId}-${cost.minor}-${cost.currency}`,
        source: 'api/inventory',
        payload: { productId, cost },
      }));
    },

    onHand: async (tenantId, productId, locationId) => {
      const rows = await inv.availability(tenantId, productId);
      const here = rows.find((r) => r.productId === productId && r.locationId === locationId);
      return here?.onHandMinor ?? 0;
    },

    priorConsumption: async (tenantId, locationId) => {
      const consumed: Record<string, number> = {};
      for (const run of await foldRuns(tenantId)) {
        if (run.locationId !== locationId) continue;
        for (const c of run.consumed) consumed[c.productId] = (consumed[c.productId] ?? 0) + c.quantityMinor;
      }
      return consumed;
    },

    runExists: async (tenantId, runId) =>
      (await allOf<StoredRun>(input.store, tenantId, productionStream, 'ProductionRunCommitted')).some((r) => r.runId === runId),

    runs: (tenantId) => foldRuns(tenantId),

    run: async (tenantId, runId) => (await foldRuns(tenantId)).find((r) => r.runId === runId),

    recordRun: async (tenantId, run) => {
      await input.store.append(tenantId, productionStream, makeEvent({
        id: `prod-run-${run.runId}`,
        type: 'ProductionRunCommitted',
        occurredAt: run.at,
        // The run's own id — a re-sent run collapses rather than consuming the ingredients twice
        // (append-only, #2). A re-make is a NEW run id.
        idempotencyKey: `prod-run-${tenantId}-${run.runId}`,
        source: 'api/inventory',
        payload: run,
      }));
    },

    recordRelease: async (tenantId, release) => {
      await input.store.append(tenantId, productionStream, makeEvent({
        id: `prod-release-${release.runId}`,
        type: 'ProductionBatchReleased',
        occurredAt: release.releasedAt,
        // The run's own id — a re-sent release collapses (append-only, #2); the batch is released once.
        idempotencyKey: `prod-release-${tenantId}-${release.runId}`,
        source: 'api/inventory',
        payload: release,
      }));
    },

    enabledDepartments: async (tenantId) => {
      const enabled = await allOf<{ departmentId: string }>(input.store, tenantId, productionStream, 'ProductionDepartmentEnabled');
      return [...new Set(enabled.map((e) => e.departmentId))];
    },

    recordDepartmentEnabled: async (tenantId, departmentId) => {
      await input.store.append(tenantId, productionStream, makeEvent({
        id: `prod-dept-${departmentId}`,
        type: 'ProductionDepartmentEnabled',
        occurredAt: input.now(),
        // Keyed on the department — enabling the same one twice collapses (append-only, #2).
        idempotencyKey: `prod-dept-${tenantId}-${departmentId}`,
        source: 'api/inventory',
        payload: { departmentId },
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

    /**
     * Stock valued at weighted-average cost (M08-FR-04, owner policy). Folds the WHOLE movement
     * history in occurrence order — the average depends on the sequence of receipts, so unlike
     * on-hand it cannot start from a quantity-only snapshot; correctness before speed, and a
     * valuation report is not the aisle hot-path. `unitCostMinor` on a `received` movement is the
     * price it re-averages at. Currency is the tenant base (INR default); the figure is minor units.
     */
    valuation: async (tenantId, productId) => {
      const events = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
      const movements = events
        .map((e) => payloadOf<Movement>(e))
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
      const rows = weightedAverageValuation(
        movements.map((m): ValuationMovement => ({
          productId: m.productId, locationId: m.locationId,
          effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor,
          isPurchaseReceipt: m.kind === 'received',
          ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }),
        })),
        'INR',
      );
      return productId === undefined ? rows : rows.filter((r) => r.productId === productId);
    },

    /**
     * Current remaining stock as receipt-dated, WAC-valued lots for the ageing report (M08-FR-04).
     * Reads the same `InventoryMoved` ledger as valuation and folds it through `agedStockLots`, which
     * computes the weighted-average pool and the FIFO remaining lots together so the ageing total
     * reconciles to the valuation's stock value. Filtered by product BEFORE folding, so a single
     * product's ageing (and its unvalued quantity) is exactly its own.
     */
    ageing: async (tenantId, productId) => {
      const events = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
      const movements = events
        .map((e) => payloadOf<Movement>(e))
        .filter((m) => productId === undefined || m.productId === productId);
      return agedStockLots(
        movements.map((m): DatedMovement => ({
          productId: m.productId, locationId: m.locationId,
          effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor,
          isPurchaseReceipt: m.kind === 'received',
          occurredAt: m.occurredAt, batchId: m.batchId ?? null,
          ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }),
        })),
        'INR',
      );
    },

    /**
     * Period inputs for stock productivity (M08-FR-04, turns/GMROI). Cross-domain by nature: COGS and
     * average inventory come from the inventory ledger at weighted-average, net sales from the POS
     * ledger de-grossed by the catalogue's per-product tax rate. Period COGS is the difference of the
     * cumulative WAC COGS at the two cut points (it is monotonic), and average inventory is the
     * two-point (opening+closing)/2. If ANY sold product has no known tax rate, net sales and gross
     * margin are left ABSENT so the route reports GMROI as not meaningful rather than guessing (P-08).
     */
    performance: async (tenantId, { from, to }) => {
      const events = await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' });
      const movements = events
        .map((e) => payloadOf<Movement>(e))
        .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
      // Cumulative WAC cogs and stock value PER PRODUCT at a cut point (summed across locations).
      const foldTo = (cutoff: string): Map<string, { cogs: number; value: number }> => {
        const rows = weightedAverageValuation(
          movements
            .filter((m) => m.occurredAt <= cutoff)
            .map((m): ValuationMovement => ({
              productId: m.productId, locationId: m.locationId,
              effect: EFFECT_ON_HAND[m.kind], quantityMinor: m.quantityMinor,
              isPurchaseReceipt: m.kind === 'received',
              ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }),
            })),
          'INR',
        );
        const byProduct = new Map<string, { cogs: number; value: number }>();
        for (const r of rows) {
          const acc = byProduct.get(r.productId) ?? { cogs: 0, value: 0 };
          acc.cogs += r.cogs.minor;
          acc.value += r.value.minor;
          byProduct.set(r.productId, acc);
        }
        return byProduct;
      };
      const opening = foldTo(from);
      const closing = foldTo(to);
      const periodDays = Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000));

      // Net (ex-tax) sales PER PRODUCT: MRP-style prices are tax-inclusive, so net = gross × 10000 /
      // (10000 + taxBps). A product sold with no known tax rate is marked so its margin stays absent.
      const sales = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from, to });
      const products = (await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished'))?.snapshot.products ?? [];
      const taxByProduct = new Map<string, number>(products.map((p) => [p.productId, p.taxBps]));
      const netByProduct = new Map<string, number>();
      const taxUnknown = new Set<string>();
      for (const e of sales) {
        const sale = payloadOf<{ readonly lines: readonly { readonly productId: string; readonly lineTotalMinor: number }[] }>(e);
        for (const line of sale.lines) {
          const taxBps = taxByProduct.get(line.productId);
          if (taxBps === undefined) { taxUnknown.add(line.productId); continue; }
          netByProduct.set(line.productId, (netByProduct.get(line.productId) ?? 0) + Number((BigInt(line.lineTotalMinor) * 10_000n) / BigInt(10_000 + taxBps)));
        }
      }

      const inr = (minor: number) => ({ minor, currency: 'INR' as const });
      const productIds = [...new Set<string>([...opening.keys(), ...closing.keys(), ...netByProduct.keys(), ...taxUnknown])].sort();
      const byProduct = productIds.map((productId) => {
        const o = opening.get(productId) ?? { cogs: 0, value: 0 };
        const c = closing.get(productId) ?? { cogs: 0, value: 0 };
        const cogs = c.cogs - o.cogs;
        const row = { productId, cogs: inr(cogs), averageInventory: inr(Math.round((o.value + c.value) / 2)) };
        // Absent net sales/margin for a product whose tax rate we do not know — never a guess (P-08).
        if (taxUnknown.has(productId)) return row;
        const netSales = netByProduct.get(productId) ?? 0;
        return { ...row, netSales: inr(netSales), grossMargin: inr(netSales - cogs) };
      });

      const sum = (pick: (r: (typeof byProduct)[number]) => Money | undefined): number =>
        byProduct.reduce((s, r) => s + (pick(r)?.minor ?? 0), 0);
      const totalCogs = sum((r) => r.cogs);
      const total = taxUnknown.size > 0
        // The store-wide margin cannot be complete if any sold product's revenue is unmeasurable.
        ? { cogs: inr(totalCogs), averageInventory: inr(sum((r) => r.averageInventory)) }
        : {
            cogs: inr(totalCogs),
            averageInventory: inr(sum((r) => r.averageInventory)),
            netSales: inr(sum((r) => ('netSales' in r ? r.netSales : undefined))),
            grossMargin: inr(sum((r) => ('grossMargin' in r ? r.grossMargin : undefined))),
          };
      return { from, to, periodDays, total, byProduct };
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

export function supplierPortalAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SupplierPortalDeps {
  return {
    now: input.now,

    // The latest configuration applies — grants and compliance can change, folded to their newest set.
    partner: async (tenantId, partnerId) =>
      latest<PartnerConfig>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierPartnerConfigured'),

    submissions: async (tenantId, partnerId) =>
      allOf<SubmissionRecord>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierSubmissionReceived'),

    // A statement line dedupes on its own document ref, so a status change (open → disputed → settled)
    // supersedes rather than recording the same invoice twice.
    statementLines: async (tenantId, partnerId) => {
      const all = await allOf<StatementLine>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierStatementLineRecorded');
      const byRef = new Map<string, StatementLine>();
      for (const l of all) byRef.set(l.documentRef, l);
      return [...byRef.values()];
    },

    opening: async (tenantId, partnerId) =>
      (await latest<{ openingMinor: number }>(input.store, tenantId, forPortalPartner(partnerId), 'SupplierStatementOpeningSet'))?.openingMinor ?? 0,

    recordPartner: async (tenantId, partnerId, config) => {
      // A compact digest of the documents so re-sending an identical config collapses, but any change
      // — a new document, a verification, a changed expiry — is a new fact and the latest applies.
      const docsDigest = config.documents
        .map((d) => `${d.documentId}:${d.kind}:${d.validUntil}:${d.verifiedBy ?? 'unv'}`)
        .sort()
        .join(',');
      await input.store.append(tenantId, forPortalPartner(partnerId), makeEvent({
        id: `portal-partner-${partnerId}-${config.grants.join('.')}`,
        type: 'SupplierPartnerConfigured',
        occurredAt: input.now(),
        idempotencyKey: `portal-partner-${tenantId}-${partnerId}-${config.grants.join('.')}-${config.requiredDocuments.join('.')}-${docsDigest}`,
        source: 'api/purchase',
        payload: config,
      }));
    },

    recordSubmission: async (tenantId, partnerId, record) => {
      await input.store.append(tenantId, forPortalPartner(partnerId), makeEvent({
        id: `portal-sub-${record.submissionId}`,
        type: 'SupplierSubmissionReceived',
        occurredAt: record.receivedAt,
        // The submission's own id — a retried submission collapses rather than becoming a second one.
        idempotencyKey: `portal-sub-${tenantId}-${record.submissionId}`,
        source: 'api/purchase',
        payload: record,
      }));
    },

    recordStatementLine: async (tenantId, partnerId, line) => {
      await input.store.append(tenantId, forPortalPartner(partnerId), makeEvent({
        id: `portal-stmt-${partnerId}-${line.documentRef}-${line.status}`,
        type: 'SupplierStatementLineRecorded',
        occurredAt: input.now(),
        // Keyed on the line and its status so a re-send collapses but a status change is a new fact.
        idempotencyKey: `portal-stmt-${tenantId}-${partnerId}-${line.documentRef}-${line.kind}-${line.amountMinor}-${line.status}`,
        source: 'api/purchase',
        payload: line,
      }));
    },

    recordOpening: async (tenantId, partnerId, openingMinor) => {
      await input.store.append(tenantId, forPortalPartner(partnerId), makeEvent({
        id: `portal-opening-${partnerId}-${openingMinor}`,
        type: 'SupplierStatementOpeningSet',
        occurredAt: input.now(),
        idempotencyKey: `portal-opening-${tenantId}-${partnerId}-${openingMinor}`,
        source: 'api/purchase',
        payload: { openingMinor },
      }));
    },
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

    /**
     * Held, not lapsed and not released. An expired hold is stock on the shelf; a released hold
     * (a cancelled order, M18-FR-04) is stock back on the shelf too — a cancel that forgot to
     * subtract here is the commonest phantom out-of-stock, so the release ledger is folded in.
     */
    outstanding: async (tenantId, locationId) => {
      const held = await allOf<Reservation>(input.store, tenantId, forLocation(locationId), 'ReservationHeld');
      const released = await releasedIds(input.store, tenantId, locationId);
      const lapsed = new Set(expired(held, input.now()).map((r) => r.reservationId));
      return held.filter((r) => !released.has(r.reservationId) && !lapsed.has(r.reservationId));
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

    /**
     * Record the order so it can be read and moved through its lifecycle (M18-FR-01). Idempotent
     * on the order id: a re-promise of an already-placed order does not overwrite how it began.
     */
    recordPlaced: async (tenantId, order: PlacedOrder) => {
      await input.store.append(tenantId, forOrder(order.orderId), makeEvent({
        id: `ord-placed-${order.orderId}`,
        type: 'OrderPlaced',
        occurredAt: order.placedAt,
        idempotencyKey: `ord-placed-${tenantId}-${order.orderId}`,
        source: 'api/orders',
        payload: order,
      }));
    },

    /** Current lifecycle state — the placed record plus the last transition; a fold, never a field. */
    orderState: async (tenantId, orderId): Promise<OrderStateView | undefined> => {
      const placed = await latest<PlacedOrder>(input.store, tenantId, forOrder(orderId), 'OrderPlaced');
      if (placed === undefined) return undefined;
      const transitions = await allOf<OrderTransition>(input.store, tenantId, forOrder(orderId), 'OrderTransitioned');
      const last = transitions[transitions.length - 1];
      return {
        state: last === undefined ? placed.state : last.to,
        locationId: placed.locationId,
        lines: placed.lines,
      };
    },

    /** This order's reservations that are still holding stock — held, not released, not lapsed. */
    orderReservations: async (tenantId, orderId, locationId) => {
      const held = await allOf<Reservation>(input.store, tenantId, forLocation(locationId), 'ReservationHeld');
      const released = await releasedIds(input.store, tenantId, locationId);
      const lapsed = new Set(expired(held, input.now()).map((r) => r.reservationId));
      return held.filter((r) =>
        r.orderId === orderId && !released.has(r.reservationId) && !lapsed.has(r.reservationId));
    },

    recordTransition: async (tenantId, t: OrderTransition) => {
      await input.store.append(tenantId, forOrder(t.orderId), makeEvent({
        id: `ord-txn-${t.orderId}-${t.event}`,
        type: 'OrderTransitioned',
        occurredAt: t.at,
        idempotencyKey: `ord-txn-${tenantId}-${t.orderId}-${t.event}`,
        source: 'api/orders',
        payload: t,
      }));
    },

    /**
     * Give every reservation back — a compensating release event per hold, never an edit of the
     * hold (ledgers are append-only, hard rule #2). Idempotent on the reservation id.
     */
    releaseReservations: async (tenantId, rs) => {
      for (const r of rs) {
        await input.store.append(tenantId, forLocation(r.locationId), makeEvent({
          id: `res-rel-${r.reservationId}`,
          type: 'ReservationReleased',
          occurredAt: input.now(),
          idempotencyKey: `res-rel-${tenantId}-${r.reservationId}`,
          source: 'api/orders',
          payload: {
            reservationId: r.reservationId, orderId: r.orderId,
            productId: r.productId, locationId: r.locationId, at: input.now(),
          },
        }));
      }
    },
  };
}

/** The set of reservation ids released (cancelled) at a location — folded from the release ledger. */
async function releasedIds(
  store: EventStore, tenantId: string, locationId: string,
): Promise<ReadonlySet<string>> {
  const released = await allOf<{ reservationId: string }>(
    store, tenantId, forLocation(locationId), 'ReservationReleased');
  return new Set(released.map((r) => r.reservationId));
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

export function priceListAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PriceListDeps {
  // Each product's price-list entries fold its own stream. Append-only — a change is a new entry with a
  // higher version, never an overwrite (§29.1); resolvePrice picks the one that applies at a moment.
  return {
    now: input.now,

    entries: (tenantId, productId) =>
      allOf<PriceEntry>(input.store, tenantId, forPriceList(productId), 'PriceListEntryPublished'),

    recordEntry: async (tenantId, productId, entry) => {
      await input.store.append(tenantId, forPriceList(productId), makeEvent({
        id: `price-entry-${productId}-${entry.id}`,
        type: 'PriceListEntryPublished',
        occurredAt: input.now(),
        // The entry's own id — a re-sent publish collapses rather than drawing a second version.
        idempotencyKey: `price-entry-${tenantId}-${productId}-${entry.id}`,
        source: 'api/pricing',
        payload: entry,
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

export function promotionCatalogueAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PromotionCatalogueDeps {
  // Promotions are low-volume (a shop runs tens, not millions), so all fold one tenant stream. A
  // definition sets the rule as a DRAFT; activate/stop move only its status — the latest state wins.
  const foldPromotions = async (tenantId: string): Promise<readonly Promotion[]> => {
    const events = await input.store.readStream(tenantId, STREAM.promotions);
    const byId = new Map<string, Promotion>();
    for (const e of events) {
      const p = e.event.payload as Record<string, unknown>;
      if (e.event.type === 'PromotionDefined') {
        byId.set(p['id'] as string, p as unknown as Promotion);
      } else if (e.event.type === 'PromotionActivated') {
        const cur = byId.get(p['promotionId'] as string);
        if (cur !== undefined) byId.set(cur.id, { ...cur, status: 'active' });
      } else if (e.event.type === 'PromotionStopped') {
        const cur = byId.get(p['promotionId'] as string);
        if (cur !== undefined) byId.set(cur.id, { ...cur, status: 'stopped' });
      }
    }
    return [...byId.values()];
  };

  return {
    now: input.now,

    promotions: (tenantId) => foldPromotions(tenantId),
    promotion: async (tenantId, promotionId) => (await foldPromotions(tenantId)).find((p) => p.id === promotionId),

    recordDefined: async (tenantId, promo) => {
      await input.store.append(tenantId, STREAM.promotions, makeEvent({
        id: `promo-def-${promo.id}`,
        type: 'PromotionDefined',
        occurredAt: input.now(),
        // The promotion's own id — a re-sent definition collapses (create-once; the route refuses a redefine).
        idempotencyKey: `promo-def-${tenantId}-${promo.id}`,
        source: 'api/pricing',
        payload: promo,
      }));
    },

    recordStatus: async (tenantId, promotionId, status, at) => {
      await input.store.append(tenantId, STREAM.promotions, makeEvent({
        id: `promo-${status}-${promotionId}`,
        type: status === 'active' ? 'PromotionActivated' : 'PromotionStopped',
        occurredAt: at,
        // One activate, one stop per promotion — a re-sent transition collapses.
        idempotencyKey: `promo-${status}-${tenantId}-${promotionId}`,
        source: 'api/pricing',
        payload: { promotionId },
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

    /**
     * The tenant's whole dataset, certified complete (M36-FR-03). The store read is
     * `tenant_id`-scoped, so a tenant only ever exports its own history — the critical isolation
     * guarantee (§35). The ledger is grouped into the product's declared data domains (the STREAM
     * roots) and run through `buildTenantExport`, which refuses to call the result complete unless
     * every declared domain is present — with zero rows where empty, absence and emptiness being
     * different facts — and each is checksummed, because an export nobody can verify is a file, not
     * evidence (P-06 / OD-09). Deriving the domain list from the same constant the writes use is
     * what stops the exporter quietly falling behind the product.
     */
    exportTenant: async (tenantId, requestedBy) => {
      const byDomain = new Map<string, ExportedEvent[]>();
      for (const r of await input.store.exportTenant(tenantId)) {
        const domain = r.stream.split(PART)[0] ?? r.stream;
        const mapped: ExportedEvent = {
          seq: r.seq, stream: r.stream, id: r.event.id, type: r.event.type,
          occurredAt: r.event.occurredAt, idempotencyKey: r.event.idempotencyKey,
          source: r.event.source, version: r.event.version, payload: r.event.payload,
        };
        const list = byDomain.get(domain);
        if (list === undefined) byDomain.set(domain, [mapped]); else list.push(mapped);
      }
      const declaredDomains = [...new Set<string>(Object.values(STREAM))];
      const domains = declaredDomains.map((domain) => {
        const rows = byDomain.get(domain) ?? [];
        const serialized = JSON.stringify(rows);
        return {
          domain, rows: rows.length, format: 'jsonl' as const,
          checksum: createHash('sha256').update(serialized).digest('hex'),
          bytes: Buffer.byteLength(serialized, 'utf8'),
          tenantId,
        };
      });
      const manifest = buildTenantExport({
        exportId: `exp-${tenantId}-${input.now()}`,
        tenantId, requestedBy, declaredDomains, domains, at: input.now(),
      });
      const data: Record<string, readonly ExportedEvent[]> = {};
      for (const [domain, evs] of byDomain) data[domain] = evs;
      return { manifest, data };
    },

    /**
     * Branding is versioned and append-only: each set is a new fact with a time in its key, so
     * "what did the brand look like then, and who changed it" is answerable, and the current brand
     * is the LATEST set — a fold, never an overwritten field (hard rule #2).
     */
    setBranding: async (tenantId, branding) => {
      const at = input.now();
      await input.store.append(tenantId, STREAM.platform, makeEvent({
        id: `branding-${tenantId}-${at}`,
        type: 'TenantBrandingSet',
        occurredAt: at,
        idempotencyKey: `branding-${tenantId}-${at}`,
        source: 'api/platform',
        payload: branding,
      }));
    },

    branding: (tenantId) => latest<TenantBranding>(input.store, tenantId, STREAM.platform, 'TenantBrandingSet'),

    /** An entitlement change is append-only and audited — who turned a module on, and when. */
    setEntitlement: async (tenantId, feature, enabled, by) => {
      const at = input.now();
      await input.store.append(tenantId, STREAM.platform, makeEvent({
        id: `entitlement-${feature}-${at}`,
        type: 'TenantEntitlementSet',
        occurredAt: at,
        // Time is in the key: turning a feature off and back on are two facts worth keeping.
        idempotencyKey: `entitlement-${tenantId}-${feature}-${at}`,
        source: 'api/platform',
        payload: { feature, enabled, at, by },
      }));
    },

    /** The features currently ON — folded forward, latest change per feature wins, default off. */
    entitlements: async (tenantId) => {
      const changes = await allOf<{ feature: string; enabled: boolean }>(
        input.store, tenantId, STREAM.platform, 'TenantEntitlementSet');
      const state = new Map<string, boolean>();
      for (const c of changes) state.set(c.feature, c.enabled);
      return [...state.entries()].filter(([, on]) => on).map(([f]) => f);
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
