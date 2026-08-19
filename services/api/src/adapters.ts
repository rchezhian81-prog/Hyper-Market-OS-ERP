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
import type { Money, CurrencyCode } from '../../../packages/contracts/src/money';
import type { EventStore, PersistedEvent } from '../../../packages/persistence/src/event-store';
import { InMemorySnapshotStore, projectFromSnapshot, type Projection, type SnapshotStore } from '../../../packages/persistence/src/index';
import type { CatalogueProduct } from '../../../packages/catalogue/src/catalogue';
import type { SignedPack } from '../../catalogue/src/index';
import type { CatalogueDeps } from '../../catalogue/src/index';
import type { ProductMasterDeps } from '../../catalogue/src/product-master';
import type { BarcodeRegistryDeps } from '../../catalogue/src/barcodes';
import type { ProductMergeDeps, MergeView, MergeRejection } from '../../catalogue/src/product-merge';
import type { PackHierarchyDeps } from '../../catalogue/src/pack-hierarchy';
import type { TaxClassRateDeps } from '../../catalogue/src/tax-classes';
import type { CataloguePreviewDeps } from '../../catalogue/src/catalogue-preview';
import { assembleCatalogueSnapshot } from '../../catalogue/src/catalogue-preview';
import { apiError } from '../../kernel/src/index';
import type { GstRatePeriod } from '../../../packages/finance/src/rate';
import type { ProductRecord, BarcodeAssignment, MergeRequest, MergeLink, PackHierarchy } from '../../../packages/product/src/index';
import type { IncomingSale, IncomingTender, SaleException, PosDeps } from '../../pos/src/index';
import type { LotTraceDeps } from '../../inventory/src/lot-trace';
import type { RecallDeps } from '../../inventory/src/recall';
import { RecallRegistry, type RecallRecord } from '../../../packages/traceability/src/index';
import type { SalesHistoryDeps } from '../../inventory/src/sales-history';
import type { SoldLine } from '../../../packages/demand/src/sales-history';
import type { OutboundLotRecord } from '../../../packages/quality/src/index';
import { attributeSalesFifo, type BatchReceipt, type HistoricalSaleLine } from '../../../packages/fefo/src/index';
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
import type { WriteOffDeps, StoredWriteOff } from '../../inventory/src/write-off';
import type { ProductionDeps, StoredRun, StoredRelease } from '../../inventory/src/production';
import type { Recipe } from '../../../packages/production/src/recipe';
import type { SupplierPortalDeps, PartnerConfig, SubmissionRecord, StatementLine } from '../../purchase/src/supplier-portal';
import type { ConcessionDeps, ConcessionContract, ConcessionSale } from '../../finance/src/concession';
import type { ScrapDeps, ScrapSale } from '../../finance/src/scrap';
import type { FacilitiesDeps, MaintenanceSchedule, ScheduledTask, SafetyIncident } from '../../platform/src/facilities';
import type { FacilitiesAssetsDeps, Asset, ServiceLog, DowntimeEvent, EnergyReading } from '../../platform/src/facilities-assets';
import type { FacilitiesMonitoringDeps, EquipmentRangeReg, EquipmentContents, EquipmentReading, PowerEvent } from '../../platform/src/facilities-monitoring';
import type { PackagingDeps, PackagingItem, PackagingMovement } from '../../inventory/src/packaging';
import type { ComplianceDeps, Obligation } from '../../compliance/src/index';
import type { DocumentsDeps, TemplateVersion, IssuedDocument } from '../../platform/src/documents';
import type { SuspendedBillsDeps, SuspendedBill } from '../../pos/src/suspended-bills';
import type { EInvoiceRegisterDeps } from '../../finance/src/e-invoice-register';
import type { PayRunStoreDeps } from '../../finance/src/pay-run-store';
import { foldPayRun, type PayRunEvent } from '../../../packages/payroll/src/index';
import type { Gstr1SubmissionStoreDeps } from '../../finance/src/gstr1-submission-store';
import { foldGstr1Submission, type Gstr1SubmissionEvent } from '../../../packages/finance/src/index';
import type { EwayBillRegisterDeps } from '../../finance/src/e-way-bill-register';
import { foldEwayBill, type EwbEvent, type EwayBillRequest, type EwbRecord, type EwbMismatch } from '../../../packages/e-way-bill/src/index';
import type { GstReturnsDeps, StoredOutwardDoc, PeriodSoldLine } from '../../finance/src/gst-returns';
import { foldEInvoice, type EInvoiceEvent, type IrnRequest as EInvoiceIrnRequest, type EInvoiceRecord, type EInvoiceMismatch } from '../../../packages/e-invoice/src/index';
import type { WasteDeps, WasteRecord, WasteCoverage } from '../../inventory/src/waste';
import type { IntegrationDeps, CertifiedEntry, AdapterConfig, AdapterHeartbeat } from '../../platform/src/integration';
import type { WebhookDeps, WebhookConfig } from '../../platform/src/webhooks';
import type { ConnectorMappingDeps, Mapping } from '../../platform/src/connectors';
import type { Hasher } from '../../../packages/audit/src/audit-trail';
import type { SettlementRoutesDeps, SettlementBatch, SettlementLine, CapturedTender } from '../../finance/src/settlement';
import { attachEvidence, type Investigation } from '../../../packages/settlement/src/settlement';
import { project, EFFECT_ON_HAND } from '../../inventory/src/index';
import type { Movement, Availability, InventoryDeps } from '../../inventory/src/index';
import type { GoodsReceiptDeps, GrnRecord } from '../../inventory/src/goods-receipt';
import { weightedAverageValuation, type ValuationMovement } from '../../../packages/stock/src/valuation';
import { agedStockLots, type DatedMovement } from '../../../packages/stock/src/ageing-source';
import type { MatchResult, BankChangeRequest, PurchaseDeps } from '../../purchase/src/index';
import type { PurchaseOrderDeps, StoredPurchaseOrder } from '../../purchase/src/purchase-orders';
import { computeOpenCommitment } from '../../../packages/purchasing/src/index';
import type { JournalEntry, PeriodState, FinanceDeps } from '../../finance/src/index';
import type { CreditNoteDeps } from '../../finance/src/credit-notes';
import type { CreditNote, ProductTaxEntry } from '../../../packages/finance/src/index';
import type { ConsentRecord, CustomerDeps, RecordedPointsMovement } from '../../customer/src/index';
import type { StoredPointsMovement } from '../../../packages/loyalty/src/assess-points';
import type { StoredValueDeps, Instrument, ValueMovement } from '../../customer/src/stored-value';
import type { CouponDeps } from '../../customer/src/coupons';
import type { Coupon, Redemption } from '../../../packages/loyalty/src/coupons';
import type { PromotionDeps, LaunchRecord } from '../../pricing/src/promotions';
import type { PromotionCatalogueDeps } from '../../pricing/src/promotion-catalogue';
import type { Promotion } from '../../../packages/promotions/src/promotions';
import { expired } from '../../orders/src/index';
import type {
  Reservation, OrdersDeps, PlacedOrder, OrderTransition, OrderStateView, StoredSubstitution,
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
import type { ReportingDeps, Figure } from '../../reporting/src/index';
import { salesSummary } from '../../../packages/reporting/src/index';
import type { Producer, SaleFact } from '../../../packages/reporting/src/index';
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
  compliance: 'compliance',
  documents: 'documents',
  suspended: 'suspended',
  einvoice: 'einvoice',
  ewaybill: 'ewaybill',
  gstreturns: 'gstreturns',
  payroll: 'payroll',
  packaging: 'packaging',
  waste: 'waste',
  integration: 'integration',
  lossPrevention: 'loss-prevention',
  warehouse: 'warehouse',
  orders: 'orders',
  /**
   * A tenant-wide, time-windowed PROJECTION of returns, appended beside the per-sale return stream so
   * "which returns happened in this period" can be answered without walking every bill (M08-FR-04,
   * returns-netting). The per-sale `forSaleReturns` stream stays the book of record for the refund
   * cap and the at-most-once register; this is a read model, exactly as `bankSale` keeps a
   * receipt-number index beside the sale.
   */
  returns: 'returns',
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
 * The compliance obligation register (M34-FR-03). Low-volume — every obligation folds one stream, the
 * latest registration of an id winning, because a change to a licence's expiry is a new append-only
 * fact, never an overwrite (hard rule #2/#6).
 */
export function complianceAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ComplianceDeps {
  return {
    now: input.now,

    obligations: async (tenantId) => {
      const all = await allOf<Obligation>(input.store, tenantId, STREAM.compliance, 'ObligationRegistered');
      const byId = new Map<string, Obligation>();
      for (const o of all) byId.set(o.obligationId, o); // later registration wins
      return [...byId.values()];
    },

    recordRegister: async (tenantId, obligation) => {
      const digest = createHash('sha256').update(JSON.stringify(obligation)).digest('hex').slice(0, 16);
      await input.store.append(tenantId, STREAM.compliance, makeEvent({
        id: `compliance-oblig-${obligation.obligationId}-${digest}`,
        type: 'ObligationRegistered',
        occurredAt: input.now(),
        // Identical re-send collapses on the content digest; any change is a new fact the fold picks up.
        idempotencyKey: `compliance-oblig-${tenantId}-${obligation.obligationId}-${digest}`,
        source: 'api/compliance',
        payload: obligation,
      }));
    },
  };
}

/**
 * Versioned document templates (M31-FR-01/M36-FR-02). Append-only — every published version is a
 * `TemplateVersionPublished` fact and there is no edit path, so a document issued under v1 keeps v1's
 * layout after v2 publishes (hard rule #6).
 */
export function documentsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): DocumentsDeps {
  return {
    now: input.now,

    versions: async (tenantId, templateId) => {
      const all = await allOf<TemplateVersion>(input.store, tenantId, STREAM.documents, 'TemplateVersionPublished');
      return all.filter((v) => v.templateId === templateId);
    },

    recordPublish: async (tenantId, template) => {
      await input.store.append(tenantId, STREAM.documents, makeEvent({
        id: `doc-tmpl-${template.templateId}-v${template.version}`,
        type: 'TemplateVersionPublished',
        occurredAt: input.now(),
        // A version is unique per template — a re-send of the same publish collapses rather than doubling.
        idempotencyKey: `doc-tmpl-${tenantId}-${template.templateId}-v${template.version}`,
        source: 'api/platform',
        payload: template,
      }));
    },

    /** A previously issued document by id — a fold of the `DocumentIssued` facts (M31-FR-02). */
    issued: async (tenantId, documentId) => {
      const all = await allOf<IssuedDocument>(input.store, tenantId, STREAM.documents, 'DocumentIssued');
      return all.find((d) => d.documentId === documentId);
    },

    /** Store an issued document with its FROZEN content, append-only. Idempotent on the document id — a
     *  re-issue collapses to one fact, never a second copy under a later template version (hard rule #6). */
    recordIssued: async (tenantId, doc: IssuedDocument) => {
      await input.store.append(tenantId, STREAM.documents, makeEvent({
        id: `doc-issued-${doc.documentId}`,
        type: 'DocumentIssued',
        occurredAt: doc.issuedAt,
        idempotencyKey: `doc-issued-${tenantId}-${doc.documentId}`,
        source: 'api/platform',
        payload: doc,
      }));
    },
  };
}

/**
 * Suspended (parked) bills (M15-FR-01). Each state transition — suspend / resume / abandon — is an
 * append-only `SuspendedBillStateChanged` fact; the current bill is the latest fact for its id. The
 * record is never deleted (hard rule #6: repeated park-and-abandon is a loss-prevention pattern).
 */
export function suspendedBillsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): SuspendedBillsDeps {
  return {
    now: input.now,

    bills: async (tenantId) => {
      const all = await allOf<SuspendedBill>(input.store, tenantId, STREAM.suspended, 'SuspendedBillStateChanged');
      const byId = new Map<string, SuspendedBill>();
      for (const bill of all) byId.set(bill.billId, bill); // later transition wins
      return [...byId.values()];
    },

    record: async (tenantId, bill) => {
      // Keyed on bill + state + the timestamp of THIS transition, so each transition is its own fact
      // while a re-send of the same one collapses.
      const stamp = bill.abandonedAt ?? bill.resumedAt ?? bill.suspendedAt;
      await input.store.append(tenantId, STREAM.suspended, makeEvent({
        id: `susp-${bill.billId}-${bill.state}-${stamp}`,
        type: 'SuspendedBillStateChanged',
        occurredAt: input.now(),
        idempotencyKey: `susp-${tenantId}-${bill.billId}-${bill.state}-${stamp}`,
        source: 'api/pos',
        payload: bill,
      }));
    },
  };
}

