// The composition root — the one place the whole cloud API is assembled and started.
//
// Everything above this file is pure and injected; this is where the real database, the real
// signing key and the real socket arrive. Keeping that in one file is what makes every other file
// testable without any of them.
//
// The order it does things in is the deployment contract:
//
//   1. **Check the configuration.** If anything is missing, a placeholder, or too short to be a
//      secret, print every problem at once and **exit non-zero**. Nothing else runs. A service
//      that starts with a default signing key is a service running in production with one.
//   2. **Open the event store.** Before the surface, because the surface is built around it —
//      the thirteen services take their persistence as a port, and this is where the real one
//      is supplied (`adapters.ts`).
//   3. **Build the surface.** Thirteen services on one router. A route that breaks the kernel's
//      conventions fails here, at boot, not on the request that finds it.
//   4. **Listen**, and answer `/livez` and `/readyz` differently — a database it cannot reach
//      means take me out of rotation, not restart me.
//   5. **On SIGTERM, drain.** In-flight requests finish before the process goes.

import { Pool } from 'pg';
import { SqlEventStore } from '../../../packages/persistence/src/event-store';
import { SqlSnapshotStore, type SnapshotStore } from '../../../packages/persistence/src/snapshot';
import { SqlConfigVersionStore } from '../../../packages/persistence/src/config-store';
import { SqlNumberSeriesStore, type NumberSeriesStore } from '../../../packages/persistence/src/number-series-store';
import { pgClient, pgPoolClient } from '../../../packages/persistence/src/pg-client';
import { DurableTenantSettings } from '../../../packages/tenant/src/index';
import {
  buildRouter, loadConfig, startHttpServer, CLOUD_API_CONFIG, SqlIdempotencyStore, SqlAuditSink,
  structuredLogger, combineObservers, RequestMetrics, TokenBucketRateLimiter, BackoffAuthThrottle,
  type Route,
} from '../../kernel/src/index';
import { tenantAccessResolver, seedGenesisOwner } from './access';
import type { TargetKind } from '../../../packages/migration/src/trial';
import { catalogueRoutes, hmacSigner } from '../../catalogue/src/index';
import { labellingRoutes } from '../../catalogue/src/labelling';
import { masterDataRoutes } from '../../catalogue/src/master-data';
import { categoryPolicyRoutes } from '../../catalogue/src/category-policy';
import { productDuplicateRoutes } from '../../catalogue/src/product-duplicates';
import { productMasterRoutes } from '../../catalogue/src/product-master';
import { productMergeRoutes } from '../../catalogue/src/product-merge';
import { packHierarchyRoutes } from '../../catalogue/src/pack-hierarchy';
import { barcodeRoutes } from '../../catalogue/src/barcodes';
import { taxClassRoutes } from '../../catalogue/src/tax-classes';
import { cataloguePreviewRoutes } from '../../catalogue/src/catalogue-preview';
import { pricingRoutes } from '../../pricing/src/index';
import { priceListRoutes } from '../../pricing/src/price-list';
import { promotionCatalogueRoutes } from '../../pricing/src/promotion-catalogue';
import { priceIntegrityRoutes } from '../../pricing/src/price-integrity';
import { posRoutes } from '../../pos/src/index';
import { returnsRoutes } from '../../pos/src/returns';
import { cashRoutes } from '../../pos/src/cash';
import { supplierPortalRoutes } from '../../purchase/src/supplier-portal';
import { shiftRoutes } from '../../pos/src/shift';
import { lpCasesRoutes, lpRulesRoutes } from '../../pos/src/loss-prevention';
import { fraudSignalsRoutes } from '../../pos/src/fraud-signals';
import { storedValueRoutes } from '../../customer/src/stored-value';
import { couponRoutes } from '../../customer/src/coupons';
import { promotionRoutes } from '../../pricing/src/promotions';
import { settlementRoutes } from '../../finance/src/settlement';
import { b2bCreditRoutes } from '../../finance/src/b2b-credit';
import { b2bCollectionsRoutes } from '../../finance/src/b2b-collections';
import { b2bCommissionRoutes } from '../../finance/src/b2b-commission';
import { b2bDocumentsRoutes } from '../../finance/src/b2b-documents';
import { concessionRoutes } from '../../finance/src/concession';
import { scrapRoutes } from '../../finance/src/scrap';
import { refundExceptionsRoutes } from '../../finance/src/refund-exceptions';
import { eInvoiceRoutes } from '../../finance/src/e-invoice';
import { eInvoiceRegisterRoutes } from '../../finance/src/e-invoice-register';
import { eInvoiceSandboxRoutes } from '../../finance/src/e-invoice-sandbox';
import { eWayBillRoutes } from '../../finance/src/e-way-bill';
import { eWayBillRegisterRoutes } from '../../finance/src/e-way-bill-register';
import { gstPortalRoutes } from '../../finance/src/gst-portal';
import { payrollRoutes } from '../../finance/src/payroll';
import { payRunStoreRoutes } from '../../finance/src/pay-run-store';
import { workforceRoutes } from '../../finance/src/workforce';
import { gstr1SubmissionRoutes } from '../../finance/src/gstr1-submission-store';
import { gstReturnsRoutes } from '../../finance/src/gst-returns';
import { facilitiesRoutes } from '../../platform/src/facilities';
import { facilitiesAssetsRoutes } from '../../platform/src/facilities-assets';
import { facilitiesMonitoringRoutes } from '../../platform/src/facilities-monitoring';
import { weighingVerificationRoutes } from '../../platform/src/facilities-metrology';
import { complianceRoutes } from '../../compliance/src/index';
import { inventoryRoutes } from '../../inventory/src/index';
import { goodsReceiptRoutes } from '../../inventory/src/goods-receipt';
import { warehouseRoutes } from '../../inventory/src/warehouse';
import { transfersRoutes } from '../../inventory/src/warehouse-transfers';
import { replenishmentRoutes } from '../../inventory/src/replenishment';
import { salesHistoryRoutes } from '../../inventory/src/sales-history';
import { countsRoutes } from '../../inventory/src/counts';
import { productionRoutes } from '../../inventory/src/production';
import { packagingRoutes } from '../../inventory/src/packaging';
import { wasteRoutes } from '../../inventory/src/waste';
import { writeOffRoutes } from '../../inventory/src/write-off';
import { coldChainRoutes } from '../../inventory/src/cold-chain';
import { expiryRoutes } from '../../inventory/src/expiry';
import { lotTraceRoutes } from '../../inventory/src/lot-trace';
import { recallRoutes } from '../../inventory/src/recall';
import { RecallRegistry } from '../../../packages/traceability/src/index';
import { integrationRoutes } from '../../platform/src/integration';
import { webhookRoutes, webhookHasher } from '../../platform/src/webhooks';
import { connectorRoutes } from '../../platform/src/connectors';
import { identityRoutes, tokenAuthenticator } from '../../identity/src/index';
import { platformRoutes, inMemorySettings, emptyExportBundle } from '../../platform/src/index';
import { purchaseRoutes } from '../../purchase/src/index';
import { purchaseOrderRoutes } from '../../purchase/src/purchase-orders';
import { supplierScorecardRoutes } from '../../purchase/src/supplier-scorecard';
import { financeRoutes } from '../../finance/src/index';
import { creditNoteRoutes } from '../../finance/src/credit-notes';
import { taxRoutes } from '../../finance/src/tax';
import { retentionRoutes } from '../../finance/src/retention';
import { reportingRoutes } from '../../reporting/src/index';
import { ownerAlertsRoutes } from '../../reporting/src/owner-alerts';
import type { Producer } from '../../../packages/reporting/src/index';
import { customerRoutes } from '../../customer/src/index';
import { notificationGuardRoutes } from '../../customer/src/notification-guard';
import { backupVerificationRoutes } from '../../platform/src/backup-verification';
import { branchLifecycleRoutes } from '../../platform/src/branch-lifecycle';
import { documentsRoutes } from '../../platform/src/documents';
import { suspendedBillsRoutes } from '../../pos/src/suspended-bills';
import { restrictedSalesRoutes } from '../../pos/src/restricted-sales';
import { ordersRoutes } from '../../orders/src/index';
import { fulfilmentRoutes } from '../../fulfilment/src/index';
import { migrationRoutes } from '../../migration/src/index';
import { aiRoutes } from '../../ai/src/index';
import {
  catalogueAdapter, productMasterAdapter, productMergeAdapter, packHierarchyAdapter, barcodeAdapter, taxClassAdapter, cataloguePreviewAdapter, pricingAdapter, priceListAdapter, posAdapter, returnsAdapter, inventoryAdapter, goodsReceiptAdapter, warehouseAdapter, transfersAdapter, countsAdapter, writeOffAdapter, productionAdapter, packagingAdapter, wasteAdapter, purchaseAdapter, purchaseOrdersAdapter, supplierScorecardAdapter, financeAdapter, settlementAdapter,
  customerAdapter, ordersAdapter, fulfilmentAdapter, identityAdapter, platformAdapter,
  reportingAdapter, migrationAdapter, aiAdapter, storedValueAdapter, couponAdapter, promotionAdapter, promotionCatalogueAdapter, cashAdapter, shiftAdapter, lpCasesAdapter, lpRulesAdapter, fraudSignalsAdapter, b2bCreditAdapter, b2bCollectionsAdapter, b2bCommissionAdapter, b2bDocumentsAdapter, supplierPortalAdapter, concessionAdapter, scrapAdapter, facilitiesAdapter, facilitiesAssetsAdapter, facilitiesMonitoringAdapter, complianceAdapter, documentsAdapter, suspendedBillsAdapter, eInvoiceAdapter, eWayBillAdapter, payRunAdapter, gstr1SubmissionAdapter, gstReturnsAdapter, integrationAdapter, webhookAdapter, connectorAdapter, financeNotesAdapter, lotTraceAdapter, recallAdapter, salesHistoryAdapter,
} from './adapters';
import { ROLE_CATALOGUE, OWNER_ROLE_ID } from './roles';
import type { DependencyProbe } from '../../platform/src/index';
import type { EventStore } from '../../../packages/persistence/src/event-store';