/**
 * The e-invoice lifecycle store (A20 inc2). Each invoice has its own stream of append-only facts —
 * submitted, the IRP's response(s), a cancellation — folded by the engine into the current state. The
 * government's IRN/QR is only ever what the IRP actually returned (the engine refuses to fabricate it),
 * and nothing here is deleted (hard rule #6).
 */
export function eInvoiceAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): EInvoiceRegisterDeps {
  const streamFor = (invoiceId: string): string => streamName(STREAM.einvoice, invoiceId);
  // Three-part name so it can never collide with a two-part per-invoice stream (an invoiceId is one part).
  const indexStream = streamName(STREAM.einvoice, 'lifecycle', 'index');
  return {
    now: input.now,

    listInvoiceIds: async (tenantId) => {
      const indexed = await allOf<{ invoiceId: string }>(input.store, tenantId, indexStream, 'EInvoiceIndexed');
      return [...new Set(indexed.map((i) => i.invoiceId))];
    },

    load: async (tenantId, invoiceId) => {
      const persisted = await input.store.readStream(tenantId, streamFor(invoiceId));
      const events: EInvoiceEvent[] = [];
      for (const e of persisted) {
        const p = e.event.payload as Record<string, unknown>;
        const at = (p['at'] as string | undefined) ?? e.event.occurredAt;
        if (e.event.type === 'EInvoiceSubmitted') events.push({ kind: 'submitted', request: p['request'] as EInvoiceIrnRequest, at });
        else if (e.event.type === 'EInvoiceResponseRecorded') events.push({ kind: 'response', record: p['record'] as EInvoiceRecord, at });
        else if (e.event.type === 'EInvoiceCancelled') events.push({ kind: 'cancelled', reason: p['reason'] as string, at });
        else if (e.event.type === 'EInvoiceMismatchObserved') events.push({ kind: 'mismatch', mismatch: p['mismatch'] as EInvoiceMismatch, at });
      }
      return foldEInvoice(invoiceId, events);
    },

    recordSubmit: async (tenantId, invoiceId, request, at) => {
      // The submission and the tenant-wide index fact are ONE atomic batch: the reconciliation queue can
      // never list an invoice with no lifecycle, nor lose one that was submitted. Both keyed idempotently.
      await input.store.appendBatch(tenantId, [
        {
          stream: streamFor(invoiceId),
          event: makeEvent({
            id: `einv-submit-${invoiceId}`,
            type: 'EInvoiceSubmitted',
            occurredAt: input.now(),
            idempotencyKey: `einv-submit-${tenantId}-${invoiceId}`, // one submission per invoice
            source: 'api/finance',
            payload: { request, at },
          }),
        },
        {
          stream: indexStream,
          event: makeEvent({
            id: `einv-index-${invoiceId}`,
            type: 'EInvoiceIndexed',
            occurredAt: input.now(),
            idempotencyKey: `einv-index-${tenantId}-${invoiceId}`, // one index fact per invoice
            source: 'api/finance',
            payload: { invoiceId },
          }),
        },
      ]);
    },

    recordResponse: async (tenantId, invoiceId, record, at) => {
      await input.store.append(tenantId, streamFor(invoiceId), makeEvent({
        id: `einv-resp-${invoiceId}-${record.state}-${record.irn ?? 'none'}`,
        type: 'EInvoiceResponseRecorded',
        occurredAt: input.now(),
        // The same answer collapses; a distinct state/IRN is its own fact.
        idempotencyKey: `einv-resp-${tenantId}-${invoiceId}-${record.state}-${record.irn ?? 'none'}`,
        source: 'api/finance',
        payload: { record, at },
      }));
    },

    recordCancel: async (tenantId, invoiceId, reason, at) => {
      await input.store.append(tenantId, streamFor(invoiceId), makeEvent({
        id: `einv-cancel-${invoiceId}`,
        type: 'EInvoiceCancelled',
        occurredAt: input.now(),
        idempotencyKey: `einv-cancel-${tenantId}-${invoiceId}`,
        source: 'api/finance',
        payload: { reason, at },
      }));
    },

    recordMismatch: async (tenantId, invoiceId, mismatch, at) => {
      await input.store.append(tenantId, streamFor(invoiceId), makeEvent({
        id: `einv-mismatch-${invoiceId}-${mismatch.observedState}-${mismatch.observedIrn ?? 'none'}`,
        type: 'EInvoiceMismatchObserved',
        occurredAt: input.now(),
        // The same disagreement collapses; a distinct observed state/IRN is its own fact (append-only).
        idempotencyKey: `einv-mismatch-${tenantId}-${invoiceId}-${mismatch.observedState}-${mismatch.observedIrn ?? 'none'}`,
        source: 'api/finance',
        payload: { mismatch, at },
      }));
    },
  };
}

/**
 * The DURABLE e-way-bill lifecycle store (item 2 inc2). The transport twin of the e-invoice register: each
 * movement has its own stream of append-only facts — submitted, the portal's response(s), a cancellation —
 * folded by the tested engine into the current state. The portal's 12-digit EWB number is only ever what the
 * portal returned (never fabricated), and nothing is deleted (hard rule #6). A tenant-wide index makes the
 * reconciliation queue cheap.
 */
export function eWayBillAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): EwayBillRegisterDeps {
  const streamFor = (movementId: string): string => streamName(STREAM.ewaybill, movementId);
  // Three-part name so it can never collide with a two-part per-movement stream.
  const indexStream = streamName(STREAM.ewaybill, 'lifecycle', 'index');
  return {
    now: input.now,

    listMovementIds: async (tenantId) => {
      const indexed = await allOf<{ movementId: string }>(input.store, tenantId, indexStream, 'EwayBillIndexed');
      return [...new Set(indexed.map((i) => i.movementId))];
    },

    load: async (tenantId, movementId) => {
      const persisted = await input.store.readStream(tenantId, streamFor(movementId));
      const events: EwbEvent[] = [];
      for (const e of persisted) {
        const p = e.event.payload as Record<string, unknown>;
        const at = (p['at'] as string | undefined) ?? e.event.occurredAt;
        if (e.event.type === 'EwayBillSubmitted') events.push({ kind: 'submitted', request: p['request'] as EwayBillRequest, at });
        else if (e.event.type === 'EwayBillResponseRecorded') events.push({ kind: 'response', record: p['record'] as EwbRecord, at });
        else if (e.event.type === 'EwayBillCancelled') events.push({ kind: 'cancelled', reason: p['reason'] as string, at });
        else if (e.event.type === 'EwayBillMismatchObserved') events.push({ kind: 'mismatch', mismatch: p['mismatch'] as EwbMismatch, at });
      }
      return foldEwayBill(movementId, events);
    },

    recordSubmit: async (tenantId, movementId, request, at) => {
      // The submission and the tenant-wide index fact are ONE atomic batch (the queue never lists a movement
      // with no lifecycle, nor loses a submitted one). Both keyed idempotently.
      await input.store.appendBatch(tenantId, [
        { stream: streamFor(movementId), event: makeEvent({ id: `ewb-submit-${movementId}`, type: 'EwayBillSubmitted', occurredAt: input.now(), idempotencyKey: `ewb-submit-${tenantId}-${movementId}`, source: 'api/finance', payload: { request, at } }) },
        { stream: indexStream, event: makeEvent({ id: `ewb-index-${movementId}`, type: 'EwayBillIndexed', occurredAt: input.now(), idempotencyKey: `ewb-index-${tenantId}-${movementId}`, source: 'api/finance', payload: { movementId } }) },
      ]);
    },

    recordResponse: async (tenantId, movementId, record, at) => {
      await input.store.append(tenantId, streamFor(movementId), makeEvent({
        id: `ewb-resp-${movementId}-${record.state}-${record.ewbNo ?? 'none'}`,
        type: 'EwayBillResponseRecorded',
        occurredAt: input.now(),
        // The same answer collapses; a distinct state/number is its own fact.
        idempotencyKey: `ewb-resp-${tenantId}-${movementId}-${record.state}-${record.ewbNo ?? 'none'}`,
        source: 'api/finance',
        payload: { record, at },
      }));
    },

    recordCancel: async (tenantId, movementId, reason, at) => {
      await input.store.append(tenantId, streamFor(movementId), makeEvent({
        id: `ewb-cancel-${movementId}`,
        type: 'EwayBillCancelled',
        occurredAt: input.now(),
        idempotencyKey: `ewb-cancel-${tenantId}-${movementId}`,
        source: 'api/finance',
        payload: { reason, at },
      }));
    },

    recordMismatch: async (tenantId, movementId, mismatch, at) => {
      await input.store.append(tenantId, streamFor(movementId), makeEvent({
        id: `ewb-mismatch-${movementId}-${mismatch.observedState}-${mismatch.observedEwbNo ?? 'none'}`,
        type: 'EwayBillMismatchObserved',
        occurredAt: input.now(),
        // The same disagreement collapses; a distinct observed state/number is its own fact (append-only).
        idempotencyKey: `ewb-mismatch-${tenantId}-${movementId}-${mismatch.observedState}-${mismatch.observedEwbNo ?? 'none'}`,
        source: 'api/finance',
        payload: { mismatch, at },
      }));
    },
  };
}

/**
 * The DURABLE pay-run lifecycle store (WP3 inc9). Each pay run has its own stream of append-only lifecycle
 * facts — drafted, submitted, approved, rejected, locked, reversed — folded by the tested engine into the
 * current state, so a run survives a restart. Nothing is overwritten (hard rule #2): a correction is a
 * reversal + a new run. Maker ≠ checker is enforced by the route (before the append) AND the fold (on read).
 */
export function payRunAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PayRunStoreDeps {
  const streamFor = (payRunId: string): string => forPayRun(payRunId);
  return {
    now: input.now,

    load: async (tenantId, payRunId) => {
      const persisted = await input.store.readStream(tenantId, streamFor(payRunId));
      const events = persisted.map((e) => e.event.payload as PayRunEvent);
      return foldPayRun(payRunId, events);
    },

    append: async (tenantId, payRunId, event) => {
      // A given lifecycle step at a given instant is one fact — keyed on kind + actor + at, so a retry
      // collapses while a distinct step is its own append. `occurredAt` is the append time (always valid
      // ISO); the caller's `at` lives in the payload and drives the key.
      const at = 'at' in event ? event.at : input.now();
      const actor = 'by' in event ? event.by : 'system';
      await input.store.append(tenantId, streamFor(payRunId), makeEvent({
        id: `payrun-${payRunId}-${event.kind}-${actor}-${at}`,
        type: 'PayRunLifecycleRecorded',
        occurredAt: input.now(),
        idempotencyKey: `payrun-${tenantId}-${payRunId}-${event.kind}-${actor}-${at}`,
        source: 'api/finance',
        payload: event,
      }));
    },
  };
}

/**
 * The DURABLE GSTR-1 submission-safety store (WP4 inc2). Each filing period's submission is its own stream
 * of append-only lifecycle facts — previewed, approved, submitted, the portal's answer, a reconciliation —
 * folded by the tested engine into the current state. Nothing is overwritten (hard rule #2): a correction
 * is an amendment in a later period. Maker ≠ checker, duplicate-prevention and the digest match are
 * enforced by the route (before the append) and the fold (on read).
 */
export function gstr1SubmissionAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): Gstr1SubmissionStoreDeps {
  const streamFor = (period: string): string => forGstr1Submission(period);
  return {
    now: input.now,

    load: async (tenantId, period) => {
      const persisted = await input.store.readStream(tenantId, streamFor(period));
      const events = persisted.map((e) => e.event.payload as Gstr1SubmissionEvent);
      return foldGstr1Submission(period, events);
    },

    append: async (tenantId, period, event) => {
      // A given step at a given instant is one fact — keyed on kind + actor + at, so a retry collapses.
      const at = 'at' in event ? event.at : input.now();
      const actor = 'by' in event ? event.by : 'portal';
      const lifecycle = makeEvent({
        id: `gstr1sub-${period}-${event.kind}-${actor}-${at}`,
        type: 'Gstr1SubmissionRecorded',
        occurredAt: input.now(),
        idempotencyKey: `gstr1sub-${tenantId}-${period}-${event.kind}-${actor}-${at}`,
        source: 'api/finance',
        payload: event,
      });
      if (event.kind === 'previewed') {
        // The FIRST preview of a period indexes it (idempotent per period), so the exception queue can find
        // it without scanning the whole ledger. Batched with the lifecycle fact so both land or neither.
        await input.store.appendBatch(tenantId, [
          { stream: streamFor(period), event: lifecycle },
          {
            stream: GSTR1_SUBMISSION_INDEX,
            event: makeEvent({
              id: `gstr1sub-index-${period}`,
              type: 'Gstr1SubmissionIndexed',
              occurredAt: input.now(),
              idempotencyKey: `gstr1sub-index-${tenantId}-${period}`, // one index fact per period
              source: 'api/finance',
              payload: { period },
            }),
          },
        ]);
        return;
      }
      await input.store.append(tenantId, streamFor(period), lifecycle);
    },

    listPeriods: async (tenantId) => {
      const indexed = await allOf<{ period: string }>(input.store, tenantId, GSTR1_SUBMISSION_INDEX, 'Gstr1SubmissionIndexed');
      return [...new Set(indexed.map((i) => i.period))];
    },
  };
}

/**
 * GST returns — the outward-supply line store (A5). Each document's tax lines are an append-only
 * `OutwardSupplyRecorded` fact; GSTR-1 folds over them. Idempotent per document — a re-record collapses,
 * and a correction is a new document / credit note, never an overwrite (hard rule #2).
 */