const now = (): string => new Date().toISOString();

/**
 * The two facts the report catalogue (M29/M30) needs, declared in the composition root because
 * neither is a thing the reporting service may invent. Conservative on purpose: it names only what
 * this running build genuinely records and can work out today, so the owner's catalogue shows the
 * rest honestly as "not recorded yet" / "this version cannot produce it" rather than pretending.
 * These move to per-tenant configuration as the shop's recorded facts become tenant settings (M02).
 */
const REPORTING_RECORDS: readonly Producer[] = ['sales_rung_at_the_till'];
const REPORTING_PRODUCED: readonly string[] = ['sales_by_day'];

/**
 * How long a click-and-collect reservation holds stock.
 *
 * Named here rather than typed twice as `60`, because the stub path and the live path both need
 * it and two literals drift. It belongs in tenant settings (M02) once the config store is on this
 * surface — a shop with one van and a shop with six do not hold stock for the same hour.
 */
const HOLD_MINUTES = 60;

/**
 * Build the whole API surface.
 *
 * Exported so a test can assemble it exactly as production does — the surface gate in
 * `tests/integration/thirteen-apis-one-surface.test.ts` proves properties of *this* list, and it
 * would prove nothing about a list assembled differently here.
 */
export function buildSurface(deps: {
  readonly signingKey: string;
  readonly migrationTargetKind: TargetKind;
  /**
   * Reachability of what the shop cannot trade without. A real call every time it is asked, not a
   * flag something set earlier — a cached "reachable: true" is a health check that reports the
   * last time things were fine.
   */
  readonly probes?: () => Promise<readonly DependencyProbe[]>;
  /**
   * Where the events go. Omitted, the surface still assembles and answers — which is what the
   * route-shape tests need — but nothing persists. Supplying it is what turns the API from a
   * shell into a system, and `main()` always does.
   */
  readonly store?: EventStore;
  /** Durable per-tenant settings (a SqlConfigVersionStore-backed store in production). */
  readonly settings?: DurableTenantSettings;
  /** Durable gap-free number series (a SqlNumberSeriesStore-backed store in production). */
  readonly numberSeries?: NumberSeriesStore;
  /**
   * Where projection snapshots live (CORE-03). A `SqlSnapshotStore` in production, so bounded reads
   * survive a restart; omitted, adapters fall back to a process-local in-memory cache (still correct,
   * just rebuilt on a cold start, because a snapshot is disposable).
   */
  readonly snapshots?: SnapshotStore;
}): readonly Route[] {
  const signer = hmacSigner(deps.signingKey);
  const whHasher = webhookHasher(deps.signingKey);
  const empty = <T>(v: T) => () => v;
  const store = deps.store;

  const probes = deps.probes ?? (async () => []);

  return [
    ...identityRoutes(store === undefined ? {
      roles: empty([]), permissionsOf: empty([]), recordGrant: () => {},
      branches: empty([]), allocateNumber: () => Promise.resolve(1), now,
    } : identityAdapter({ store, now, roleCatalogue: ROLE_CATALOGUE, numberSeries: deps.numberSeries })),
    ...catalogueRoutes(store === undefined ? {
      signer, currentPack: empty(undefined), storePack: () => {},
      buildSnapshot: (tenantId) => ({ tenantId, version: 1, builtAt: now(), products: [], barcodes: [] }),
      approvalsSince: empty([]), now,
    } : catalogueAdapter({ store, signer, now })),
    // Unit sale price on the label (B3, Legal Metrology) — stateless, folds no ledger, so no deps/stub.
    ...labellingRoutes(),
    // Master-data commit guards (B2 dual-MRP) — stateless product-master validation.
    ...masterDataRoutes(),
    // Category-policy preview (category rules as effective-dated config) — stateless over @sre/product.
    ...categoryPolicyRoutes(),
    ...productDuplicateRoutes(),
    // Product-master authoring (M03-FR-01/03) — compliance-gated publish + read, event-sourced store.
    ...productMasterRoutes(store === undefined
      ? { publish: () => {}, product: empty(undefined), products: empty([]) }
      : productMasterAdapter({ store, now })),
    // Product merge (M03-FR-04 §28) — reversible, two-person duplicate resolution; propose/decide/reverse.
    ...productMergeRoutes(store === undefined
      ? { recordProposal: () => {}, recordApproved: () => {}, recordRejected: () => {}, recordReversed: () => {}, view: empty(undefined), all: empty([]), now }
      : productMergeAdapter({ store, now })),
    // Pack hierarchy + UOM conversion (M03-FR-02) — exact, reversible case↔unit; define/read/convert.
    ...packHierarchyRoutes(store === undefined
      ? { define: () => {}, pack: empty(undefined) }
      : packHierarchyAdapter({ store, now })),
    // Barcode register (M03-FR-02) — durable "one code, one item"; assign/lookup/list-per-product.
    ...barcodeRoutes(store === undefined
      ? { assign: () => {}, all: empty([]) }
      : barcodeAdapter({ store, now })),
    // Tax-class GST-rate schedule (M03-FR-03 / A6) — per-HSN effective-dated rate; set/resolve/list.
    ...taxClassRoutes(store === undefined
      ? { setRate: () => {}, schedule: empty([]) }
      : taxClassAdapter({ store, now })),
    // Catalogue pack ASSEMBLY/preview (slice 2) — fold master + prices + barcodes + tax rates for a store.
    ...cataloguePreviewRoutes(store === undefined
      ? { products: empty([]), priceEntries: empty([]), barcodes: empty([]), taxSchedule: empty([]), now }
      : cataloguePreviewAdapter({ store, now })),
    ...pricingRoutes(store === undefined
      ? { recordPriceChange: () => {}, canApprove: () => Promise.resolve(false), now }
      : pricingAdapter({ store, now })),
    ...priceListRoutes(store === undefined
      ? { entries: empty([]), recordEntry: () => {}, now }
      : priceListAdapter({ store, now })),
    ...promotionRoutes(store === undefined
      ? { launchedPromotion: empty(undefined), recordLaunch: () => {}, now }
      : promotionAdapter({ store, now })),
    ...promotionCatalogueRoutes(store === undefined
      ? { promotion: empty(undefined), promotions: empty([]), recordDefined: () => {}, recordStatus: () => {}, now }
      : promotionCatalogueAdapter({ store, now })),
    ...purchaseRoutes(store === undefined ? {
      matchLines: empty([]), recordCapture: () => {}, recordMatch: () => {}, applyBankChange: () => {},
      openCommitments: empty(undefined), now,
    } : purchaseAdapter({ store, now })),
    // Purchase-order lifecycle (M06-FR-01/02/04) — propose, approve+issue under §28, supplier holds.
    ...purchaseOrderRoutes(store === undefined ? {
      order: empty(undefined), all: empty([]), supplierBlocked: empty(false),
      propose: () => {}, issue: () => {}, setSupplierBlocked: () => {},
      amend: () => {}, cancel: () => {}, postReceipt: () => {}, now,
    } : purchaseOrdersAdapter({ store, now })),
    // Supplier scorecards + contract alerts (M06-FR-03) — objective scoring from recorded delivery facts.
    ...supplierScorecardRoutes(store === undefined ? {
      receipts: empty([]), contractsFor: empty([]), allContracts: empty([]),
      recordReceipt: () => {}, recordContract: () => {}, now,
    } : supplierScorecardAdapter({ store, now })),
    ...supplierPortalRoutes(store === undefined ? {
      partner: empty(undefined), submissions: empty([]), statementLines: empty([]), opening: empty(0),
      recordPartner: () => {}, recordSubmission: () => {}, recordStatementLine: () => {}, recordOpening: () => {}, now,
    } : supplierPortalAdapter({ store, now })),
    ...inventoryRoutes(store === undefined ? {
      availability: empty([]), appendMovement: () => {}, isKnown: empty(false), valuation: empty([]),
      ageing: empty({ lots: [], unvaluedMinor: 0 }),
      performance: empty({ from: '', to: '', periodDays: 0, total: { cogs: { minor: 0, currency: 'INR' }, averageInventory: { minor: 0, currency: 'INR' } }, byProduct: [] }), now,
    } : inventoryAdapter({ store, now })),
    // Goods receipt / GRN capture (M07-FR-01/02/03 · D03-FR-02) — the durable cloud receiving record.
    ...goodsReceiptRoutes(store === undefined
      ? { grn: empty(undefined), all: empty([]), commit: () => {}, now }
      : goodsReceiptAdapter({ store, now })),
    ...warehouseRoutes(store === undefined ? {
      bins: empty([]), contents: empty({}), appliedCommandIds: empty([]), recordBin: () => {}, recordMovement: () => {}, now,
    } : warehouseAdapter({ store, now })),
    ...transfersRoutes(store === undefined ? {
      transfer: empty(undefined), recordProposed: () => {}, recordDispatched: () => {}, recordReceived: () => {}, now,
    } : transfersAdapter({ store, now })),
    ...replenishmentRoutes(store === undefined ? { now } : { now, soldLines: salesHistoryAdapter({ store, now }).soldLines }),
    ...salesHistoryRoutes(store === undefined ? { soldLines: empty([]), now } : salesHistoryAdapter({ store, now })),
    ...countsRoutes(store === undefined ? {
      onHand: empty(0), reconciliations: empty([]), countExists: empty(false), recordReconciliation: () => {}, now,
    } : countsAdapter({ store, now })),
    ...writeOffRoutes(store === undefined ? {
      writeOffExists: empty(false), writeOffs: empty([]), recordWriteOff: () => {}, now,
    } : writeOffAdapter({ store, now })),
    ...productionRoutes(store === undefined ? {
      recipe: empty(undefined), recordRecipe: () => {}, ingredientCost: empty(undefined), recordCost: () => {},
      onHand: empty(0), priorConsumption: empty({}),
      runExists: empty(false), runs: empty([]), run: empty(undefined), recordRun: () => {}, recordRelease: () => {},
      enabledDepartments: empty([]), recordDepartmentEnabled: () => {}, now,
    } : productionAdapter({ store, now })),
    ...packagingRoutes(store === undefined ? {
      item: empty(undefined), movements: empty([]), registerItem: () => {}, recordMovement: () => {}, now,
    } : packagingAdapter({ store, now })),
    ...wasteRoutes(store === undefined ? {
      records: empty([]), coverage: empty({ expected: [], departmentNames: {} }), recordWaste: () => {}, recordCoverage: () => {}, now,
    } : wasteAdapter({ store, now })),
    ...integrationRoutes(store === undefined ? {
      matrix: empty([]), adapters: empty([]), heartbeats: empty([]),
      recordMatrixEntry: () => {}, recordAdapter: () => {}, recordHeartbeat: () => {}, now,
    } : integrationAdapter({ store, now })),
    ...webhookRoutes(store === undefined ? {
      config: empty(undefined), seenDeliveryIds: empty([]), recordConfig: () => {}, recordDelivery: () => {}, hasher: whHasher, now,
    } : webhookAdapter({ store, now, hasher: whHasher })),
    ...connectorRoutes(store === undefined ? {
      mapping: empty(undefined), recordMapping: () => {}, now,
    } : connectorAdapter({ store, now })),
    ...posRoutes(store === undefined ? {
      catalogue: empty(new Map()), currentPackVersion: empty(1),
      saleHoldingReceipt: empty(undefined), isBanked: empty(false),
      bankSale: () => {}, recordExceptions: () => {}, openExceptions: empty([]), now,
    } : posAdapter({ store, now })),
    ...returnsRoutes(store === undefined ? {
      originalSale: empty(undefined), priorReturns: empty([]), priorRefunds: empty([]),
      recordReturn: () => {}, now,
    } : returnsAdapter({ store, now })),
    ...cashRoutes(store === undefined
      ? { tillMovements: empty([]), recordCashMovement: () => {}, now }
      : cashAdapter({ store, now })),
    ...shiftRoutes(store === undefined
      ? { closedShift: empty(undefined), recordShiftClose: () => {}, overShortShifts: empty([]), now }
      : shiftAdapter({ store, now })),
    ...lpCasesRoutes(store === undefined
      ? { cases: empty([]), case: empty(undefined), recordOpened: () => {}, recordEvidence: () => {}, recordClosed: () => {}, now }
      : lpCasesAdapter({ store, now })),
    ...lpRulesRoutes(store === undefined
      ? { rules: empty([]), recordRule: () => {}, now }
      : lpRulesAdapter({ store, now })),
    ...fraudSignalsRoutes(store === undefined
      ? { thresholds: empty({}), recordThresholds: () => {}, bankHolders: empty([]), now }
      : fraudSignalsAdapter({ store, now })),
    ...customerRoutes(store === undefined ? {
      consentRecords: empty([]), appendConsent: () => {}, pointsBalance: empty(undefined),
      pointsMovements: empty([]), recordPointsMovement: () => {}, now,
    } : customerAdapter({ store, now })),
    ...storedValueRoutes(store === undefined ? {
      instrument: empty(undefined), movements: empty([]), recordIssue: () => {}, recordMovement: () => {},
      instrumentsForOwner: empty([]), movementsForOwner: empty([]), allMovements: empty([]), now,
    } : storedValueAdapter({ store, now })),
    // Coupons / personalised offers / referrals (M17-FR-02) — issue, redeem (authoritative single-use guard), read.
    ...couponRoutes(store === undefined ? {
      issue: () => {}, coupon: empty(undefined), redemptions: empty([]), recordRedemption: () => {},
      rewardedReferralIds: empty([]), recordReferralReward: () => {}, now,
    } : couponAdapter({ store, now })),
    ...ordersRoutes(store === undefined ? {
      onHand: empty(new Map()), outstanding: empty([]), holdReservations: () => {},
      holdMinutes: HOLD_MINUTES, now,
      recordPlaced: () => {}, orderState: empty(undefined), orderReservations: empty([]),
      recordTransition: () => {}, releaseReservations: () => {},
      recordSubstitution: () => {}, orderSubstitutions: empty([]),
    } : ordersAdapter({ store, now, holdMinutes: HOLD_MINUTES })),
    ...fulfilmentRoutes(store === undefined
      ? { appendAttempt: () => {}, attempts: empty([]), assigned: empty([]), now }
      : fulfilmentAdapter({ store, now })),
    ...financeRoutes(store === undefined ? {
      periodStates: empty(new Map()), nextOpenPeriod: empty(now().slice(0, 7)),
      appendJournal: () => {}, controlTotals: empty([]), postersIn: empty([]),
      markClosed: () => {}, now,
    } : financeAdapter({ store, now })),
    ...creditNoteRoutes(store === undefined ? {
      alreadyCredited: empty(0), appendCreditNote: () => {}, notes: empty([]), now,
    } : financeNotesAdapter({ store, now, ...(deps.snapshots === undefined ? {} : { snapshots: deps.snapshots }) })),
    // GST-from-inclusive-MRP calculator (A9/A8) — stateless, folds no ledger, so no deps/stub.
    ...taxRoutes(),
    // Statutory retention (A28) — stateless: longest statute wins + legal-hold-blocks-deletion.
    ...retentionRoutes(),
    ...settlementRoutes(store === undefined ? {
      importedBatchIds: empty([]), recordBatch: () => {}, credits: empty([]),
      electronicTenders: empty([]), investigations: empty([]),
      recordInvestigationOpened: () => {}, recordInvestigationEvidence: () => {}, recordInvestigationResolved: () => {}, now,
    } : settlementAdapter({ store, now })),
    ...b2bCreditRoutes(store === undefined ? {
      account: empty(undefined), outstandingMinor: empty(0), recordAccount: () => {}, recordReceivable: () => {}, now,
    } : b2bCreditAdapter({ store, now })),
    ...b2bCollectionsRoutes(store === undefined ? {
      invoices: empty([]), outstandingMinor: empty(0), recordInvoice: () => {}, recordPayment: () => {}, now,
    } : b2bCollectionsAdapter({ store, now })),
    ...b2bCommissionRoutes(store === undefined ? {
      accruals: empty([]), recordAccrual: () => {}, now,
    } : b2bCommissionAdapter({ store, now })),
    ...b2bDocumentsRoutes(store === undefined ? {
      document: empty(undefined), documents: empty([]), convertedQuotationIds: empty([]), recordDocument: () => {},
      allocateNumber: () => Promise.resolve(1), creditAllowed: empty(false), now,
    } : b2bDocumentsAdapter({ store, now, numberSeries: deps.numberSeries })),
    ...concessionRoutes(store === undefined ? {
      contract: empty(undefined), sales: empty([]), recordContract: () => {}, recordSale: () => {}, now,
    } : concessionAdapter({ store, now })),
    ...scrapRoutes(store === undefined ? {
      scrapSales: empty([]), recordScrapSale: () => {}, recordPosted: () => {}, now,
    } : scrapAdapter({ store, now })),
    ...facilitiesRoutes(store === undefined ? {
      schedules: empty([]), tasks: empty([]), recordSchedule: () => {}, recordTaskDue: () => {}, recordTaskCompleted: () => {},
      incidents: empty([]), recordIncident: () => {}, now,
    } : facilitiesAdapter({ store, now })),
    ...facilitiesAssetsRoutes(store === undefined ? {
      assets: empty([]), services: empty([]), downtime: empty([]), energyReadings: empty([]),
      recordAsset: () => {}, recordService: () => {}, recordDowntime: () => {}, recordEnergy: () => {}, now,
    } : facilitiesAssetsAdapter({ store, now })),
    ...facilitiesMonitoringRoutes(store === undefined ? {
      ranges: empty([]), readings: empty([]), contents: empty([]), powerEvents: empty([]),
      recordRange: () => {}, recordReading: () => {}, recordContents: () => {}, recordPowerEvent: () => {}, now,
    } : facilitiesMonitoringAdapter({ store, now })),
    // Verified-scale gate (B6, Legal Metrology) — stateless, folds no ledger, so no deps/stub.
    ...weighingVerificationRoutes(),
    // Owner alerts inbox (M29-FR-03) — control by exception; stateless grouping of the period's exceptions.
    ...ownerAlertsRoutes(),
    // Notification send guard (M31-FR-03) — consent/template/suppression/budget gate; stateless ruling.
    ...notificationGuardRoutes(),
    // Backup verification & restore reconciliation (M35-FR-01/02, P-04) — stateless recovery rulings.
    ...backupVerificationRoutes(),
    // Branch open/close lifecycle (M01-FR-04) — governed transition decision; stateless ruling.
    ...branchLifecycleRoutes(),
    // Versioned document templates (M31-FR-01/M36-FR-02) — append-only publish; a change is a new version.
    ...documentsRoutes(store === undefined ? {
      versions: empty([]), recordPublish: () => {}, issued: empty(undefined), recordIssued: () => {}, now,
    } : documentsAdapter({ store, now })),
    // Suspended (parked) bills (M15-FR-01/M12-FR-02) — park/resume/abandon; a recall is a claim, once.
    ...suspendedBillsRoutes(store === undefined ? {
      bills: empty([]), record: () => {}, now,
    } : suspendedBillsAdapter({ store, now })),
    // Restricted-sale gate (B14 / COTPA 2003) — the till's age-18 gate on tobacco and its refusal of a
    // loose single-stick quantity; a decision, not a write, so stateless and offline-safe.
    ...restrictedSalesRoutes(),
    // Refund exceptions & day totals (M14-FR-03/04) — stateless cash-office view of refunds that did not
    // go cleanly; the reversals live in settlement/POS, this is the reading.
    ...refundExceptionsRoutes(),
    // GST e-invoicing (A20) — eligibility / IRP-request build / apply-IRP-answer; stateless deterministic
    // core. The live IRP submission + IRN store is the next increment + a certified-GSP deployment adapter.
    ...eInvoiceRoutes(),
    // GST e-invoicing lifecycle store (A20 inc2) — durable submit → IRP response → cancel; the credentialed
    // GSP connector posts responses back here (that connector is the deployment step).
    ...eInvoiceRegisterRoutes(store === undefined ? {
      load: () => undefined, recordSubmit: () => {}, recordResponse: () => {}, recordCancel: () => {}, recordMismatch: () => {}, listInvoiceIds: () => [], now,
    } : eInvoiceAdapter({ store, now })),
    // GST e-invoicing sandbox GSP (A20) — a deterministic simulator on the same EInvoiceProvider port a real
    // certified GSP uses, so the submit → register → apply loop can be driven without live credentials. Its
    // IRN/QR are SANDBOX-marked and never valid for a real filing.
    ...eInvoiceSandboxRoutes(),
    // GST e-way bill (A23, Rule 138) — threshold eligibility (inter-State ₹50k / intra-TN ₹1L), validity by
    // distance, and a deterministic sandbox portal so the build → generate → apply loop runs without live
    // credentials; its EWB number is SANDBOX-derived and never valid to travel with real goods.
    ...eWayBillRoutes(),
    // GST e-way-bill DURABLE lifecycle store (A23, item 2) — submit → portal response → cancel per movement,
    // one stream each, so an e-way bill survives a restart; the transport twin of the e-invoice register.
    ...eWayBillRegisterRoutes(store === undefined ? {
      load: () => undefined, recordSubmit: () => {}, recordResponse: () => {}, recordCancel: () => {}, recordMismatch: () => {}, listMovementIds: () => [], now,
    } : eWayBillAdapter({ store, now })),
    // GST government-portal switch — the feature flag + kill switch keeping LIVE e-invoice/e-way-bill portal
    // calls OFF by default and killable; the gate a deployment consults before the real connector. Sandbox
    // routes are exempt.
    ...gstPortalRoutes(),
    // Payroll (priority 16) — statutory-deduction preview (PF/ESI/TN Professional Tax) on effective-dated
    // configurable rate tables; for review, commits nothing. Confidential — owner-gated.
    ...payrollRoutes(),
    // Workforce (M25-FR-01) — roster-gap detection: the named gaps in a proposed roster (per role per shift,
    // with the hour), plus the unstaffed-critical count. Stateless what-if over the tested engine, commits
    // nothing; the durable roster/attendance store is a later increment. Manager-gated (workforce.roster.read).
    ...workforceRoutes(),
    // Payroll pay-run DURABLE lifecycle store (WP3 inc9) — append draft→submit→approve→lock→reverse to the
    // append-only ledger (one stream per run) so a run survives a restart; maker ≠ checker enforced at the
    // write boundary. Confidential — owner-gated. The stateless /pay-run/evaluate route stays for previews.
    ...payRunStoreRoutes(store === undefined ? {
      load: () => undefined, append: () => {}, now,
    } : payRunAdapter({ store, now })),
    // GST returns write path (A5) — persist outward-supply tax lines; GSTR-1 Table 12 folds over them.
    ...gstReturnsRoutes(store === undefined ? {
      documents: empty([]), record: () => {}, soldTaxLines: empty([]), returnedTaxLines: empty([]), productTaxTable: empty([]), now,
    } : gstReturnsAdapter({ store, now })),
    // GST return DURABLE submission-safety store (WP4 inc2) — preview→approve→submit→acknowledge per filing
    // period (one stream each), maker ≠ checker + duplicate-prevention + digest-match at the write boundary.
    // The LIVE portal path stays off-by-default + killable; the deterministic sandbox runs otherwise.
    ...gstr1SubmissionRoutes(store === undefined ? {
      load: () => undefined, append: () => {}, listPeriods: () => [], now,
    } : gstr1SubmissionAdapter({ store, now })),
    // Price integrity across shelf/POS/app/ESL (D06/D14, ratified R2 B25) — stateless audit; the till is
    // the reference and a shelf underpricing it is ranked first as a legal exposure.
    ...priceIntegrityRoutes(),
    // Cold-chain assessment (M10-FR-02) — stateless verdict on a perishable batch; no second temperature
    // store (facilities-monitoring owns that truth, P-02), so no deps/stub.
    ...coldChainRoutes(),
    ...expiryRoutes(),
    // One-up/one-down lot traceability export (B11 / M10-FR-03) — the reconciled supplier→store→recipient
    // trace a recall runs on. The OUTBOUND (who bought it) folds the real banked sales by batch (batch-on-sale
    // inc3a); inbound receipts stay caller-supplied for now.
    ...lotTraceRoutes(store === undefined ? { soldOfBatch: () => [] } : lotTraceAdapter({ store })),
    // Recall lifecycle (M10-FR-04) — durable cloud recall record: initiate + close-with-evidence + read.
    ...recallRoutes(store === undefined
      ? { registry: () => new RecallRegistry(), records: empty([]), recordInitiated: () => {}, recordClosed: () => {}, now }
      : recallAdapter({ store, now })),
    // Compliance obligation register (M34-FR-03; subsumes B7 scale-cert + B10 FSSAI-licence alerts).
    ...complianceRoutes(store === undefined ? {
      obligations: empty([]), recordRegister: () => {}, now,
    } : complianceAdapter({ store, now })),
    ...reportingRoutes(store === undefined
      ? { figures: empty([]), now }
      : reportingAdapter({ store, now, records: REPORTING_RECORDS, produced: REPORTING_PRODUCED })),
    ...platformRoutes(store === undefined ? {
      probe: probes, flags: empty({}), setFlag: () => {}, recordSupportAccess: () => {},
      settings: inMemorySettings(), exportTenant: emptyExportBundle,
      setBranding: () => {}, branding: empty(undefined),
      setEntitlement: () => {}, entitlements: empty([]), now,
    } : platformAdapter({ store, now, probes, settings: deps.settings ?? inMemorySettings() })),
    ...migrationRoutes(store === undefined ? {
      target: (tenantId) => ({
        targetId: `tgt-${tenantId}`, tenantId,
        kind: deps.migrationTargetKind, label: deps.migrationTargetKind,
      }),
      // Not `'u-owner'` and `'u-operator'`. A control that compares a caller against a
      // placeholder is satisfied by anybody who types the placeholder.
      findings: empty([]), acceptances: empty([]), signatures: empty([]),
      recordAcceptance: () => {}, ownerId: empty(undefined),
      extractionOperator: empty(undefined), now,
    } : migrationAdapter({
      store, now, targetKind: deps.migrationTargetKind, ownerRoleId: OWNER_ROLE_ID,
    })),
    ...aiRoutes(store === undefined ? {
      // Stopped by default, matching the adapter. A kill switch that defaults off is an agent
      // running because nobody has told it not to.
      killSwitchOn: empty(true), setKillSwitch: () => {},
      budget: empty({ capMinor: 0, spentMinor: 0, periodEnds: now() }),
      enabledAgents: empty([]), run: empty([]), openProposals: empty([]), now,
    } : aiAdapter({ store, now })),
  ];
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  // 1 — Configuration. Every problem at once, then stop.
  const config = loadConfig(CLOUD_API_CONFIG, env);
  if (!config.ok) {
    process.stderr.write(`\n${config.detail}\n\n`);
    process.exitCode = 78; // EX_CONFIG — a configuration fault, not a crash
    return;
  }
  const settings = config.value!;

  // 2 — Persistence, before the surface, because the surface is built around it.
  //
  // A connection POOL, not a single client. A single `pg.Client` serialised every query across all
  // thirteen APIs over one TCP connection, and a dropped connection disabled all persistence — a
  // throughput ceiling and a single point of failure (audit GAP-DATA-09). The `pgClient` adapter was
  // written for a `Pool` from the start (see its header); this is the wire it was waiting for. `max`
  // bounds concurrent connections for a single-store deployment; the pool reconnects a dropped member
  // transparently, so a brief DB blip no longer takes the process down with it.
  const db = new Pool({ connectionString: settings['DATABASE_URL']!, max: 10 });
  // Fail fast at boot if the database is unreachable — the same eager check the single client made,
  // now issued through the pool (which connects lazily otherwise).
  await db.query('SELECT 1');
  // The event store gets the TRANSACTIONAL adapter (`pgPoolClient`), so a money-critical command
  // that writes more than one event — a banked sale plus its receipt index, a return plus its
  // reporting projection — commits all of them or none, even across a crash (audit FND-01). The
  // other stores stay on the plain query adapter; they do single writes and need no transaction.
  const store = new SqlEventStore(pgPoolClient(db));

  // 2b — Genesis owner (optional bootstrap). Because granting a role itself needs a role
  // (maker-checker), a brand-new tenant has nobody who can grant the first one. Where the initial
  // owner is configured, establish them once — idempotent, a no-op if the tenant already has any
  // grant. The owner's identity is an owner input supplied by configuration, not decided here.
  const genesisTenant = settings['BOOTSTRAP_OWNER_TENANT_ID'];
  const genesisOwner = settings['BOOTSTRAP_OWNER_USER_ID'];
  if (genesisTenant !== undefined && genesisOwner !== undefined) {
    const outcome = await seedGenesisOwner(store, OWNER_ROLE_ID, genesisTenant, genesisOwner, new Date().toISOString());
    process.stdout.write(`genesis owner for tenant ${genesisTenant}: ${outcome}\n`);
  }

  // 3 — The surface. A route that breaks a convention fails here, not on the request that finds it.
  //
  // Built exactly once. The first version of this built it twice — once to check the shape at boot
  // and again with the store behind it — and then served `live.router!` without checking `live.ok`.
  // Two surfaces that are asserted to be identical is one surface and one assumption, and the
  // assumption is the one holding the non-null.
  const reachable = async (): Promise<boolean> => {
    try { await db.query('SELECT 1'); return true; } catch { return false; }
  };

  const built = buildRouter(buildSurface({
    signingKey: settings['PACK_SIGNING_KEY']!,
    migrationTargetKind: settings['MIGRATION_TARGET_KIND'] as TargetKind,
    store,
    // Durable, append-only per-tenant settings: setup answers land in config_versions and survive a
    // restart, the same table and rules the in-memory path uses in tests.
    settings: new DurableTenantSettings(new SqlConfigVersionStore(pgClient(db))),
    numberSeries: new SqlNumberSeriesStore(pgClient(db)),
    // Durable projection snapshots (CORE-03): bounded reads resume from the last persisted fold
    // across a restart, rather than re-folding the whole ledger on a cold start.
    snapshots: new SqlSnapshotStore(pgClient(db)),
    probes: async () => [{
      name: 'postgres',
      criticality: 'shop_cannot_trade_without_it',
      reachable: await reachable(),
    }],
  }));
  if (!built.ok) {
    process.stderr.write(`\nthe API surface is malformed and this service will not start:\n${
      built.refusals.map((r) => `  • ${r.detail}`).join('\n')}\n\n`);
    await db.end();
    process.exitCode = 78;
    return;
  }

  // Observability: one structured JSON line per request to stdout, and in-memory request metrics
  // served at /metricz. Provider-neutral (P-06) — a real log shipper or metrics/OTel exporter is a
  // change to these two lines, not to any handler.
  const metrics = new RequestMetrics();
  const observe = combineObservers(
    structuredLogger((line) => process.stdout.write(`${line}\n`)),
    metrics.record,
  );

  const server = startHttpServer({
    router: built.router!,
    observe,
    metricsSnapshot: () => metrics.snapshot(),

    // Tokens are verified against the identity provider's key, and the reason a token was not
    // believed goes to the operator's log — never back to the caller, who is told "unauthenticated"
    // and no more. "The signature did not verify" and "that token expired" are different sentences,
    // and the difference is free information for whoever is trying tokens.
    authenticate: tokenAuthenticator(
      {
        secret: settings['IDP_SIGNING_KEY']!,
        issuer: settings['IDP_ISSUER']!,
        audience: settings['IDP_AUDIENCE']!,
      },
      (reason) => { process.stderr.write(`auth refused: ${reason}\n`); },
    ),
    // Real, per-tenant authorization. Was `new AccessControl([], [])` — a global, empty table that
    // authorised NOTHING and, worse, was never rebuilt from anyone's grants, so the whole least-
    // privilege apparatus was inert on the live surface. Now every request resolves the caller's
    // authority from THEIR tenant's own `RoleGranted` history in the ledger. Default-deny survives:
    // a tenant with no grants still authorises nothing — but now for the right reason, and a
    // provisioned tenant's owner and staff can actually act.
    access: tenantAccessResolver(store, ROLE_CATALOGUE),
    // Durable and shared. In memory it emptied on every restart and was never shared between
    // instances, so the guard that refuses a different request under a used key was quietly not
    // there — which is not a crash, and would never have shown up in a test.
    idempotency: new SqlIdempotencyStore(pgClient(db)),

    // The audit trail. Optional in the kernel's type and NOT optional in a deployment: the port
    // existed, nothing supplied it, and `writeAudit` returned immediately on every request — so
    // hard rule #6 was protecting evidence that was never being kept. The TRANSACTIONAL adapter
    // (`pgPoolClient`, audit FND-01) lets each write seal itself onto the previous one under a
    // per-tenant lock, so the SHA-256 chain (audit FND-02) cannot fork.
    audit: new SqlAuditSink(pgPoolClient(db), (detail) => { process.stderr.write(`${detail}\n`); }),

    // Rate limiting and auth-attempt lockout (audit FND-03 / GAP-SEC-04). The API had exactly one
    // 429 in the whole product (the AI budget gate); nothing capped request volume and nothing slowed
    // a script guessing tokens against the sign-in path. A per-source flood limit and a per-tenant
    // fair-share limit (token buckets), plus an exponential-backoff lockout after repeated failed
    // sign-ins. IN-MEMORY reference — correct for the single-store box and a single API instance; a
    // multi-instance cloud swaps these ports for a shared Redis-backed limiter (technology baseline)
    // so the limit is global, the same in-memory-reference / deployment-adapter split as idempotency.
    // A busy till bursts, so the capacity is generous and the sustained rate comfortably above normal
    // per-tenant traffic; the auth lockout is deliberately strict.
    rateLimit: new TokenBucketRateLimiter({ capacity: 240, refillPerSecond: 20 }),
    authThrottle: new BackoffAuthThrottle({ threshold: 5, baseCooldownSeconds: 5, maxCooldownSeconds: 900 }),
    newTraceId: () => `t-${Math.random().toString(36).slice(2, 10)}`,
    port: Number(settings['PORT']),
    dependenciesReachable: reachable,
  });

  process.stdout.write(`sre-api listening on ${settings['PORT']}, ${built.router!.list().length} routes\n`);

  // 5 — Drain on SIGTERM. Killing in-flight work is a sale that reached the process and not the
  // database, while the till believes it was delivered.
  const shutdown = (signal: string) => {
    void (async () => {
      process.stdout.write(`${signal}: draining\n`);
      await server.stop();
      await db.end();
      process.stdout.write('stopped cleanly\n');
    })();
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}