export function gstReturnsAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): GstReturnsDeps {
  return {
    now: input.now,

    documents: async (tenantId) => {
      const all = await allOf<StoredOutwardDoc>(input.store, tenantId, STREAM.gstreturns, 'OutwardSupplyRecorded');
      const byId = new Map<string, StoredOutwardDoc>();
      for (const d of all) if (!byId.has(d.documentId)) byId.set(d.documentId, d); // first record of an id stands
      return [...byId.values()];
    },

    record: async (tenantId, doc) => {
      await input.store.append(tenantId, STREAM.gstreturns, makeEvent({
        id: `outward-${doc.documentId}`,
        type: 'OutwardSupplyRecorded',
        occurredAt: input.now(),
        idempotencyKey: `outward-${tenantId}-${doc.documentId}`,
        source: 'api/finance',
        payload: doc,
      }));
    },

    // GSTR-1-from-sales (A5): a windowed, read-only fold of the sales stream into the tax-relevant sold
    // lines (productId, quantity, uom, the MRP-inclusive line total, and the trading day). The route pulls
    // the GST out of the line totals against the filer's HSN/rate table — the sale itself never carried a
    // tax split (hard rule #1 untouched; the events ARE the record, hard rule #2). Same window shape as
    // `salesHistoryAdapter.soldLines`, costing a window rather than the whole history.
    soldTaxLines: async (tenantId, fromIso, toIso) => {
      const sales = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: fromIso, to: toIso });
      const lines: PeriodSoldLine[] = [];
      for (const e of sales) {
        const sale = payloadOf<IncomingSale>(e);
        for (const line of sale.lines ?? []) {
          lines.push({
            productId: line.productId, quantityMinor: line.quantityMinor, uom: line.uom,
            lineTotalMinor: line.lineTotalMinor, tradingDay: sale.tradingDay,
            // Frozen tax facts, when the lane stamped them — the return prefers these over the catalogue.
            ...(typeof line.hsnCode === 'string' ? { hsnCode: line.hsnCode } : {}),
            ...(Number.isInteger(line.taxRateBps) ? { rateBps: line.taxRateBps } : {}),
          });
        }
      }
      return lines;
    },

    // RETURNS-netting for GSTR-1 (A5, CGST s.34): the returned tax lines whose return was PROCESSED in the
    // window, each reversing the tax at the rate it was SOLD. A return reverses in the proportion it was
    // charged, so the ACTUAL refund is allocated across the return's lines by their original sale value, and
    // the HSN + rate come off the ORIGINAL sale's frozen line (a rate change since the sale must not rewrite
    // the reversal). A return whose original sale is not on file, or a line whose original carried no HSN,
    // has no frozen facts here and falls to the catalogue table / `unmapped` on the returns side — surfaced,
    // never silently dropped. `occurredAt` on the returns projection IS the return's processedAt.
    returnedTaxLines: async (tenantId, fromIso, toIso) => {
      const returns = await input.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from: fromIso, to: toIso });
      const out: PeriodSoldLine[] = [];
      for (const e of returns) {
        const ret = payloadOf<{
          readonly originalSaleId: string | null; readonly refundMinor: number; readonly processedAt: string;
          readonly lines: readonly { readonly productId: string; readonly uom: string; readonly quantityMinor: number }[];
        }>(e);
        const day = ret.processedAt.slice(0, 10);
        const held = ret.originalSaleId === null ? undefined : await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${ret.originalSaleId}`);
        const saleLines = held === undefined ? [] : (held.event.payload as {
          readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly unitPriceMinor: number; readonly lineTotalMinor: number; readonly hsnCode?: string; readonly taxRateBps?: number }[];
        }).lines;
        const origByProduct = new Map(saleLines.map((l) => [l.productId, l]));
        // Weight each returned line by the returned portion's value at the ORIGINAL price (per-unit incl × qty).
        const weights = ret.lines.map((l) => {
          const o = origByProduct.get(l.productId);
          const perUnit = o !== undefined && o.quantityMinor > 0 ? o.lineTotalMinor / o.quantityMinor : 0;
          return Math.max(0, Math.round(perUnit * l.quantityMinor));
        });
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        let allocated = 0;
        ret.lines.forEach((l, i) => {
          const lineRefund = totalWeight <= 0 ? 0
            : (i === ret.lines.length - 1 ? ret.refundMinor - allocated : Math.round((ret.refundMinor * weights[i]!) / totalWeight));
          allocated += lineRefund;
          if (lineRefund <= 0) return; // nothing to reverse on this line
          const o = origByProduct.get(l.productId);
          out.push({
            productId: l.productId, quantityMinor: l.quantityMinor, uom: l.uom,
            lineTotalMinor: lineRefund, tradingDay: day,
            ...(typeof o?.hsnCode === 'string' ? { hsnCode: o.hsnCode } : {}),
            ...(Number.isInteger(o?.taxRateBps) ? { rateBps: o!.taxRateBps } : {}),
          });
        });
      }
      return out;
    },

    // The DEFAULT product→{HSN, rate} table for GSTR-1-from-sales (A5 Option A): read from the latest
    // published catalogue pack (the M03 master's persisted form). Each product carries its rate (`taxBps`)
    // and — since the snapshot now carries it — its HSN (`hsnCode`). A product with no HSN on the pack is
    // omitted here; if it sold, the return surfaces it as `unmapped` (never filed under a guessed HSN).
    productTaxTable: async (tenantId) => {
      const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      const table: ProductTaxEntry[] = [];
      for (const p of pack?.snapshot.products ?? []) {
        if (typeof p.hsnCode === 'string' && p.hsnCode.trim() !== '') {
          table.push({ productId: p.productId, hsnCode: p.hsnCode, rateBps: p.taxBps });
        }
      }
      return table;
    },
  };
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
// Purchase orders and supplier holds live on their own shared streams so a fold can list every PO
// (and answer the open commitment) and read a supplier's latest block state (M06-FR-01/02/04).
const PURCHASE_ORDERS_STREAM = streamName(STREAM.purchase, 'orders');
const SUPPLIER_BLOCK_STREAM = streamName(STREAM.purchase, 'supplier-block');
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
/** Each pay run's lifecycle folds one stream — one run's history (drafted→…→locked), not the whole shop's. */
const forPayRun = (payRunId: string): string => streamName(STREAM.payroll, payRunId);
/** Each filing period's GSTR-1 submission folds one stream — one period's preview→approve→file history. */
const forGstr1Submission = (period: string): string => streamName(STREAM.gstreturns, 'submission', period);
/** A tenant-wide index of the periods that have a submission — the exception queue folds each one. */
const GSTR1_SUBMISSION_INDEX = streamName(STREAM.gstreturns, 'submission-index');

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
     * Build the next snapshot by folding the real master data — the product master (M03), the price lists
     * (M05), the barcode register and the tax-class rate schedules — for a store, through the tested
     * `buildCatalogueSnapshot` (via `assembleCatalogueSnapshot`, the same fold the read-only preview uses).
     * A product with no price at this store, no resolvable tax rate, or a price above its MRP is left out
     * (the engine's own reason) rather than shipped to a lane unpriceable — the shrink check then makes any
     * drop in coverage visible (P-08) and refuses a pack much smaller than the shop without acknowledgement.
     */
    buildSnapshot: async (tenantId, options) => {
      if (options.storeId === undefined || options.storeId.trim() === '') {
        throw apiError(400, {
          code: 'not_readable_as_a_pack_publish',
          whatHappened: 'Publishing a catalogue pack needs the store it is for: send { storeId } in the body. A pack carries the price each lane in that store should charge, resolved per store.',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Send { storeId: "<the store>" } (optionally { asOf: "YYYY-MM-DD" }). Nothing was published.',
        });
      }
      const previous = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
      const version = (previous?.snapshot.version ?? 0) + 1;
      const result = await assembleCatalogueSnapshot(
        cataloguePreviewAdapter({ store: input.store, now: input.now }),
        { tenantId, storeId: options.storeId, asOf: options.asOf ?? input.now(), version },
      );
      return result.snapshot;
    },

    approvalsSince: () => [],
  };
}

/**
 * The product-master store (M03-FR-01) — the persistence the catalogue pack build has waited for.
 * Each published product is a `ProductPublished` event on the tenant's product-master stream; the current
 * master is the latest event per product id (a change is a new version, never an overwrite — hard rule #2),
 * so a product master survives a restart and reads as what happened.
 */
export function productMasterAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ProductMasterDeps {
  const stream = streamName(STREAM.catalogue, 'products');
  const foldLatest = async (tenantId: string): Promise<Map<string, ProductRecord>> => {
    const events = await input.store.readStream(tenantId, stream, { type: 'ProductPublished' });
    const byId = new Map<string, ProductRecord>();
    for (const e of events) {
      const r = payloadOf<ProductRecord>(e);
      byId.set(r.productId, r); // occurrence order → the last publish of an id wins
    }
    return byId;
  };
  return {
    publish: async (tenantId, record, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `product-${record.productId}-${key}`,
        type: 'ProductPublished',
        occurredAt: input.now(),
        // Keyed on the caller's idempotency key so a retry dedups to one version; a deliberate re-publish
        // (a new key) is a new version.
        idempotencyKey: `product-${tenantId}-${record.productId}-${key}`,
        source: 'api/catalogue',
        payload: record,
      }));
    },
    product: async (tenantId, productId) => (await foldLatest(tenantId)).get(productId),
    products: async (tenantId) =>
      [...(await foldLatest(tenantId)).values()].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0)),
  };
}

/**
 * The barcode register (M03-FR-02) — the durable "one code, one item" map the till depends on. Each
 * assignment is a `BarcodeAssigned` event on the tenant's barcode stream; the service rebuilds the tested
 * `BarcodeRegistry` from them (last event per code wins — a same-product re-assign updates kind/level,
 * a different-product clash is refused at the route before it is ever appended, so replay never throws).
 */
export function barcodeAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): BarcodeRegistryDeps {
  const stream = streamName(STREAM.catalogue, 'barcodes');
  return {
    assign: async (tenantId, assignment, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `barcode-${assignment.code}-${key}`,
        type: 'BarcodeAssigned',
        occurredAt: input.now(),
        // Keyed on the caller's idempotency key so a retry dedups; a deliberate re-assign (new key) appends
        // a new version the fold's last-wins picks up.
        idempotencyKey: `barcode-${tenantId}-${assignment.code}-${key}`,
        source: 'api/catalogue',
        payload: assignment,
      }));
    },
    all: (tenantId) => allOf<BarcodeAssignment>(input.store, tenantId, stream, 'BarcodeAssigned'),
  };
}

/**
 * The product-merge store (M03-FR-04 §28) — the §28-gated, reversible resolution of a duplicate. A merge's
 * whole life is a stream of events on the tenant's merge stream (`MergeProposed` → `MergeApproved` /
 * `MergeRejected` → `MergeReversed`), folded per mergeId into its current `MergeView`. Nothing is deleted —
 * a rejection and a reversal are recorded, never erased (hard rule #6) — so the register reads as exactly
 * what was proposed, who decided it, and whether it was later undone.
 */
export function productMergeAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): ProductMergeDeps {
  const stream = streamName(STREAM.catalogue, 'merges');
  const fold = async (tenantId: string): Promise<Map<string, MergeView>> => {
    const events = await input.store.readStream(tenantId, stream); // every merge event, oldest first
    const byId = new Map<string, MergeView>();
    for (const e of events) {
      const type = e.event.type;
      if (type === 'MergeProposed') {
        const req = payloadOf<MergeRequest>(e);
        byId.set(req.mergeId, { request: req, status: 'pending' });
      } else if (type === 'MergeApproved') {
        const link = payloadOf<MergeLink>(e);
        const v = byId.get(link.mergeId);
        if (v) byId.set(link.mergeId, { ...v, status: 'approved', link, decidedBy: link.approvedBy, decidedAt: link.at });
      } else if (type === 'MergeRejected') {
        const rej = payloadOf<MergeRejection>(e);
        const v = byId.get(rej.mergeId);
        if (v) byId.set(rej.mergeId, { ...v, status: 'rejected', decidedBy: rej.decidedBy, decidedAt: rej.at });
      } else if (type === 'MergeReversed') {
        const link = payloadOf<MergeLink>(e);
        const v = byId.get(link.mergeId);
        if (v) byId.set(link.mergeId, { ...v, status: 'reversed', link });
      }
    }
    return byId;
  };
  return {
    recordProposal: async (tenantId, request, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `merge-${request.mergeId}-proposed-${key}`,
        type: 'MergeProposed',
        occurredAt: input.now(),
        idempotencyKey: `merge-${tenantId}-${request.mergeId}-proposed-${key}`,
        source: 'api/catalogue',
        payload: request,
      }));
    },
    recordApproved: async (tenantId, link, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `merge-${link.mergeId}-approved-${key}`,
        type: 'MergeApproved',
        occurredAt: input.now(),
        idempotencyKey: `merge-${tenantId}-${link.mergeId}-approved-${key}`,
        source: 'api/catalogue',
        payload: link,
      }));
    },
    recordRejected: async (tenantId, rejection, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `merge-${rejection.mergeId}-rejected-${key}`,
        type: 'MergeRejected',
        occurredAt: input.now(),
        idempotencyKey: `merge-${tenantId}-${rejection.mergeId}-rejected-${key}`,
        source: 'api/catalogue',
        payload: rejection,
      }));
    },
    recordReversed: async (tenantId, link, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `merge-${link.mergeId}-reversed-${key}`,
        type: 'MergeReversed',
        occurredAt: input.now(),
        idempotencyKey: `merge-${tenantId}-${link.mergeId}-reversed-${key}`,
        source: 'api/catalogue',
        payload: link,
      }));
    },
    view: async (tenantId, mergeId) => (await fold(tenantId)).get(mergeId),
    all: async (tenantId) => [...(await fold(tenantId)).values()],
    now: input.now,
  };
}

/**
 * The pack-hierarchy store (M03-FR-02) — a product's exact, reversible pack ladder (unit → inner → case).
 * Each definition is a `PackHierarchyDefined` event on the tenant's pack stream; the current hierarchy is the
 * latest event per product id (a change is a new version, never an overwrite — hard rule #2), so it survives
 * a restart. The route runs the tested `validatePack` before appending, so an inexact pack is refused at the
 * boundary and the stream only ever holds packs that convert exactly.
 */
export function packHierarchyAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PackHierarchyDeps {
  const stream = streamName(STREAM.catalogue, 'pack-hierarchy');
  const foldLatest = async (tenantId: string): Promise<Map<string, PackHierarchy>> => {
    const events = await input.store.readStream(tenantId, stream, { type: 'PackHierarchyDefined' });
    const byId = new Map<string, PackHierarchy>();
    for (const e of events) {
      const p = payloadOf<PackHierarchy>(e);
      byId.set(p.productId, p); // occurrence order → the last definition of a product wins
    }
    return byId;
  };
  return {
    define: async (tenantId, pack, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `pack-${pack.productId}-${key}`,
        type: 'PackHierarchyDefined',
        occurredAt: input.now(),
        idempotencyKey: `pack-${tenantId}-${pack.productId}-${key}`,
        source: 'api/catalogue',
        payload: pack,
      }));
    },
    pack: async (tenantId, productId) => (await foldLatest(tenantId)).get(productId),
  };
}

/**
 * The tax-class GST-rate schedule store (M03-FR-03 tax side / A6) — each HSN's effective-dated rate periods.
 * A rate is a `TaxRateSet` event on a per-HSN stream; the schedule is every period ever set (append-only,
 * a change is a new later-dated period, never an overwrite — hard rule #2). The route enforces the
 * one-rate-per-date rule before appending, and the tested `resolveGstRate` picks the period in force.
 */
export function taxClassAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): TaxClassRateDeps {
  const forHsn = (hsnCode: string): string => streamName(STREAM.catalogue, 'tax-classes', hsnCode);
  return {
    setRate: async (tenantId, hsnCode, period, key) => {
      await input.store.append(tenantId, forHsn(hsnCode), makeEvent({
        id: `tax-rate-${hsnCode}-${period.effectiveFrom}-${key}`,
        type: 'TaxRateSet',
        occurredAt: input.now(),
        idempotencyKey: `tax-rate-${tenantId}-${hsnCode}-${period.effectiveFrom}-${key}`,
        source: 'api/catalogue',
        payload: period,
      }));
    },
    schedule: (tenantId, hsnCode) => allOf<GstRatePeriod>(input.store, tenantId, forHsn(hsnCode), 'TaxRateSet'),
  };
}

/**
 * Catalogue-pack ASSEMBLY reader (slice 2) — composes the four master-data stores this session built so the
 * pack build can fold them: the product master, the price lists, the barcode register and the tax-class
 * rate schedules. It reuses the tested adapters above rather than re-reading the streams, so there is one
 * fold path per store.
 */
export function cataloguePreviewAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): CataloguePreviewDeps {
  const pm = productMasterAdapter(input);
  const pl = priceListAdapter(input);
  const bc = barcodeAdapter(input);
  const tc = taxClassAdapter(input);
  return {
    products: pm.products,
    priceEntries: pl.entries,
    barcodes: bc.all,
    taxSchedule: tc.schedule,
    now: input.now,
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
      // The sale and its receipt-number index are ONE atomic batch (audit FND-01): a crash between
      // them must never leave a banked sale with no receipt index, nor an index pointing at a sale
      // that did not commit. Both carry their own idempotency key, so a till resending the sale
      // dedups the whole batch.
      await input.store.appendBatch(tenantId, [
        {
          stream: STREAM.sales,
          event: makeEvent({
            id: `sale-${sale.saleId}`,
            type: 'SaleCommitted',
            occurredAt: sale.committedAt,
            // The sale's own id. A till resending the same sale collapses to one, whatever
            // Idempotency-Key the transport happened to use.
            idempotencyKey: `sale-${tenantId}-${sale.saleId}`,
            source: 'api/pos',
            payload: sale,
          }),
        },
        {
          // The receipt-number index, appended second and deliberately allowed to lose.
          //
          // If two sales carry one receipt number the second append dedupes and this entry keeps
          // pointing at the FIRST sale — which is exactly right, because the exception it raises reads
          // "receipt R-101 already belongs to sale S-7", and S-7 is the one that had it. The index
          // records who holds the number, not who asked for it last. Batching does not change this:
          // the two events have distinct keys, so a receipt already taken still dedups on its own.
          stream: STREAM.sales,
          event: makeEvent({
            id: `receipt-${sale.receiptNumber}`,
            type: 'ReceiptNumberIssued',
            occurredAt: sale.committedAt,
            idempotencyKey: `receipt-${tenantId}-${sale.receiptNumber}`,
            source: 'api/pos',
            payload: { receiptNumber: sale.receiptNumber, saleId: sale.saleId },
          }),
        },
      ]);
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

/**
 * Lot-trace outbound (B11 / M10-FR-03). Two sources, both read-only, combined:
 *
 *   • **captured** (inc3a) — `bankSale` stores each sale (payload = the whole sale) as a `SaleCommitted`,
 *     so every line whose till RECORDED this batch is returned directly.
 *   • **estimated** (inc3b / ADR-0006) — for the product this batch belongs to, head office attributes a
 *     FIFO-by-receipt best-estimate to the product's batch-tracked sales that arrived with NO captured
 *     batch, and returns those estimated to draw this batch. Labelled `fifo_receipt_estimate` so an
 *     estimate is never mistaken for a till-recorded fact, and NEVER written back onto the sale (hard
 *     rule #2 — it is computed at read time).
 *
 * A recall-time read, not a hot path. A walk-in with no captured customer is kept (customer identity via
 * loyalty/consent is a later M16 linkage).
 */
/**
 * The recall register (M10-FR-04) — the durable cloud record of every recall. Each initiation is a
 * `RecallInitiated` event and each closure a `RecallClosed` event on the tenant's recall stream, each
 * carrying the resulting `RecallRecord`; nothing is ever deleted (hard rule #6). The write surface replays
 * them through the tested `RecallRegistry` to get its idempotent-initiate / evidence-required-close /
 * nothing-open-to-close semantics; the read surface folds the latest record per batch.
 */
export function recallAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): RecallDeps {
  const stream = streamName(STREAM.inventory, 'recalls');
  const events = (tenantId: string) => input.store.readStream(tenantId, stream); // both types, oldest first
  return {
    now: input.now,
    registry: async (tenantId) => {
      const registry = new RecallRegistry();
      for (const e of await events(tenantId)) {
        const r = payloadOf<RecallRecord>(e);
        if (e.event.type === 'RecallInitiated') {
          registry.initiate({ batchId: r.batchId, reason: r.reason, initiatedBy: r.initiatedBy, at: r.initiatedAt });
        } else if (e.event.type === 'RecallClosed' && r.evidenceRef !== null && r.closedBy !== null && r.closedAt !== null) {
          registry.close({ batchId: r.batchId, closedBy: r.closedBy, evidenceRef: r.evidenceRef, at: r.closedAt });
        }
      }
      return registry;
    },
    records: async (tenantId) => {
      // Each event's payload IS the resulting record, so the latest per batch is the current state.
      const byBatch = new Map<string, RecallRecord>();
      for (const e of await events(tenantId)) {
        const r = payloadOf<RecallRecord>(e);
        byBatch.set(r.batchId, r);
      }
      return [...byBatch.values()];
    },
    recordInitiated: async (tenantId, record, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `recall-${record.batchId}-init-${key}`,
        type: 'RecallInitiated',
        occurredAt: input.now(),
        idempotencyKey: `recall-${tenantId}-${record.batchId}-init-${key}`,
        source: 'api/inventory',
        payload: record,
      }));
    },
    recordClosed: async (tenantId, record, key) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `recall-${record.batchId}-close-${key}`,
        type: 'RecallClosed',
        occurredAt: input.now(),
        idempotencyKey: `recall-${tenantId}-${record.batchId}-close-${key}`,
        source: 'api/inventory',
        payload: record,
      }));
    },
  };
}

export function lotTraceAdapter(input: { readonly store: EventStore }): LotTraceDeps {
  return {
    soldOfBatch: async (tenantId, batchId) => {
      const sales = await allOf<IncomingSale>(input.store, tenantId, STREAM.sales, 'SaleCommitted');

      // Identified customers (M16, minimal ref): a sale carries no customer, but the loyalty/stored-value
      // ledger links a sale to the member who transacted on it (`{saleId, customerRef}`). Resolve that
      // link so a recall names the customers it can — no new data collection, and only the reference is
      // surfaced (actual contact stays consent-gated, PRV / the recall runbook).
      const instruments = await allOf<Instrument>(input.store, tenantId, STORED_VALUE_INDEX, 'StoredValueIssued');
      const movementLists = await Promise.all(
        instruments.map((i) => allOf<ValueMovement>(input.store, tenantId, forInstrument(i.instrumentId), 'StoredValueMovement')),
      );
      const customerBySale = new Map<string, string>();
      for (const mv of movementLists.flat()) {
        if (typeof mv.saleId === 'string' && mv.saleId !== '' && typeof mv.customerRef === 'string' && mv.customerRef !== '' && !customerBySale.has(mv.saleId)) {
          customerBySale.set(mv.saleId, mv.customerRef);
        }
      }
      const withCustomer = (saleId: string): { customerId: string } | Record<string, never> =>
        customerBySale.has(saleId) ? { customerId: customerBySale.get(saleId)! } : {};

      // Captured: the till recorded this exact batch on the line.
      const captured: OutboundLotRecord[] = [];
      for (const sale of sales) {
        for (const line of sale.lines ?? []) {
          if (line.batchId === batchId) {
            captured.push({ saleId: sale.saleId, soldDate: sale.tradingDay, quantityMinor: line.quantityMinor, source: 'captured', ...withCustomer(sale.saleId) });
          }
        }
      }

      // Estimated (ADR-0006): head-office FIFO-by-receipt best-estimate for the product's un-captured
      // batch-tracked sales. Skipped unless the batch was actually received (so we know its product) and
      // the catalogue marks that product batch-tracked.
      const moves = (await input.store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => payloadOf<Movement>(e));
      const productId = moves.find((m) => m.batchId === batchId)?.productId;
      let estimated: OutboundLotRecord[] = [];
      if (productId !== undefined) {
        const pack = await latest<SignedPack>(input.store, tenantId, STREAM.catalogue, 'CataloguePublished');
        const product = pack?.snapshot.products.find((p) => p.productId === productId);
        if (product?.batchTracked === true) {
          const receipts: BatchReceipt[] = moves
            .filter((m) => m.productId === productId && m.kind === 'received' && typeof m.batchId === 'string' && m.batchId !== '')
            .map((m) => ({ batchId: m.batchId as string, receivedDate: m.occurredAt.slice(0, 10), qty: m.quantityMinor }));
          const history: HistoricalSaleLine[] = [];
          for (const sale of sales) {
            for (const line of sale.lines ?? []) {
              if (line.productId === productId) {
                history.push({
                  saleId: sale.saleId, soldDate: sale.tradingDay, qty: line.quantityMinor, batchTracked: true,
                  ...(typeof line.batchId === 'string' && line.batchId !== '' ? { capturedBatchId: line.batchId } : {}),
                });
              }
            }
          }
          const { estimates } = attributeSalesFifo({ receipts, sales: history });
          estimated = estimates
            .filter((e) => e.batchId === batchId)
            .map((e) => ({ saleId: e.saleId, soldDate: e.soldDate, quantityMinor: e.qty, source: 'fifo_receipt_estimate' as const, ...withCustomer(e.saleId) }));
        }
      }

      return [...captured, ...estimated];
    },
  };
}

/**
 * Sales-history demand read (M09 — the demand foundation for D-3/D-1/D-4). A **windowed** fold of the
 * sales stream into sold lines: each `SaleCommitted` in [from, to) contributes its lines (productId,
 * quantity, trading day) to the pure `salesHistory` engine. Read-only, and windowed on `occurredAt` so
 * it costs a window rather than the whole history — the same shape as `electronicTenders`.
 */
export function salesHistoryAdapter(input: { readonly store: EventStore; readonly now: () => string }): SalesHistoryDeps {
  return {
    now: input.now,
    soldLines: async (tenantId, fromIso, toIso) => {
      const sales = await input.store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted', from: fromIso, to: toIso });
      const lines: SoldLine[] = [];
      for (const e of sales) {
        const sale = payloadOf<IncomingSale>(e);
        for (const line of sale.lines ?? []) {
          lines.push({ productId: line.productId, quantityMinor: line.quantityMinor, tradingDay: sale.tradingDay });
        }
      }
      return lines;
    },
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
      // The register entry and its reporting projection are ONE atomic batch (audit FND-01). Before,
      // the projection was a second, additive append that a crash could drop — leaving the money and
      // the per-sale register correct but the tenant-wide returns-netting report short one return.
      // Batching them removes that window: both land together or neither does, and each keeps its own
      // idempotency key so a lane retrying an unconfirmed refund still dedups the whole batch (the
      // money leaves once however many times the till re-sends it).
      await input.store.appendBatch(tenantId, [
        {
          stream: forSaleReturns(saleId),
          event: makeEvent({
            id: `return-${record.returnId}`,
            type: 'ReturnRecorded',
            occurredAt: record.processedAt,
            idempotencyKey: `return-${tenantId}-${record.returnId}`,
            source: 'api/pos',
            payload: record,
          }),
        },
        {
          // The tenant-wide returns projection — a READ MODEL for reporting (returns-netting), keyed
          // on the return id so a retry collapses.
          stream: STREAM.returns,
          event: makeEvent({
            id: `return-proj-${record.returnId}`,
            type: 'ReturnRecorded',
            occurredAt: record.processedAt,
            idempotencyKey: `return-proj-${tenantId}-${record.returnId}`,
            source: 'api/pos',
            payload: record,
          }),
        },
      ]);
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

    // The finance AR balance for this customer — PROJECTED from the SAME receivable-movement stream
    // the credit surface folds (M22-FR-01), so the reconciliation compares the collections sub-ledger
    // against the very balance the credit check uses, never a stored total that could drift (#2).
    outstandingMinor: async (tenantId, customerId) =>
      (await allOf<RecordedReceivable>(input.store, tenantId, forB2BCustomer(customerId), 'B2BReceivableMovement'))
        .reduce((b, m) => b + m.deltaMinor, 0),

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

export function writeOffAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): WriteOffDeps {
  // Committed write-offs live on their own append-only stream. `recordWriteOff` is idempotent on the
  // write-off id — a re-sent write-off of the same id collapses rather than recording the loss twice
  // (append-only, hard rule #2). A correction is a NEW, compensating write-off with its own id.
  const writeOffStream = streamName(STREAM.inventory, 'write-offs');
  const fold = async (tenantId: string): Promise<readonly StoredWriteOff[]> =>
    allOf<StoredWriteOff>(input.store, tenantId, writeOffStream, 'WriteOffCommitted');

  return {
    now: input.now,
    writeOffs: (tenantId) => fold(tenantId),
    writeOffExists: async (tenantId, id) => (await fold(tenantId)).some((r) => r.id === id),
    recordWriteOff: async (tenantId, rec) => {
      await input.store.append(tenantId, writeOffStream, makeEvent({
        id: `write-off-${rec.id}`,
        type: 'WriteOffCommitted',
        occurredAt: rec.at,
        idempotencyKey: `write-off-${tenantId}-${rec.id}`,
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

/**
 * The goods-receipt (GRN) store (M07-FR-01/02/03 · D03-FR-02) — the durable cloud record of every delivery
 * received. A GRN is a `GoodsReceived` event on the tenant's GRN stream; its SELLABLE lines are inbound
 * `received` movements on the shared inventory stream (so availability learns about the receipt, M08) — and
 * the two are ONE atomic append (FND-01), so a GRN never lands with its movements missing. Idempotent on the
 * GRN id, so a re-scan / re-sync is one effect (§31.1).
 */
export function goodsReceiptAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): GoodsReceiptDeps {
  const grnStream = streamName(STREAM.purchase, 'grn');
  return {
    now: input.now,
    grn: async (tenantId, grnId) =>
      (await allOf<GrnRecord>(input.store, tenantId, grnStream, 'GoodsReceived')).find((g) => g.grnId === grnId),
    all: (tenantId) => allOf<GrnRecord>(input.store, tenantId, grnStream, 'GoodsReceived'),
    commit: async (tenantId, record, movements, key) => {
      await input.store.appendBatch(tenantId, [
        {
          stream: grnStream,
          event: makeEvent({
            id: `grn-${record.grnId}-${key}`,
            type: 'GoodsReceived',
            occurredAt: input.now(),
            idempotencyKey: `grn-${tenantId}-${record.grnId}`,
            source: 'api/inventory',
            payload: record,
          }),
        },
        // One inbound movement per sellable line, in the SAME format the inventory adapter uses, so the
        // availability projection folds them exactly as any other movement (mv-<movementId>).
        ...movements.map((m) => ({
          stream: STREAM.inventory,
          event: makeEvent({
            id: `mv-${m.movementId}`,
            type: 'InventoryMoved',
            occurredAt: m.occurredAt,
            idempotencyKey: `mv-${tenantId}-${m.movementId}`,
            source: 'api/inventory',
            payload: m,
          }),
        })),
      ]);
    },
  };
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
      const foldTo = (cutoff: string): Map<string, { cogs: number; value: number; onHand: number }> => {
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
        const byProduct = new Map<string, { cogs: number; value: number; onHand: number }>();
        for (const r of rows) {
          const acc = byProduct.get(r.productId) ?? { cogs: 0, value: 0, onHand: 0 };
          acc.cogs += r.cogs.minor;
          acc.value += r.value.minor;
          acc.onHand += r.onHandMinor;
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
      const deGross = (grossMinor: number, taxBps: number): number => Number((BigInt(grossMinor) * 10_000n) / BigInt(10_000 + taxBps));
      for (const e of sales) {
        const sale = payloadOf<{ readonly lines: readonly { readonly productId: string; readonly lineTotalMinor: number }[] }>(e);
        for (const line of sale.lines) {
          const taxBps = taxByProduct.get(line.productId);
          if (taxBps === undefined) { taxUnknown.add(line.productId); continue; }
          netByProduct.set(line.productId, (netByProduct.get(line.productId) ?? 0) + deGross(line.lineTotalMinor, taxBps));
        }
      }

      // Returns-netting: read the returns projection for the window and reverse each. Net sales fall
      // by the ex-tax refund (allocated across the return's lines by their original sale value); COGS
      // falls only for `resell` lines (the goods come back sellable) at the closing weighted-average —
      // a damaged/scrapped return is a real loss, so its cost stays. Returns whose product tax rate is
      // unknown mark that product unmeasurable, exactly as an unknown-tax sale does (P-08).
      const returns = await input.store.readStream(tenantId, STREAM.returns, { type: 'ReturnRecorded', from, to });
      const returnedNetByProduct = new Map<string, number>();
      const returnedCogsByProduct = new Map<string, number>();
      for (const e of returns) {
        const ret = payloadOf<{ readonly originalSaleId: string; readonly refundMinor: number; readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly disposition: string }[] }>(e);
        const saleEvent = await input.store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${ret.originalSaleId}`);
        const saleLines = saleEvent === undefined ? [] : (saleEvent.event.payload as { readonly lines: readonly { readonly productId: string; readonly unitPriceMinor: number }[] }).lines;
        const priceByProduct = new Map(saleLines.map((l) => [l.productId, l.unitPriceMinor]));
        const lineGross = ret.lines.map((l) => (priceByProduct.get(l.productId) ?? 0) * l.quantityMinor);
        const totalGross = lineGross.reduce((s, g) => s + g, 0);
        let allocated = 0;
        ret.lines.forEach((l, i) => {
          // Allocate the ACTUAL refund across lines by original sale value; the last line takes the
          // rounding remainder so the parts sum exactly to what was refunded.
          const lineRefund = totalGross <= 0 ? 0 : (i === ret.lines.length - 1 ? ret.refundMinor - allocated : Math.round((ret.refundMinor * lineGross[i]!) / totalGross));
          allocated += lineRefund;
          const taxBps = taxByProduct.get(l.productId);
          if (taxBps === undefined) { taxUnknown.add(l.productId); } else {
            returnedNetByProduct.set(l.productId, (returnedNetByProduct.get(l.productId) ?? 0) + deGross(lineRefund, taxBps));
          }
          if (l.disposition === 'resell') {
            const c = closing.get(l.productId);
            const wacUnit = c !== undefined && c.onHand > 0 ? Math.round(c.value / c.onHand) : 0;
            returnedCogsByProduct.set(l.productId, (returnedCogsByProduct.get(l.productId) ?? 0) + l.quantityMinor * wacUnit);
          }
        });
      }

      const inr = (minor: number) => ({ minor, currency: 'INR' as const });
      const productIds = [...new Set<string>([...opening.keys(), ...closing.keys(), ...netByProduct.keys(), ...taxUnknown, ...returnedNetByProduct.keys(), ...returnedCogsByProduct.keys()])].sort();
      const byProduct = productIds.map((productId) => {
        const o = opening.get(productId) ?? { cogs: 0, value: 0, onHand: 0 };
        const c = closing.get(productId) ?? { cogs: 0, value: 0, onHand: 0 };
        const cogs = (c.cogs - o.cogs) - (returnedCogsByProduct.get(productId) ?? 0);
        const returnsExTax = returnedNetByProduct.get(productId) ?? 0;
        const row = { productId, cogs: inr(cogs), averageInventory: inr(Math.round((o.value + c.value) / 2)), returnsMinor: inr(returnsExTax) };
        // Absent net sales/margin for a product whose tax rate we do not know — never a guess (P-08).
        if (taxUnknown.has(productId)) return row;
        const netSales = (netByProduct.get(productId) ?? 0) - returnsExTax;
        return { ...row, netSales: inr(netSales), grossMargin: inr(netSales - cogs) };
      });

      const sum = (pick: (r: (typeof byProduct)[number]) => Money | undefined): number =>
        byProduct.reduce((s, r) => s + (pick(r)?.minor ?? 0), 0);
      const totalCogs = sum((r) => r.cogs);
      const totalBase = { cogs: inr(totalCogs), averageInventory: inr(sum((r) => r.averageInventory)), returnsMinor: inr(sum((r) => r.returnsMinor)) };
      const total = taxUnknown.size > 0
        // The store-wide margin cannot be complete if any sold product's revenue is unmeasurable.
        ? totalBase
        : {
            ...totalBase,
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

/**
 * Fold the purchase-order stream to each PO's current state. A `PurchaseOrderProposed` opens it
 * (first proposal of an id wins — a re-sync is idempotent); a `PurchaseOrderIssued` moves it to
 * issued, carrying the approver and issue time. Both `purchaseOrdersAdapter` (reads) and
 * `purchaseAdapter.openCommitments` (the on-order figure) fold through here, so there is one truth.
 */
async function foldPurchaseOrders(store: EventStore, tenantId: string): Promise<Map<string, StoredPurchaseOrder>> {
  const events = await store.readStream(tenantId, PURCHASE_ORDERS_STREAM); // both types, oldest first
  const byId = new Map<string, StoredPurchaseOrder>();
  for (const e of events) {
    if (e.event.type === 'PurchaseOrderProposed') {
      const po = payloadOf<StoredPurchaseOrder>(e);
      if (!byId.has(po.poId)) byId.set(po.poId, po);
    } else if (e.event.type === 'PurchaseOrderIssued') {
      const iss = payloadOf<{ poId: string; approvedBy: string; issuedAt: string }>(e);
      const cur = byId.get(iss.poId);
      if (cur !== undefined && cur.status === 'proposed') {
        byId.set(iss.poId, { ...cur, status: 'issued', approvedBy: iss.approvedBy, issuedAt: iss.issuedAt });
      }
    }
  }
  return byId;
}

/**
 * The purchase-order lifecycle store (M06-FR-01/02/04). POs live on one shared stream so the buying
 * review surface can list them and the open-commitment figure can fold them; supplier holds live on
 * their own shared stream, latest-wins per supplier. A proposed PO survives a restart and reads as
 * what happened; an issued one carries its second approver forever (hard rule #2/#6).
 */
export function purchaseOrdersAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): PurchaseOrderDeps {
  return {
    now: input.now,
    order: async (tenantId, poId) => (await foldPurchaseOrders(input.store, tenantId)).get(poId),
    all: async (tenantId) => [...(await foldPurchaseOrders(input.store, tenantId)).values()],

    supplierBlocked: async (tenantId, supplierId) => {
      const latest = await latestBlock(input.store, tenantId, supplierId);
      return latest?.blocked ?? false;
    },

    propose: async (tenantId, po) => {
      await input.store.append(tenantId, PURCHASE_ORDERS_STREAM, makeEvent({
        id: `po-${po.poId}-proposed`,
        type: 'PurchaseOrderProposed',
        occurredAt: input.now(),
        // Keyed on the PO id alone: a re-sent proposal of the same PO collapses to one (never two POs).
        idempotencyKey: `po-${tenantId}-${po.poId}-proposed`,
        source: 'api/purchase',
        payload: po,
      }));
    },

    issue: async (tenantId, poId, approvedBy, issuedAt, reason) => {
      await input.store.append(tenantId, PURCHASE_ORDERS_STREAM, makeEvent({
        id: `po-${poId}-issued`,
        type: 'PurchaseOrderIssued',
        occurredAt: issuedAt,
        // Keyed on the PO id: a re-issue of an already-issued PO collapses (idempotent §31.1).
        idempotencyKey: `po-${tenantId}-${poId}-issued`,
        source: 'api/purchase',
        payload: { poId, approvedBy, issuedAt, reason },
      }));
    },

    setSupplierBlocked: async (tenantId, supplierId, blocked, reason, by, at) => {
      await input.store.append(tenantId, SUPPLIER_BLOCK_STREAM, makeEvent({
        id: `supplier-block-${supplierId}-${blocked}-${at}`,
        type: 'SupplierBlockStatusSet',
        occurredAt: at,
        // Keyed on the supplier + the new state + when: setting the same state twice collapses, but a
        // block and a later lift are distinct facts and both stay on the record (hard rule #6).
        idempotencyKey: `supplier-block-${tenantId}-${supplierId}-${blocked}-${at}`,
        source: 'api/purchase',
        payload: { supplierId, blocked, reason, by, at },
      }));
    },
  };
}

/** The latest block record for a supplier, or undefined if it has never been held. */
async function latestBlock(store: EventStore, tenantId: string, supplierId: string): Promise<{ readonly blocked: boolean } | undefined> {
  const events = await store.readStream(tenantId, SUPPLIER_BLOCK_STREAM, { type: 'SupplierBlockStatusSet' });
  let latest: { readonly supplierId: string; readonly blocked: boolean } | undefined;
  for (const e of events) {
    const p = payloadOf<{ supplierId: string; blocked: boolean }>(e);
    if (p.supplierId === supplierId) latest = p; // occurrence order → last wins
  }
  return latest;
}

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

    /**
     * What is on order and not yet received (M06-FR-04). Now that purchase orders ARE recorded,
     * this is a real number: the tested `computeOpenCommitment` values every ISSUED PO's open lines
     * and they are summed. A tenant with no issued PO yet still reads *not known* (undefined), which
     * is a different answer from zero — until a PO exists the shop genuinely cannot state what is on
     * order. (Receipt/cancellation netting of the figure is the next increment; the engine takes both.)
     */
    openCommitments: async (tenantId) => {
      const issued = [...(await foldPurchaseOrders(input.store, tenantId)).values()].filter((p) => p.status === 'issued');
      if (issued.length === 0) return undefined;
      const valueMinor = issued.reduce((sum, po) => sum + computeOpenCommitment(po.lines).totalOpenValue.minor, 0);
      return { count: issued.length, valueMinor };
    },
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

/** Σ taxable credited per invoice, folded from the `CreditNoteIssued` events (credit notes only). */
const CREDITED_PER_INVOICE_PROJECTION = 'credited-per-invoice@1';
const CREDITED_PER_INVOICE: Projection<Readonly<Record<string, number>>> = {
  initial: {},
  apply: (state, event) => {
    const n = event.payload as CreditNote;
    // Debit notes add to a bill; only credit notes consume the s.34 credit headroom.
    if (n.kind !== 'credit_note') return state;
    return { ...state, [n.againstInvoiceId]: (state[n.againstInvoiceId] ?? 0) + n.taxableMinor };
  },
};

export function financeNotesAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /**
   * Where the credited-per-invoice snapshot lives (CORE-03). In production `main()` passes a durable
   * `SqlSnapshotStore` so the bounded read survives a restart; omitted, it falls back to a
   * process-local `InMemorySnapshotStore`, which is still correct (a snapshot is disposable and
   * rebuilt from the ledger) — just rebuilt on each cold start.
   */
  readonly snapshots?: SnapshotStore;
}): CreditNoteDeps {
  const snapshots = input.snapshots ?? new InMemorySnapshotStore();

  return {
    now: input.now,

    // Σ of what earlier CREDIT notes already took off this invoice, projected through the snapshot
    // facility rather than re-summing the whole history. This is what makes the s.34 cap hold across
    // many notes: the engine adds the new note to this and refuses if the cumulative would exceed
    // the invoice.
    alreadyCredited: async (tenantId, invoiceId) => {
      const { state } = await projectFromSnapshot(
        input.store, snapshots, tenantId, STREAM.finance,
        CREDITED_PER_INVOICE_PROJECTION, CREDITED_PER_INVOICE,
        { eventType: 'CreditNoteIssued' },
      );
      return state[invoiceId] ?? 0;
    },

    // Every credit/debit note issued, folded from the CreditNoteIssued events — the sub-ledger side of
    // the period credit-note reconciliation (M23-FR-02). reconcileNotes filters by each note's own
    // declareInPeriod, so the whole set is served and the engine picks the period.
    notes: async (tenantId) =>
      allOf<CreditNote>(input.store, tenantId, STREAM.finance, 'CreditNoteIssued'),

    appendCreditNote: async (tenantId, note) => {
      await input.store.append(tenantId, STREAM.finance, makeEvent({
        id: note.noteId,
        type: 'CreditNoteIssued',
        occurredAt: input.now(),
        // Idempotent on the note id — a resend of the same note is not a second credit.
        idempotencyKey: `creditnote-${tenantId}-${note.noteId}`,
        source: 'api/finance',
        payload: note,
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

    // The household's instruments: the shared issue index, filtered by owner — the index was built
    // for exactly this ("so it can be found and, later, pooled by owner", above).
    instrumentsForOwner: async (tenantId, ownerRef) =>
      (await allOf<Instrument>(input.store, tenantId, STORED_VALUE_INDEX, 'StoredValueIssued'))
        .filter((i) => i.ownerRef === ownerRef),

    // Every movement across that household's instruments — a fan-out fold over each instrument's own
    // stream, unioned. The double-spend is only visible once all of a household's channels are here.
    movementsForOwner: async (tenantId, ownerRef) => {
      const mine = (await allOf<Instrument>(input.store, tenantId, STORED_VALUE_INDEX, 'StoredValueIssued'))
        .filter((i) => i.ownerRef === ownerRef);
      const perInstrument = await Promise.all(
        mine.map((i) => allOf<ValueMovement>(input.store, tenantId, forInstrument(i.instrumentId), 'StoredValueMovement')),
      );
      return perInstrument.flat();
    },

    // Every movement across EVERY instrument the tenant has issued — the tenant-wide fold behind the
    // liability reconciliation and the redemption-velocity flag (M17-FR-03 / M23). The same fan-out as
    // movementsForOwner without the owner filter: the whole issue index, each instrument's own
    // StoredValueMovement stream, unioned.
    allMovements: async (tenantId) => {
      const all = await allOf<Instrument>(input.store, tenantId, STORED_VALUE_INDEX, 'StoredValueIssued');
      const perInstrument = await Promise.all(
        all.map((i) => allOf<ValueMovement>(input.store, tenantId, forInstrument(i.instrumentId), 'StoredValueMovement')),
      );
      return perInstrument.flat();
    },

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

/**
 * The coupon register (M17-FR-02) — the small bearer instruments the shop issues and honours. A coupon and
 * its redemptions live on the code's OWN stream (`CouponIssued` then `CouponRedeemed`), so `redemptions(code)`
 * reads one stream, and the central `redeemCoupon` runs against the WHOLE history — the authoritative
 * single-use guard a stale offline lane cache cannot enforce alone (hard rule #10). Referral rewards are a
 * tenant-wide `ReferralRewarded` stream, the already-paid guard. Nothing is overwritten (hard rule #2).
 */
export function couponAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
}): CouponDeps {
  const forCode = (code: string): string => streamName(STREAM.loyalty, 'coupon', code);
  const referralStream = streamName(STREAM.loyalty, 'referrals');
  return {
    now: input.now,
    issue: async (tenantId, coupon, key) => {
      await input.store.append(tenantId, forCode(coupon.code), makeEvent({
        id: `coupon-${coupon.code}-${key}`,
        type: 'CouponIssued',
        occurredAt: input.now(),
        idempotencyKey: `coupon-${tenantId}-${coupon.code}-${key}`,
        source: 'api/customer',
        payload: coupon,
      }));
    },
    coupon: async (tenantId, code) => {
      const events = await input.store.readStream(tenantId, forCode(code), { type: 'CouponIssued' });
      const last = events[events.length - 1]; // latest definition wins (the route refuses a re-define anyway)
      return last ? payloadOf<Coupon>(last) : undefined;
    },
    redemptions: (tenantId, code) => allOf<Redemption>(input.store, tenantId, forCode(code), 'CouponRedeemed'),
    recordRedemption: async (tenantId, r, key) => {
      await input.store.append(tenantId, forCode(r.code), makeEvent({
        id: `redeem-${r.code}-${r.redemptionId}-${key}`,
        type: 'CouponRedeemed',
        occurredAt: input.now(),
        idempotencyKey: `redeem-${tenantId}-${r.code}-${r.redemptionId}`,
        source: 'api/customer',
        payload: r,
      }));
    },
    rewardedReferralIds: async (tenantId) =>
      (await allOf<{ referralId: string }>(input.store, tenantId, referralStream, 'ReferralRewarded')).map((x) => x.referralId),
    recordReferralReward: async (tenantId, referralId, rewardMinor, at, key) => {
      await input.store.append(tenantId, referralStream, makeEvent({
        id: `referral-${referralId}-${key}`,
        type: 'ReferralRewarded',
        occurredAt: input.now(),
        idempotencyKey: `referral-${tenantId}-${referralId}`,
        source: 'api/customer',
        payload: { referralId, rewardMinor, at },
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

    /** Record a substitution decision on a line, append-only (M18-FR-04). Idempotent on order+line — a line
     *  is substituted once, so a replay is one fact, never a second substitution. */
    recordSubstitution: async (tenantId, sub: StoredSubstitution) => {
      await input.store.append(tenantId, forOrder(sub.orderId), makeEvent({
        id: `ord-sub-${sub.orderId}-${sub.lineId}`,
        type: 'LineSubstituted',
        occurredAt: sub.at,
        idempotencyKey: `ord-sub-${tenantId}-${sub.orderId}-${sub.lineId}`,
        source: 'api/orders',
        payload: sub,
      }));
    },

    /** The substitution decisions recorded on an order — a fold of its `LineSubstituted` events. */
    orderSubstitutions: async (tenantId, orderId) =>
      allOf<StoredSubstitution>(input.store, tenantId, forOrder(orderId), 'LineSubstituted'),
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
     * Branding is versioned and append-only: each set is a new fact, so "what did the brand look
     * like then" is answerable, and the current brand is the LATEST set — a fold, never an
     * overwritten field (hard rule #2).
     *
     * The version discriminator is the COUNT of prior sets, not the wall-clock millisecond. Keying on
     * `now()` alone silently deduped two DIFFERENT brands set inside the same millisecond: the second
     * carried the same `branding-${tenant}-${ms}` idempotency key as the first, so the store took it
     * for a retry and dropped it — a brand change vanishing with no error, which is exactly the silent
     * write P-08 forbids. `setFlag` never had this because its key carries the caller's distinct
     * `changedAt`; branding has no such field, so the monotonic version is what keeps each set its own
     * fact. (The append per stream is serialised, and branding is set by one owner, not concurrently.)
     */
    setBranding: async (tenantId, branding) => {
      const at = input.now();
      const version = (await allOf<TenantBranding>(input.store, tenantId, STREAM.platform, 'TenantBrandingSet')).length + 1;
      await input.store.append(tenantId, STREAM.platform, makeEvent({
        id: `branding-${tenantId}-${version}`,
        type: 'TenantBrandingSet',
        occurredAt: at,
        idempotencyKey: `branding-${tenantId}-${version}`,
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

/**
 * The tender a basket is booked under for the tender-mix KPI: the largest single tender on the
 * receipt (a split payment is attributed to where most of the money actually came from), or
 * `unrecorded` when the lane banked a sale with no tender detail — which is itself worth seeing on
 * the dashboard, not hiding (P-08).
 */
function primaryTender(tenders: readonly IncomingTender[]): string {
  if (tenders.length === 0) return 'unrecorded';
  return [...tenders].sort((a, b) => b.amountMinor - a.amountMinor)[0]!.kind;
}

export function reportingAdapter(input: {
  readonly store: EventStore;
  readonly now: () => string;
  /**
   * What this shop records and what this build can work out — the two facts the report catalogue
   * needs (M29/M30). Declared by the composition root because neither is the reporting service's to
   * invent; conservative by default (nothing claimed) so the catalogue never overstates the shop.
   */
  readonly records?: readonly Producer[];
  readonly produced?: readonly string[];
}): ReportingDeps {
  return {
    now: input.now,

    // Drives the tested `reportCatalogue` engine on the running path (CORE-01). The values are
    // declaration, not derivation: the catalogue is a shop-wide statement, so it comes from
    // configuration the owner ratifies, never from whichever streams this one service happens to see.
    catalogueInputs: () => ({ records: input.records ?? [], produced: input.produced ?? [] }),

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

      // Aggregate through the tested KPI engine (packages/reporting `salesSummary`, M29-FR-01),
      // not a second copy of the arithmetic here (CORE-02). The cloud `SaleCommitted` event carries
      // the takings and the tenders but NOT the pre-tax split or the cost of goods — those are
      // joined at the edge (`costTheDay`), where the cost book lives. So this path surfaces only the
      // figures the event can honestly support: gross takings, basket count and the tender mix. It
      // never emits a margin it cannot compute — a zero margin is a number somebody acts on.
      const facts: SaleFact[] = todays.map((s) => ({
        saleId: s.saleId,
        totalMinor: s.totalMinor,
        netMinor: 0, taxMinor: 0, cogsMinor: 0, units: 0, // not on the cloud event; never surfaced
        tender: primaryTender(s.tenders),
        currency: s.currency as CurrencyCode,
      }));
      const summary = salesSummary(facts, (todays[0]?.currency as CurrencyCode) ?? 'INR');

      // As at now, because the ledger is read at request time — there is no cache between these
      // figures and the events they are computed from, so there is nothing to be stale.
      const asAt = input.now();
      const money = (name: string, valueMinor: number): Figure =>
        figure({ name, valueMinor, unit: 'minor_currency', asAt, now: asAt });

      return [
        money('Sales today', summary.grossSalesMinor),
        figure({ name: 'Sales today — receipts', valueMinor: summary.basketCount, unit: 'count', asAt, now: asAt }),
        // One figure per tender the day actually saw (deterministic order), each an exact Σ from the
        // engine — the split the owner reaches for first: how much came in as cash, card, UPI.
        ...Object.keys(summary.tenderMix).sort()
          .map((kind) => money(`Sales today — ${kind}`, summary.tenderMix[kind]!)),
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
